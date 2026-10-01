import { runLocalA2A } from "../lib/demo/local-a2a.mjs";

try {
  const receipt = await runLocalA2A();
  console.log(JSON.stringify({ ...receipt, budget: null }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ outcome: "stopped", code: error?.code ?? "LOCAL_A2A_UNAVAILABLE",
    paymentCalls: 0 }));
  process.exitCode = 1;
}
