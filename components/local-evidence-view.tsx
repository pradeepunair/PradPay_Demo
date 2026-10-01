"use client";

import { useEffect, useState } from "react";
import styles from "./local-evidence-view.module.css";

type Quote = { productId: string; productName: string; totalMinor: number; quoteId: string };
type ProtocolEvidence = { version: number; source: string;
  agentCard: { name: string; protocolVersion: string; binding: string; skillId: string };
  buyerMessage: { role: string; messageIdSuffix: string; productId: string; quantity: number };
  merchantTask: { taskIdSuffix: string; state: string; artifactIdSuffix: string;
    artifact: string; outcome: string } };
export type EvidenceSnapshot = {
  id: string; mission: string; quote: Quote | null; simulation?: boolean;
  buyer: { model: string; reason: string } | null;
  merchant: { model: string; reason: string } | null;
  protocolEvidence: ProtocolEvidence | null;
  payment: { paymentStatus: string; paymentIntentSuffix: string;
    accountId: string; sptIssuance: string } | null;
  order?: { state: string; amountMinor: number; currency: string } | null;
  webhookReceipts: { type: string; receivedAt: string; paymentIntentSuffix: string }[];
  events: { type: string; detail: string; at: string }[];
};

type Lane = "buyer" | "merchant" | "human" | "stripe";
type Card = { key: string; sequence: number; lane: Lane; title: string;
  detail: string; at: string; facts?: string[] };
const lanes: { id: Lane; label: string; subtitle: string }[] = [
  { id: "buyer", label: "Buyer agent", subtitle: "Selection and A2A request" },
  { id: "merchant", label: "Merchant agent", subtitle: "Task and server-priced quote" },
  { id: "human", label: "Human", subtitle: "Exact payment authority" },
  { id: "stripe", label: "Stripe sandbox", subtitle: "Test payment and signed callback" },
];
const dollars = (minor: number) => new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD",
}).format(minor / 100);

function cardsFor(run: EvidenceSnapshot): Card[] {
  const evidence = run.protocolEvidence;
  return run.events.flatMap((item, index): Card[] => {
    const sequence = index + 1;
    const base = { sequence, at: item.at, detail: item.detail };
    if (item.type === "a2a.quote") return [
      { ...base, key: `${index}-buyer`, lane: "buyer", title: "A2A message sent",
        facts: [
          `Model: ${run.buyer?.model ?? "Unknown"}`,
          `Selected: ${run.quote?.productName ?? "Unknown"}`,
          evidence ? `Message ···${evidence.buyerMessage.messageIdSuffix} · ${evidence.buyerMessage.quantity} × ${evidence.buyerMessage.productId}`
            : "Message envelope was not retained for this older run",
        ] },
      { ...base, key: `${index}-merchant`, lane: "merchant", title: "Merchant Task completed",
        facts: [
          evidence ? `${evidence.agentCard.name} · ${evidence.agentCard.binding} ${evidence.agentCard.protocolVersion}`
            : "A2A response summarized for this older run",
          evidence ? `Task ···${evidence.merchantTask.taskIdSuffix} · ${evidence.merchantTask.artifact} artifact ···${evidence.merchantTask.artifactIdSuffix}`
            : "Task and artifact IDs were not retained",
          run.quote ? `Server quote: ${dollars(run.quote.totalMinor)}` : "No quote",
        ] },
    ];
    if (item.type === "human.approved") return [{ ...base, key: `${index}-human`,
      lane: "human", title: "Exact quote approved", facts: run.quote
        ? [`${dollars(run.quote.totalMinor)} for ${run.quote.productName}`, "Approval is tied to this quote; agents cannot approve payment"] : [] }];
    if (item.type === "human.approval_fixture") return [{ ...base, key: `${index}-human`, lane: "human",
      title: "Illustrative approval", facts: ["Fixture only; no payment authority granted"] }];
    if (item.type === "a2a.request_fixture") return [{ ...base, key: `${index}-buyer`, lane: "buyer",
      title: "Example A2A request" }];
    if (item.type === "a2a.quote_fixture" || item.type === "a2a.refused") return [{ ...base,
      key: `${index}-merchant`, lane: "merchant", title: item.type === "a2a.refused" ? "Merchant refused" : "Illustrative catalog quote" }];
    if (item.type === "payment.reserved_fixture" || item.type.startsWith("stripe.") && item.type.endsWith("_fixture"))
      return [{ ...base, key: `${index}-fixture`, lane: "stripe", title: item.type.replaceAll(".", " ").replaceAll("_", " ") }];
    if (item.type === "payment.reserved") return [{ ...base, key: `${index}-reserved`,
      lane: "stripe", title: "One attempt reserved", facts: [
        "Reserved before Stripe dispatch; this is not a payment result",
        "Buyer SPT issuance simulated by Stripe seller-side test helper",
      ] }];
    if (item.type.startsWith("stripe.")) return [{ ...base, key: `${index}-stripe`,
      lane: "stripe", title: item.type === "stripe.retrieved" ? "Stripe result retrieved"
        : item.type === "stripe.webhook_confirmed" ? "Webhook confirmed payment" : "Stripe status checked",
      facts: run.payment ? [
        `Test status: ${run.payment.paymentStatus}`,
        `PaymentIntent ···${run.payment.paymentIntentSuffix}`,
      ] : [] }];
    if (item.type === "webhook.verified") return [{ ...base, key: `${index}-webhook`,
      lane: "stripe", title: "Signature verified", facts: [
        "Stripe-Signature checked against this listener's secret",
        `${run.webhookReceipts.length} receipt${run.webhookReceipts.length === 1 ? "" : "s"} saved for this run`,
      ] }];
    return [{ ...base, key: `${index}-other`, lane: item.type.startsWith("a2a.") ? "merchant" : "buyer",
      title: item.type.replaceAll(".", " ") }];
  });
}

export default function LocalEvidenceView({ run }: { run: EvidenceSnapshot }) {
  // null follows the latest event; an explicit cursor is a read-only replay.
  const [cursor, setCursor] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const count = run.events.length;
  const visible = cursor === null ? count : Math.min(cursor, count);
  const cards = cardsFor(run).filter((card) => card.sequence <= visible);

  useEffect(() => { setCursor(null); setPlaying(false); }, [run.id]);
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      setCursor((current) => Math.min((current ?? 0) + 1, count));
    }, 1200);
    return () => window.clearInterval(timer);
  }, [playing, count]);
  useEffect(() => { if (playing && visible >= count) setPlaying(false); }, [playing, visible, count]);

  return <section className={styles.shell} aria-label="Saved run evidence replay">
    <div className={styles.heading}>
      <div>
        <p className="eyebrow">{run.simulation ? "Saved simulation · read only" : "Saved evidence · read only"}</p>
        <h2>Follow the payment, step by step</h2>
        <p className={styles.intro}>{run.simulation
          ? "This teaching fixture illustrates failure and recovery. It made no A2A, model, or Stripe calls and created no real payment or order."
          : "These lanes replay stored evidence for this run. Playback reads the saved record and never calls either model or Stripe."}</p>
      </div>
      <span className={styles.badge}>{run.simulation ? "Simulated fixture" : "Sandbox evidence"}</span>
    </div>
    <div className={styles.controls} aria-label="Evidence playback controls">
      <button type="button" onClick={() => { setPlaying(false); setCursor(0); }}>Start</button>
      <button type="button" disabled={visible === 0} onClick={() => { setPlaying(false); setCursor(visible - 1); }}>Previous</button>
      <button type="button" onClick={() => {
        if (playing) setPlaying(false);
        else { setCursor(visible >= count ? 0 : visible); setPlaying(true); }
      }}>{playing ? "Pause" : "Play"}</button>
      <button type="button" disabled={visible >= count} onClick={() => { setPlaying(false); setCursor(visible + 1); }}>Next</button>
      <button type="button" onClick={() => { setPlaying(false); setCursor(null); }}>Show all</button>
      <label className={styles.scrub}>Step {visible} of {count}
        <input type="range" min="0" max={count} value={visible}
          onChange={(event) => { setPlaying(false); setCursor(Number(event.target.value)); }}
          aria-label="Replay step" />
      </label>
    </div>
    <p className={styles.provenance}>{run.simulation
      ? "Events are scripted examples saved in local PostgreSQL. They are not observed provider or A2A evidence."
      : run.protocolEvidence
      ? "A2A message, Task, and artifact labels come from the observed SDK exchange. Only safe fields and ID suffixes were saved."
      : "This older run predates detailed A2A capture. Buyer and Merchant cards use its saved quote and event summary; protocol envelope IDs are unavailable."}</p>
    <div className={styles.lanes}>
      {lanes.map((lane) => <section key={lane.id} className={styles.lane}
        aria-label={run.simulation && lane.id === "stripe" ? "Simulated provider outcome" : lane.label}>
        <div className={styles.laneHeading}><h3>{run.simulation && lane.id === "stripe" ? "Provider outcome (simulated)" : lane.label}</h3>
          <p>{run.simulation && lane.id === "stripe" ? "Scripted lookup and recovery" : lane.subtitle}</p></div>
        <ol className={styles.cards}>{cards.filter((card) => card.lane === lane.id).map((card) =>
          <li key={card.key} className={styles.card}>
            <div className={styles.cardMeta}><span>Step {card.sequence}</span><time dateTime={card.at}>{new Date(card.at).toLocaleTimeString()}</time></div>
            <h4>{card.title}</h4><p>{card.detail}</p>
            {card.facts && <ul>{card.facts.map((fact) => <li key={fact}>{fact}</li>)}</ul>}
          </li>)}</ol>
        {!cards.some((card) => card.lane === lane.id) && <p className={styles.empty}>No evidence at this step.</p>}
      </section>)}
    </div>
    <details className={styles.rawEvents}><summary>View event log</summary>
      <ol>{run.events.slice(0, visible).map((item, index) => <li key={`${index}-${item.type}`}>
        <strong>{item.type}</strong> · <time dateTime={item.at}>{new Date(item.at).toLocaleTimeString()}</time>
        <p>{item.detail}</p>
      </li>)}</ol>
    </details>
  </section>;
}
