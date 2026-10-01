"use client";

import { useEffect, useState } from "react";
import LocalEvidenceView, { type EvidenceSnapshot } from "./local-evidence-view";

type Quote = { quoteId: string; productName: string; productId: string; currency: string;
  unitPriceMinor: number; discountMinor: number; shippingMinor: number; taxMinor: number;
  totalMinor: number; expiresAt: string; catalogVersion: string };
type Snapshot = { id: string; state: string; mission: string; quote: Quote | null;
  buyer: { model: string; reason: string } | null; merchant: { model: string; reason: string } | null;
  protocol: string | null; payment: { paymentStatus: string; paymentIntentSuffix: string;
    accountId: string; sptIssuance: string } | null;
  paymentEnabled: boolean; events: { type: string; detail: string; at: string }[];
  order?: { state: string; amountMinor: number; currency: string } | null;
  reconciliation: { outcome: string; checkedAt: string } | null;
  webhookReceipts: { type: string; receivedAt: string; paymentIntentSuffix: string }[];
  protocolEvidence: EvidenceSnapshot["protocolEvidence"] };

const money = (minor: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(minor / 100);

export default function LocalSandboxJourney({ paymentEnabled, scenarioEnabled }: { paymentEnabled: boolean; scenarioEnabled: boolean }) {
  const [run, setRun] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const id = sessionStorage.getItem("paymentlab-local-demo-id");
    if (!id) return;
    fetch(`/api/local-demo/${id}`, { cache: "no-store" }).then(async (response) => {
      if (response.ok) setRun(await response.json());
      else sessionStorage.removeItem("paymentlab-local-demo-id");
    }).catch(() => setError("Could not reload the local run."));
  }, []);

  useEffect(() => {
    if (!run || run.state !== "succeeded" || run.webhookReceipts?.length) return;
    const id = run.id;
    let active = true;
    let inFlight = false;
    let checks = 0;
    const timer = window.setInterval(async () => {
      if (inFlight) return;
      if (++checks > 20) { window.clearInterval(timer); return; }
      inFlight = true;
      try {
        const response = await fetch(`/api/local-demo/${id}`, { cache: "no-store" });
        if (!response.ok || !active) return;
        const updated = await response.json() as Snapshot;
        if (active && updated.id === id) setRun((previous) => previous?.id === id ? updated : previous);
      } catch { /* The saved run can still be reloaded after a transient read failure. */ }
      finally { inFlight = false; }
    }, 3000);
    return () => { active = false; window.clearInterval(timer); };
  }, [run?.id, run?.state, run?.webhookReceipts?.length]);

  async function act(path: string, body?: object) {
    setBusy(true); setError("");
    try {
      const response = await fetch(path, { method: "POST",
        headers: { ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined });
      const result = await response.json();
      if (!response.ok) throw new Error(result.code ?? "LOCAL_DEMO_UNAVAILABLE");
      setRun(result);
      if (result.id) sessionStorage.setItem("paymentlab-local-demo-id", result.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "LOCAL_DEMO_UNAVAILABLE"); }
    finally { setBusy(false); }
  }

  const quote = run?.quote;
  return <section className="journey">
    <div className="panel">
      <p className="eyebrow">Local A2A → Stripe sandbox</p>
      <h1>Run an agent payment demo</h1>
      <p className="lede">Two local model roles exchange an open A2A JSON-RPC message. The merchant prices a fictional product. You review the exact quote before one Stripe test payment can be sent.</p>
      <details className="demo-walkthrough">
        <summary>Three-minute demo walkthrough</summary>
        <ol>
          <li><strong>Buyer request:</strong> A fictional buyer wants one in-stock pair of wireless headphones under $315. This is a fixed intent preset for the demo, not a buyer-entered payment authorization.</li>
          <li><strong>Agent exchange:</strong> Start a new local run. The Buyer selects a product and sends its ID and quantity to the Merchant through A2A. The Merchant returns a server-priced quote in a Task artifact.</li>
          <li><strong>Evidence:</strong> Step through the Buyer and Merchant lanes below. Replay only reads saved events.</li>
          <li><strong>Decision:</strong> Review and approve the exact quote. A separate button submits one Stripe sandbox test payment only if payments were enabled when this run began.</li>
          <li><strong>No-charge ending:</strong> Explore the refusal and uncertain-outcome fixtures below. They never call Stripe or create an order.</li>
        </ol>
      </details>
      <p className="fixture-note">The seller-side Stripe test helper simulates Buyer Shared Payment Token issuance. This is a local sandbox demo, not a claim of delegated ACP or production readiness.</p>
      {scenarioEnabled && <p><a href="#failure-recovery">Explore the no-charge failure and recovery walkthrough</a></p>}
      <p className="fixture-note">{paymentEnabled
        ? "Stripe test payments are available for new runs. You must approve the exact quote and submit the payment separately."
        : "Stripe test payments are off for new runs. You can still save and review a quote and approval."}</p>
      <button className="button primary" type="button" disabled={busy}
        onClick={() => act("/api/local-demo")}>{busy && !run ? "Running local models…" : "Start a new local run"}</button>
      {error && <p role="alert" className="journey-error">{error}</p>}
    </div>

    {run && <div className="panel">
      <p className="eyebrow" aria-live="polite">Run status: {run.state.replaceAll("_", " ")}</p>
      <h2>{run.mission}</h2>
      {quote && <div className="journey-quote">
        <h3>{quote.productName}</h3>
        <dl>
          <div><dt>Catalog price</dt><dd>{money(quote.unitPriceMinor)}</dd></div>
          <div><dt>Demo discount</dt><dd>−{money(quote.discountMinor)}</dd></div>
          <div><dt>Shipping</dt><dd>{money(quote.shippingMinor)}</dd></div>
          <div><dt>Tax</dt><dd>{money(quote.taxMinor)}</dd></div>
          <div className="journey-total"><dt>Exact total</dt><dd>{money(quote.totalMinor)}</dd></div>
        </dl>
        <p>Quote expires {new Date(quote.expiresAt).toLocaleString()} · {quote.catalogVersion}</p>
      </div>}
      {run.buyer && <p><strong>Buyer ({run.buyer.model}):</strong> {run.buyer.reason}</p>}
      {run.merchant && <p><strong>Merchant ({run.merchant.model}):</strong> {run.merchant.reason}</p>}
      {run.state === "quoted" && quote && <button className="button primary" type="button" disabled={busy}
        onClick={() => act(`/api/local-demo/${run.id}/approve`, { quoteId: quote.quoteId, totalMinor: quote.totalMinor })}>
        {run.paymentEnabled ? `Approve exact ${money(quote.totalMinor)} quote` : `Record ${money(quote.totalMinor)} approval (no payment)`}
      </button>}
      {run.state === "approved" && quote && <div>
        {run.paymentEnabled ? <p>Approval recorded for {money(quote.totalMinor)}. Review the amount again before submitting one Stripe sandbox payment.</p>
          : <p>Approval recorded for {money(quote.totalMinor)}. This run began with Stripe payment disabled. Start a fresh run in a payment-enabled local session to continue.</p>}
        {run.paymentEnabled ? <button className="button primary" type="button" disabled={busy}
          onClick={() => act(`/api/local-demo/${run.id}/pay`)}>
          {busy ? "Checking Stripe sandbox…" : `Submit one ${money(quote.totalMinor)} Stripe sandbox payment`}
        </button> : null}
      </div>}
      {run.state === "payment_reserved" && <p>Payment attempt reserved. Refresh to inspect status; do not start a second payment.</p>}
      {run.state === "payment_uncertain" && <p role="alert">The Stripe result is uncertain. This run will not retry. Reconcile the attempt before any new run.</p>}
      {run.state === "provider_failed" && <p role="alert">Stripe reported a canceled or rejected test payment. This order was not confirmed, and this run will not submit again.</p>}
      {["payment_reserved", "payment_uncertain", "provider_pending"].includes(run.state) && <button className="button secondary"
        type="button" disabled={busy} onClick={() => act(`/api/local-demo/${run.id}/reconcile`)}>
        {busy ? "Reading Stripe status…" : "Check Stripe status (read-only)"}
      </button>}
      {run.reconciliation && <p><strong>Reconciliation:</strong> {run.reconciliation.outcome} at {new Date(run.reconciliation.checkedAt).toLocaleString()}</p>}
      {run.payment && <p><strong>Stripe test status:</strong> {run.payment.paymentStatus} · account {run.payment.accountId} · PaymentIntent suffix {run.payment.paymentIntentSuffix}</p>}
      {run.order && <p><strong>Test order:</strong> {run.order.state.replaceAll("_", " ")} · {money(run.order.amountMinor)}</p>}
      {run.webhookReceipts?.length > 0 && <p><strong>Verified Stripe webhook receipts:</strong> {run.webhookReceipts.length}</p>}
      {run.state === "succeeded" && !run.webhookReceipts?.length &&
        <p>Payment is confirmed. Waiting for a separately verified Stripe webhook receipt; this page checks for it for one minute.</p>}
    </div>}

    {run && <LocalEvidenceView run={run} />}
  </section>;
}
