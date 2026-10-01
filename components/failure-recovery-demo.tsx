"use client";

import { useEffect, useState } from "react";
import LocalEvidenceView, { type EvidenceSnapshot } from "./local-evidence-view";

type Scenario = EvidenceSnapshot & { state: string; scenario: "merchant_refusal" | "unknown_outcome";
  reconciliation: { outcome: string; checkedAt: string } | null };
const base = "/api/local-demo/failure-recovery";
const storage = "pradpay-failure-recovery-id";

export default function FailureRecoveryDemo() {
  const [run, setRun] = useState<Scenario | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const id = sessionStorage.getItem(storage);
    if (!id) return;
    fetch(`${base}/${id}`, { cache: "no-store" }).then(async (response) => {
      if (response.ok) setRun(await response.json());
      else sessionStorage.removeItem(storage);
    }).catch(() => setError("Could not reload the saved scenario."));
  }, []);

  async function act(path: string, body?: object) {
    setBusy(true); setError("");
    try {
      const response = await fetch(path, { method: "POST",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined });
      const result = await response.json();
      if (!response.ok) throw new Error(result.code ?? "SCENARIO_UNAVAILABLE");
      setRun(result);
      sessionStorage.setItem(storage, result.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "SCENARIO_UNAVAILABLE"); }
    finally { setBusy(false); }
  }

  return <section className="journey" id="failure-recovery" aria-label="Failure and recovery demo">
    <div className="panel">
      <p className="eyebrow">Failure and recovery · simulated</p>
      <h2>What happens when the merchant refuses or a result is unknown?</h2>
      <p>Choose a saved teaching scenario. These examples use the same local PostgreSQL database but are isolated from real runs, orders, and Stripe attempts. They make no model, A2A, or Stripe calls.</p>
      <div className="scenario-actions">
        <button className="button secondary" type="button" disabled={busy}
          onClick={() => act(base, { scenario: "merchant_refusal" })}>Show out-of-stock refusal</button>
        <button className="button secondary" type="button" disabled={busy}
          onClick={() => act(base, { scenario: "unknown_outcome" })}>Show unknown payment outcome</button>
      </div>
      {error && <p role="alert" className="journey-error">{error}</p>}
    </div>
    {run && <div className="panel">
      <p className="eyebrow" aria-live="polite">Simulated status: {run.state.replaceAll("_", " ")}</p>
      <h3>{run.mission}</h3>
      {run.scenario === "merchant_refusal" ? <p><strong>OUT_OF_STOCK.</strong> The catalog rule rejects Signal One. There is no quote, approval, payment attempt, or order.</p>
        : <>
          <p>Illustrative quote: <strong>${((run.quote?.totalMinor ?? 0) / 100).toFixed(2)}</strong>. The example attempt is unknown, so it must never be sent again.</p>
          {run.state === "payment_uncertain_simulated" && <p>Inspect the example read-only lookup. Until evidence matches, the outcome stays unknown.</p>}
          {run.state === "still_unknown_simulated" && <p>No match yet. A later matching provider record can resolve this without a second payment.</p>}
          {run.state === "recovered_simulated" && <p><strong>Fixture recovered.</strong> Matching account, amount, currency, and run reference support a simulated confirmed order. No actual Stripe result was fetched.</p>}
          {run.state !== "recovered_simulated" && <button className="button secondary" type="button" disabled={busy}
            onClick={() => act(`${base}/${run.id}/advance`)}>
            {busy ? "Advancing fixture…" : run.state === "payment_uncertain_simulated" ? "Show unresolved lookup" : "Show later matching evidence"}
          </button>}
        </>}
    </div>}
    {run && <LocalEvidenceView run={run} />}
  </section>;
}
