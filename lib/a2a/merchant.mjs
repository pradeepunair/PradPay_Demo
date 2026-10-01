import { randomUUID } from "node:crypto";

import { A2A_PROTOCOL_VERSION, TaskState } from "@a2a-js/sdk";
import { AgentEvent, DefaultRequestHandler, InMemoryTaskStore, JsonRpcTransportHandler } from "@a2a-js/sdk/server";

import { multiplyBasisPointsHalfUp } from "../domain/money.mjs";

// Local demo catalog. This module is the authority for quotes; neither model
// nor a received A2A message can supply a price or stock count.
export const DEMO_CATALOG = Object.freeze([
  { id: "aurora-pro", name: "Aurora Pro Wireless", priceMinor: 27900, stock: 8 },
  { id: "harbor-studio", name: "Harbor Studio ANC", priceMinor: 28900, stock: 5 },
  { id: "summit-max", name: "Summit Max", priceMinor: 32900, stock: 4 },
  { id: "metro-lite", name: "Metro Lite", priceMinor: 19900, stock: 12 },
  { id: "cedar-classic", name: "Cedar Classic", priceMinor: 24900, stock: 6 },
  { id: "signal-one", name: "Signal One", priceMinor: 25900, stock: 0 },
]);

export function quoteDemoProduct(input, now = new Date()) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).sort().join(",") !== "productId,quantity"
    || typeof input.productId !== "string" || input.quantity !== 1) {
    return { outcome: "refused", reason: "INVALID_REQUEST" };
  }
  const product = DEMO_CATALOG.find((item) => item.id === input.productId);
  if (!product) return { outcome: "refused", reason: "PRODUCT_NOT_FOUND" };
  if (product.stock < 1) return { outcome: "refused", reason: "OUT_OF_STOCK" };
  const subtotalMinor = product.priceMinor - 1000;
  const shippingMinor = 1200;
  const taxMinor = multiplyBasisPointsHalfUp(subtotalMinor, 825);
  return {
    outcome: "quoted",
    quoteId: randomUUID(),
    catalogVersion: "local-demo-v1",
    productId: product.id,
    productName: product.name,
    quantity: 1,
    currency: "usd",
    unitPriceMinor: product.priceMinor,
    discountMinor: 1000,
    shippingMinor,
    taxMinor,
    totalMinor: subtotalMinor + shippingMinor + taxMinor,
    expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
    note: "Illustrative local quote; no stock reserved and no payment authority granted.",
  };
}

function textPart(value) {
  return { content: { $case: "text", value }, metadata: undefined, filename: "", mediaType: "text/plain" };
}

export function createMerchantAgentCard(baseUrl) {
  const endpoint = new URL("/api/a2a/merchant", baseUrl).toString();
  return {
    name: "PradPay Test Merchant",
    description: "Local demonstration merchant. Returns server-priced fictional catalog quotes; no payment tools.",
    supportedInterfaces: [{ url: endpoint, protocolBinding: "JSONRPC", tenant: "", protocolVersion: A2A_PROTOCOL_VERSION }],
    provider: { organization: "PradPay", url: new URL("/", baseUrl).toString() },
    version: "0.1.0",
    capabilities: { streaming: false, pushNotifications: false, extensions: [], extendedAgentCard: false },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    skills: [{
      id: "quote_demo_product", name: "Quote a fictional product",
      description: "Accepts JSON text with productId and quantity 1; returns a server-priced USD quote or refusal.",
      tags: ["commerce", "quote", "sandbox"],
      examples: ['{"productId":"aurora-pro","quantity":1}'],
      inputModes: ["text"], outputModes: ["text"], securityRequirements: [],
    }],
    documentationUrl: "",
    signatures: [],
  };
}

export function createMerchantA2A(baseUrl, { now = () => new Date(), reviewQuote } = {}) {
  const card = createMerchantAgentCard(baseUrl);
  const executor = {
    async execute(context, bus) {
      const { taskId, contextId, userMessage } = context;
      bus.publish(AgentEvent.task({
        id: taskId, contextId,
        status: { state: TaskState.TASK_STATE_SUBMITTED, timestamp: now().toISOString() },
        artifacts: [], history: [], metadata: {},
      }));
      const parts = userMessage.parts ?? [];
      const text = parts.length === 1 && parts[0]?.content?.$case === "text" ? parts[0].content.value : "";
      let parsed;
      try {
        if (text.length > 512) throw new Error("too long");
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      let quote = quoteDemoProduct(parsed, now());
      if (quote.outcome === "quoted" && reviewQuote) {
        try {
          const review = await reviewQuote(parsed, quote);
          if (review?.decision === "refuse") quote = { outcome: "refused", reason: "MERCHANT_DECLINED",
            model: review.model, usage: review.usage };
          else if (review?.decision === "accept") quote = { ...quote, merchantReview: {
            model: review.model, reason: review.reason, usage: review.usage,
          } };
          else quote = { outcome: "refused", reason: "MERCHANT_REVIEW_INVALID" };
        } catch {
          quote = { outcome: "refused", reason: "MERCHANT_REVIEW_UNAVAILABLE" };
        }
      }
      bus.publish(AgentEvent.artifactUpdate({
        taskId, contextId,
        artifact: {
          artifactId: randomUUID(), name: quote.outcome === "quoted" ? "Quote" : "Refusal",
          description: "Server-owned local catalog result.",
          parts: [textPart(JSON.stringify(quote))], metadata: {}, extensions: [],
        },
        lastChunk: true, append: false, metadata: {},
      }));
      bus.publish(AgentEvent.statusUpdate({
        taskId, contextId,
        status: { state: quote.outcome === "quoted" ? TaskState.TASK_STATE_COMPLETED : TaskState.TASK_STATE_REJECTED,
          timestamp: now().toISOString() },
        metadata: {},
      }));
    },
    async cancelTask() {},
  };
  const handler = new DefaultRequestHandler(card, new InMemoryTaskStore(), executor);
  return { card, transport: new JsonRpcTransportHandler(handler) };
}
