import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const ACP_VERSION = "2026-04-17";
export const ACP_COMMIT = "7fdd78df677a94dce04c770644b0fbbb1401272b";
export const ACP_UPSTREAM = "https://github.com/agentic-commerce-protocol/agentic-commerce-protocol";
export const ACP_CHECKOUT_OPERATIONS = Object.freeze([
  "POST /checkout_sessions",
  "GET /checkout_sessions/{checkout_session_id}",
  "POST /checkout_sessions/{checkout_session_id}",
  "POST /checkout_sessions/{checkout_session_id}/complete",
  "POST /checkout_sessions/{checkout_session_id}/cancel",
]);

const EXPECTED_ARTIFACTS = Object.freeze({
  "spec/2026-04-17/openapi/openapi.agentic_checkout.yaml": "2a0aa239b4aed50732461d9b7e443ad98d5c2d3431277899433ead07cbd4fc55",
  "spec/2026-04-17/openapi/openapi.delegate_payment.yaml": "ffc98ff3b7a69dd2be5feffe3d91eaf0a687aab31b3fb55b4db63a4e06b4815a",
  "spec/2026-04-17/json-schema/schema.agentic_checkout.json": "d0e4290617d66bf05d002b8ace388732be2b3eb9a92a1003db7a2daa1e0436f2",
  "spec/2026-04-17/json-schema/schema.delegate_payment.json": "307739ae400e7368eaa25c6024d30751348a4af8a516d071565fcd8aa328cf4d",
  LICENSE: "4458503dd48e88c4e0b945fb252a08b93c40ec757309b8ffa7c594dfa1e35104",
  NOTICE: "eef2479db11ee280bbade20296fe6c2ecdc8ce64a8cd086d57b80571d675a290",
});

export async function assertPinnedAcpArtifacts({ root, manifest }) {
  if (manifest.version !== ACP_VERSION || manifest.commit !== ACP_COMMIT || manifest.upstream !== ACP_UPSTREAM) throw new Error("ACP manifest version, commit, and upstream must match the approved pin");
  const declared = Object.fromEntries(manifest.artifacts.map((artifact) => [artifact.path, artifact.sha256]));
  if (JSON.stringify(declared) !== JSON.stringify(EXPECTED_ARTIFACTS)) throw new Error("ACP manifest artifact set must match the complete approved pin");
  const results = [];
  for (const [artifactPath, expected] of Object.entries(EXPECTED_ARTIFACTS)) {
    const bytes = await readFile(path.join(root, "protocol", "acp", "upstream", artifactPath));
    const actual = createHash("sha256").update(bytes).digest("hex");
    results.push({ path: artifactPath, expected, actual, valid: actual === expected });
  }
  const invalid = results.filter((result) => !result.valid);
  if (invalid.length) throw new Error(`ACP artifact hash mismatch: ${invalid.map((item) => item.path).join(", ")}`);
  return results;
}

function nonEmptyString(value) { return typeof value === "string" && value.length > 0; }
export function validateCheckoutCapability(payload) {
  if (payload?.protocol?.version !== ACP_VERSION) throw new Error(`Checkout capability must use pinned ACP version ${ACP_VERSION}`);
  const handlers = payload?.capabilities?.payment?.handlers;
  if (!Array.isArray(handlers) || handlers.length === 0) throw new Error("Checkout capability requires at least one explicit payment handler");
  for (const handler of handlers) {
    for (const field of ["id", "name", "version", "spec", "psp", "config_schema"]) if (!nonEmptyString(handler?.[field])) throw new Error(`Missing or invalid required payment handler field: ${field}`);
    for (const field of ["requires_delegate_payment", "requires_pci_compliance"]) if (typeof handler[field] !== "boolean") throw new Error(`Missing or invalid required payment handler field: ${field}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(handler.version)) throw new Error("Payment handler version must be a date revision");
    if (!Array.isArray(handler.instrument_schemas) || !handler.instrument_schemas.every(nonEmptyString)) throw new Error("Missing or invalid required payment handler field: instrument_schemas");
    if (!handler.config || typeof handler.config !== "object" || Array.isArray(handler.config)) throw new Error("Missing or invalid required payment handler field: config");
  }
  return payload;
}
