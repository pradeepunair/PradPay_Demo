import { readFile } from "node:fs/promises";

import { runOneSandboxSPTPayment } from "../lib/sandbox/stripe-spt-payment.mjs";

try {
  const receipt = JSON.parse(await readFile(process.env.PAYMENTLAB_A2A_RECEIPT_PATH, "utf8"));
  const result = await runOneSandboxSPTPayment({
    apiKey: process.env.STRIPE_SECRET_KEY,
    accountId: process.env.PAYMENTLAB_STRIPE_ACCOUNT_ID,
    receipt,
    approval: process.env.PAYMENTLAB_STRIPE_SANDBOX_APPROVAL,
    attemptPath: process.env.PAYMENTLAB_STRIPE_ATTEMPT_PATH,
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.paymentStatus !== "succeeded") process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ outcome: "stopped", code: error?.code ?? "SANDBOX_PAYMENT_FAILED" }));
  process.exitCode = 1;
}
