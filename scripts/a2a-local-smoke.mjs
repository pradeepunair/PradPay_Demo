import { randomUUID } from "node:crypto";

import { ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { Role, TaskState } from "@a2a-js/sdk";

const baseUrl = process.env.PAYMENTLAB_A2A_URL ?? "http://127.0.0.1:3000";
const productId = process.argv[2] ?? "aurora-pro";
if (!/^https?:\/\/((127\.0\.0\.1)|(localhost))(?:\:[0-9]+)?$/.test(baseUrl)) {
  throw new Error("Local loopback URL required");
}
const client = await new ClientFactory({ transports: [new JsonRpcTransportFactory()] }).createFromUrl(baseUrl);
const response = await client.sendMessage({
  message: {
    role: Role.ROLE_USER,
    messageId: randomUUID(),
    parts: [{ content: { $case: "text", value: JSON.stringify({ productId, quantity: 1 }) },
      mediaType: "text/plain" }],
  },
}, { signal: AbortSignal.timeout(10_000) });
if (!response.id || !response.status) throw new Error("A2A task missing");
const task = response;
const part = task.artifacts?.[0]?.parts?.[0];
if (part?.content?.$case !== "text") throw new Error("A2A quote artifact missing");
const outcome = JSON.parse(part.content.value);
if (![TaskState.TASK_STATE_COMPLETED, TaskState.TASK_STATE_REJECTED].includes(task.status?.state)) {
  throw new Error("A2A task has no terminal status");
}
console.log(JSON.stringify({
  protocol: "A2A 1.0 JSON-RPC",
  taskId: task.id,
  taskState: TaskState[task.status.state],
  outcome,
  modelCalls: 0,
  paymentCalls: 0,
}, null, 2));
