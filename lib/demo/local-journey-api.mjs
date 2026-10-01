import { createLocalJourney, JourneyError, localJourneyConfiguration } from "./local-journey.mjs";
import { getDurableLocalJourney } from "./durable-local-journey.mjs";

const COOKIE = "paymentlab_local_demo";
const headers = { "Cache-Control": "no-store", "Content-Type": "application/json" };
const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body),
  { status, headers: { ...headers, ...extra } });

function requestOrigin(request, env) {
  try {
    const url = new URL(request.url);
    const host = request.headers.get("host") ?? "";
    const browserUrl = new URL(`${url.protocol}//${host}`);
    const loopback = ["localhost", "127.0.0.1", "[::1]"];
    if (!localJourneyConfiguration(env) || !["http:", "https:"].includes(url.protocol)
      || !loopback.includes(url.hostname) || !loopback.includes(browserUrl.hostname)
      || browserUrl.host !== host) return null;
    return browserUrl.origin;
  } catch { return null; }
}

function token(request) {
  const entry = (request.headers.get("cookie") ?? "").split(";").map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE}=`));
  return entry?.slice(COOKIE.length + 1) ?? "";
}

function failure(error) {
  return error instanceof JourneyError ? json({ code: error.code }, error.status)
    : json({ code: "LOCAL_DEMO_UNAVAILABLE" }, 503);
}

export function createLocalJourneyHandlers({ env = process.env,
  service = localJourneyConfiguration(env)
    ? (env.PAYMENTLAB_LOCAL_DEMO_STORE === "postgres" ? getDurableLocalJourney(env) : createLocalJourney({ env }))
    : null } = {}) {
  const gated = (request, mutate = false) => {
    const origin = requestOrigin(request, env);
    if (!origin || !service) return json({ code: "LOCAL_DEMO_DISABLED" }, 503);
    if (mutate && request.headers.get("origin") !== origin) {
      return json({ code: "ORIGIN_DENIED" }, 403);
    }
    return null;
  };
  return {
    async start(request) {
      const denied = gated(request, true); if (denied) return denied;
      try {
        const { token: freshToken, snapshot } = await service.start();
        const maxAge = env.PAYMENTLAB_LOCAL_DEMO_STORE === "postgres" ? 86400 : 3600;
        return json(snapshot, 201, { "Set-Cookie": `${COOKIE}=${freshToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}` });
      } catch (error) { return failure(error); }
    },
    async read(request, id) {
      const denied = gated(request); if (denied) return denied;
      try { return json(await service.read(id, token(request))); }
      catch (error) { return failure(error); }
    },
    async approve(request, id) {
      const denied = gated(request, true); if (denied) return denied;
      if (!(request.headers.get("content-type") ?? "").startsWith("application/json")) {
        return json({ code: "INVALID_REQUEST" }, 415);
      }
      try {
        const raw = await request.text();
        if (raw.length > 512) return json({ code: "INVALID_REQUEST" }, 413);
        const body = JSON.parse(raw);
        if (!body || typeof body !== "object" || Array.isArray(body)
          || Object.keys(body).sort().join(",") !== "quoteId,totalMinor") {
          return json({ code: "INVALID_REQUEST" }, 400);
        }
        return json(await service.approve(id, token(request), body));
      } catch (error) {
        if (error instanceof SyntaxError) return json({ code: "INVALID_REQUEST" }, 400);
        return failure(error);
      }
    },
    async pay(request, id) {
      const denied = gated(request, true); if (denied) return denied;
      try { return json(await service.pay(id, token(request), env.STRIPE_SECRET_KEY)); }
      catch (error) { return failure(error); }
    },
    async reconcile(request, id) {
      const denied = gated(request, true); if (denied) return denied;
      try { return json(await service.reconcile(id, token(request), env.STRIPE_SECRET_KEY)); }
      catch (error) { return failure(error); }
    },
    async webhook(request) {
      const denied = gated(request); if (denied) return denied;
      if (env.PAYMENTLAB_LOCAL_WEBHOOK_ENABLE !== "1"
        || typeof env.STRIPE_WEBHOOK_SECRET !== "string"
        || !env.STRIPE_WEBHOOK_SECRET.startsWith("whsec_")) {
        return json({ code: "WEBHOOK_NOT_CONFIGURED" }, 503);
      }
      const length = Number(request.headers.get("content-length"));
      if (Number.isFinite(length) && length > 65536) return json({ code: "WEBHOOK_TOO_LARGE" }, 413);
      try {
        const rawBody = Buffer.from(await request.arrayBuffer());
        if (rawBody.length > 65536) return json({ code: "WEBHOOK_TOO_LARGE" }, 413);
        return json(await service.receiveWebhook({ rawBody,
          signature: request.headers.get("stripe-signature"),
          endpointSecret: env.STRIPE_WEBHOOK_SECRET }));
      } catch (error) { return failure(error); }
    },
  };
}
