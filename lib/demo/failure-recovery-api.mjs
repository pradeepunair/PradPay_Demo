import { getFailureRecoveryDemo } from "./failure-recovery.mjs";
import { JourneyError } from "./local-journey.mjs";

const COOKIE = "paymentlab_failure_recovery";
const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), {
  status, headers: { "Cache-Control": "no-store", "Content-Type": "application/json", ...extra },
});
const token = (request) => (request.headers.get("cookie") ?? "").split(";").map((piece) => piece.trim())
  .find((piece) => piece.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) ?? "";

function localOrigin(request) {
  try {
    const url = new URL(request.url);
    const host = request.headers.get("host");
    const expected = new URL(`${url.protocol}//${host}`);
    if (!["http:", "https:"].includes(url.protocol)
      || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      || !["localhost", "127.0.0.1", "[::1]"].includes(expected.hostname)
      || expected.host !== host) return null;
    return expected.origin;
  } catch { return null; }
}

export function createFailureRecoveryHandlers({ env = process.env, service = getFailureRecoveryDemo(env) } = {}) {
  const gate = (request, mutation) => {
    const origin = localOrigin(request);
    if (!origin || !service) return json({ code: "LOCAL_DEMO_DISABLED" }, 503);
    if (mutation && request.headers.get("origin") !== origin) return json({ code: "ORIGIN_DENIED" }, 403);
    return null;
  };
  const failure = (error) => error instanceof JourneyError
    ? json({ code: error.code }, error.status) : json({ code: "SCENARIO_UNAVAILABLE" }, 503);
  return {
    async start(request) {
      const denied = gate(request, true); if (denied) return denied;
      if (!(request.headers.get("content-type") ?? "").startsWith("application/json")) return json({ code: "INVALID_REQUEST" }, 415);
      try {
        const raw = await request.text();
        if (raw.length > 128) return json({ code: "INVALID_REQUEST" }, 413);
        const body = JSON.parse(raw);
        if (!body || typeof body !== "object" || Array.isArray(body)
          || Object.keys(body).join(",") !== "scenario") return json({ code: "INVALID_REQUEST" }, 400);
        const { token: fresh, snapshot } = await service.start(body.scenario);
        return json(snapshot, 201, { "Set-Cookie": `${COOKIE}=${fresh}; HttpOnly; SameSite=Strict; Path=/api/local-demo/failure-recovery; Max-Age=86400` });
      } catch (error) { return error instanceof SyntaxError ? json({ code: "INVALID_REQUEST" }, 400) : failure(error); }
    },
    async read(request, id) {
      const denied = gate(request, false); if (denied) return denied;
      try { return json(await service.read(id, token(request))); } catch (error) { return failure(error); }
    },
    async advance(request, id) {
      const denied = gate(request, true); if (denied) return denied;
      try { return json(await service.advance(id, token(request))); } catch (error) { return failure(error); }
    },
  };
}
