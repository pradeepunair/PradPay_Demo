import { createOwnedRunService, RunRequestError, SESSION_COOKIE } from "../application/owned-runs.mjs";
import { createPostgresPersistence } from "../persistence/postgres.mjs";

let servicePromise;

function localConfiguration(env) {
  if (env.PAYMENTLAB_RUN_API_MODE !== "local" || env.PAYMENTLAB_ENVIRONMENT !== "local"
    || env.PAYMENTLAB_DATABASE_MODE !== "local") return null;
  try {
    const url = new URL(env.DATABASE_URL);
    if (!["postgres:", "postgresql:"].includes(url.protocol)
      || !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) return null;
    return env.DATABASE_URL;
  } catch { return null; }
}

export async function getLocalRunService(env = process.env) {
  const connectionString = localConfiguration(env);
  if (!connectionString) return null;
  if (!servicePromise) {
    servicePromise = (async () => {
      const { Pool } = await import("pg");
      const pool = new Pool({ connectionString, max: 4, idleTimeoutMillis: 10_000 });
      pool.on("error", () => {}); // Idle failures are handled on the next request; never log DSNs.
      return createOwnedRunService({ persistence: createPostgresPersistence(pool) });
    })().catch((error) => { servicePromise = undefined; throw error; });
  }
  return servicePromise;
}

const noStore = { "Cache-Control": "no-store", "Content-Type": "application/json" };
function result(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...noStore, ...extra } });
}
function errorResult(error) {
  if (error instanceof RunRequestError) return result({ code: error.code }, error.status);
  return result({ code: "SERVICE_UNAVAILABLE" }, 503);
}
function cookieToken(request) {
  const entry = (request.headers.get("cookie") ?? "").split(";").map((value) => value.trim())
    .find((value) => value.startsWith(`${SESSION_COOKIE}=`));
  return entry?.slice(SESSION_COOKIE.length + 1) ?? "";
}
function sameOrigin(request) {
  try { return request.headers.get("origin") === new URL(request.url).origin; }
  catch { return false; }
}
function localRequest(request) {
  try { return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(request.url).hostname); }
  catch { return false; }
}

export function createLocalRunHandlers({ getService = getLocalRunService } = {}) {
  async function serviceFor(request) {
    if (!localRequest(request)) return null;
    return getService();
  }
  return Object.freeze({
    async createSession(request) {
      if (!sameOrigin(request)) return result({ code: "ORIGIN_DENIED" }, 403);
      try {
        const service = await serviceFor(request);
        if (!service) return result({ code: "RUN_API_DISABLED" }, 503);
        const { token, expiresAt, maxAge } = await service.createSession({ token: cookieToken(request) });
        const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
        return result({ expiresAt }, token ? 201 : 200, token ? {
          "Set-Cookie": `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`,
        } : {});
      } catch (error) { return errorResult(error); }
    },
    async createRun(request) {
      if (!sameOrigin(request)) return result({ code: "ORIGIN_DENIED" }, 403);
      if (!(request.headers.get("content-type") ?? "").startsWith("application/json")) return result({ code: "INVALID_REQUEST" }, 415);
      try {
        const service = await serviceFor(request);
        if (!service) return result({ code: "RUN_API_DISABLED" }, 503);
        const bodyText = await request.text();
        if (bodyText.length > 2048) return result({ code: "INVALID_REQUEST" }, 413);
        const body = JSON.parse(bodyText);
        if (!body || typeof body !== "object" || Array.isArray(body)
          || Object.keys(body).length !== 1 || !Object.hasOwn(body, "mission")) {
          return result({ code: "INVALID_REQUEST" }, 400);
        }
        const created = await service.createRun({
          token: cookieToken(request), idempotencyKey: request.headers.get("idempotency-key"), mission: body.mission,
        });
        return result(created, created.replay ? 200 : 201);
      } catch (error) {
        if (error instanceof SyntaxError) return result({ code: "INVALID_REQUEST" }, 400);
        return errorResult(error);
      }
    },
    async readRun(request, runId) {
      try {
        const service = await serviceFor(request);
        if (!service) return result({ code: "RUN_API_DISABLED" }, 503);
        const raw = new URL(request.url).searchParams.get("after") ?? "0";
        if (!/^(0|[1-9][0-9]{0,14})$/.test(raw)) return result({ code: "INVALID_CURSOR" }, 400);
        const snapshot = await service.readRun({ token: cookieToken(request), runId, afterSequence: Number(raw) });
        return result(snapshot);
      } catch (error) { return errorResult(error); }
    },
  });
}
