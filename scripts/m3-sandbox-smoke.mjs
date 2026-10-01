#!/usr/bin/env node
import { runSyntheticSandboxSmoke } from "../lib/sandbox/synthetic-smoke.mjs";

const keys = [
  "PAYMENTLAB_ENVIRONMENT",
  "PAYMENTLAB_DATABASE_MODE",
  "PAYMENTLAB_CALLBACK_MODE",
  "PAYMENTLAB_WORKER_MODE",
];
const env = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

try {
  const result = await runSyntheticSandboxSmoke({ env });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status !== "PASS") process.exitCode = 1;
} catch (error) {
  process.stderr.write(`Sandbox smoke blocked: ${error?.code ?? "INVALID_CONFIGURATION"}\n`);
  process.exitCode = 1;
}
