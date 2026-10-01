import Link from "next/link";
import { localJourneyConfiguration } from "../lib/demo/local-journey.mjs";

export const dynamic = "force-dynamic";

const checklist = [
  "Buyer and merchant decisions with one shared evidence trail",
  "Decline, duplicate, and timeout/recovery teaching scenarios",
  "Scripted mode needs no keys, database, or model server",
];

export default function HomePage() {
  const localRunEnabled = process.env.PAYMENTLAB_RUN_API_MODE === "local"
    && process.env.PAYMENTLAB_ENVIRONMENT === "local"
    && process.env.PAYMENTLAB_DATABASE_MODE === "local";
  return (
    <main>
      <header className="site-header">
        <Link className="brand" href="/" aria-label="PradPay home">
          <span className="brand-mark">P</span>
          <span>PradPay</span>
        </Link>
        <span className="environment-pill">Local demo · optional sandbox integrations</span>
      </header>

      <section className="hero" aria-labelledby="hero-title">
        <div>
          <p className="eyebrow">Observe decisions. Inspect evidence.</p>
          <h1 id="hero-title">Explore an agent-to-agent purchase</h1>
          <p className="hero-copy">
            Run the interactive teaching simulation, inspect each exchange, and try a failure
            and recovery scenario. Optional local-model and Stripe test paths have separate setup.
          </p>
          <div className="hero-actions">
            <Link className="button primary" href="/simulation">
              Open interaction studio
            </Link>
            <Link className="button secondary" href="/demo/synthetic-success-v1">Guided Replay</Link>
            {localRunEnabled && <Link className="button secondary" href="/local-run">Open local mission workspace</Link>}
            {localJourneyConfiguration() && <Link className="button secondary" href="/local-sandbox">Open local A2A sandbox</Link>}
            <a className="button secondary" href="#scope">
              Review the safety boundary
            </a>
          </div>
        </div>
        <aside className="mission-card" aria-label="Replay summary">
          <p className="card-kicker">Agent Interaction Studio</p>
          <h2>Start with a fictional sale</h2>
          <ul>
            {checklist.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <p className="fixture-note">No credentials or external service required for the scripted path.</p>
        </aside>
      </section>

      <section className="scope-grid" id="scope" aria-labelledby="scope-title">
        <div>
          <p className="eyebrow">Choose your mode</p>
          <h2 id="scope-title">Scripted first, integrations when ready</h2>
          <p>
            The Studio is a repeatable teaching scenario. You can optionally add a local model,
            local PostgreSQL evidence, or a separate A2A quote and Stripe sandbox payment.
          </p>
        </div>
        <div className="scope-card">
          <strong>Scripted simulation</strong>
          <p>Replay and teaching-scenario controls use fictional authority and simulated payment evidence.</p>
        </div>
        <div className="scope-card">
          <strong>Optional local A2A and Stripe test</strong>
          <p>The separate local sandbox requires explicit setup and human approval before one test-mode payment.</p>
        </div>
      </section>
    </main>
  );
}
