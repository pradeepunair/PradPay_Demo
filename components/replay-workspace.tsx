"use client";

import { useEffect, useMemo, useState } from "react";

import { projectEvents } from "../lib/replay/reducer.mjs";
import styles from "./replay-workspace.module.css";

type EventRecord = {
  eventId: string;
  sequence: number;
  type: string;
  actor: string;
  occurredAt: string;
  summary: string;
  explanation: string;
  evidenceRefs: string[];
  patch: Record<string, unknown>;
};

type Recording = {
  schemaVersion: string;
  source: string;
  mode: string;
  title: string;
  description: string;
  referenceTime: string;
  durationMs: number;
  events: EventRecord[];
};

type Perspective = "buyer" | "merchant" | "psp" | "all";

const perspectives: Array<{ id: Perspective; label: string }> = [
  { id: "buyer", label: "Buyer" },
  { id: "merchant", label: "Merchant" },
  { id: "psp", label: "Provider" },
  { id: "all", label: "All views" },
];

const speedOptions = [
  { label: "0.5×", factor: 0.5 },
  { label: "1×", factor: 1 },
  { label: "2×", factor: 2 },
];

function money(value: unknown) {
  if (!Number.isSafeInteger(value)) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format((value as number) / 100);
}

function Fact({ label, value }: { label: string; value: unknown }) {
  const shown = Array.isArray(value) ? value.join(" · ") : value ?? "—";
  return (
    <div className={styles.fact}>
      <dt>{label}</dt>
      <dd>{String(shown)}</dd>
    </div>
  );
}

function PerspectiveCard({ id, projection }: { id: Exclude<Perspective, "all">; projection: any }) {
  if (id === "buyer") {
    return (
      <section className={styles.perspectiveCard} aria-labelledby="buyer-view-title">
        <p className={styles.cardEyebrow}>Buyer agent</p>
        <h2 id="buyer-view-title">Intent and authority</h2>
        <dl>
          <Fact label="Mission" value={projection.buyer.mission} />
          <Fact label="Requirements" value={projection.buyer.requirements} />
          <Fact label="Selected product" value={projection.buyer.selectedProduct} />
          <Fact label="Why selected" value={projection.buyer.selectionReason} />
          <Fact label="Authority" value={projection.buyer.authority} />
          <Fact label="Receipt" value={projection.buyer.receipt} />
        </dl>
      </section>
    );
  }
  if (id === "merchant") {
    return (
      <section className={styles.perspectiveCard} aria-labelledby="merchant-view-title">
        <p className={styles.cardEyebrow}>Merchant</p>
        <h2 id="merchant-view-title">Quote and economics</h2>
        <dl>
          <Fact label="Request" value={projection.merchant.request} />
          <Fact label="Stock" value={projection.merchant.stock} />
          <Fact label="Quote" value={projection.merchant.quote} />
          <Fact label="Contribution" value={money(projection.merchant.contributionMinor)} />
          <Fact label="Risk" value={projection.merchant.risk} />
        </dl>
      </section>
    );
  }
  return (
    <section className={styles.perspectiveCard} aria-labelledby="provider-view-title">
      <p className={styles.cardEyebrow}>Payment provider</p>
      <h2 id="provider-view-title">Submission and callback</h2>
      <dl>
        <Fact label="Provider" value={projection.psp.provider} />
        <Fact label="Reference" value={projection.psp.providerReference} />
        <Fact label="State" value={projection.psp.state} />
        <Fact label="Callback evidence" value={projection.psp.webhook} />
        <Fact label="Fee assumption" value={money(projection.psp.feeAssumptionMinor)} />
      </dl>
    </section>
  );
}

export default function ReplayWorkspace({ recording }: { recording: Recording }) {
  const [cursor, setCursor] = useState(0);
  const [perspective, setPerspective] = useState<Perspective>("buyer");
  const [playing, setPlaying] = useState(false);
  const [speedFactor, setSpeedFactor] = useState(speedOptions[1].factor);
  const maximum = recording.events.at(-1)?.sequence ?? 0;
  const projection = useMemo(() => projectEvents(recording.events, cursor), [recording.events, cursor]);
  const currentEvent = recording.events.find((event) => event.sequence === cursor) ?? null;

  useEffect(() => {
    if (!playing) return;
    if (cursor >= maximum) {
      setPlaying(false);
      return;
    }
    const nextEvent = recording.events.find((event) => event.sequence > cursor);
    if (!nextEvent) {
      setPlaying(false);
      return;
    }
    const currentTime = currentEvent?.occurredAt ?? recording.referenceTime;
    const recordedDelay = Date.parse(nextEvent.occurredAt) - Date.parse(currentTime);
    const playbackDelay = Math.max(250, Math.min(10000, recordedDelay / speedFactor));
    const timer = window.setTimeout(() => setCursor(nextEvent.sequence), playbackDelay);
    return () => window.clearTimeout(timer);
  }, [currentEvent, cursor, maximum, playing, recording.events, recording.referenceTime, speedFactor]);

  function move(nextCursor: number) {
    setPlaying(false);
    setCursor(Math.max(0, Math.min(nextCursor, maximum)));
  }

  function togglePlayback() {
    if (playing) {
      setPlaying(false);
      return;
    }
    if (cursor === maximum) setCursor(0);
    setPlaying(true);
  }

  const visiblePerspectives = perspective === "all" ? ["buyer", "merchant", "psp"] as const : [perspective];

  return (
    <div className={styles.workspace}>
      <section className={styles.runHeader} aria-labelledby="run-title">
        <div>
          <p className={styles.cardEyebrow}>Synthetic development fixture · schema {recording.schemaVersion}</p>
          <h1 id="run-title">{recording.title}</h1>
          <p>{recording.description}</p>
        </div>
        <div className={styles.statusSummary} aria-live="polite">
          <span className={styles.phase}>{projection.shared.phase}</span>
          <strong>{projection.shared.runStatus}</strong>
          <span>Cursor {cursor}</span>
        </div>
      </section>

      <nav className={styles.perspectiveTabs} aria-label="Perspective">
        {perspectives.map((item) => (
          <button
            aria-pressed={perspective === item.id}
            className={perspective === item.id ? styles.activeTab : ""}
            key={item.id}
            onClick={() => setPerspective(item.id)}
            type="button"
          >
            {item.label}
          </button>
        ))}
      </nav>

      <div className={styles.grid}>
        <aside className={styles.timeline} aria-label="Event timeline">
          <div className={styles.panelHeading}>
            <div><span>Event rail</span><strong>Visible through cursor</strong></div>
            <span>{projection.visibleEvents.length}</span>
          </div>
          <ol>
            {projection.visibleEvents.map((event: EventRecord) => (
                <li key={event.eventId}>
                  <button
                    aria-current={event.sequence === cursor ? "step" : undefined}
                    className={styles.eventButton}
                    onClick={() => move(event.sequence)}
                    type="button"
                  >
                    <span>{String(event.sequence).padStart(2, "0")}</span>
                    <span><strong>{event.type}</strong><small>{event.summary}</small></span>
                  </button>
                </li>
            ))}
          </ol>
        </aside>

        <section className={styles.stage} aria-label={`${perspective} perspective`}>
          <div className={styles.sharedFacts}>
            <span>Phase <strong>{projection.shared.phase}</strong></span>
            <span>Total <strong>{money(projection.shared.totalMinor)}</strong></span>
            <span>Payment <strong>{projection.shared.paymentStatus}</strong></span>
            <span>Order <strong>{projection.shared.orderStatus}</strong></span>
          </div>
          <div className={styles.perspectiveGrid} data-all={perspective === "all"}>
            {visiblePerspectives.map((id) => <PerspectiveCard id={id} key={id} projection={projection} />)}
          </div>
        </section>

        <aside className={styles.details} aria-label="Current event details">
          <div className={styles.panelHeading}><div><span>Event details</span><strong>Evidence at cursor</strong></div></div>
          {currentEvent ? (
            <div className={styles.detailBody}>
              <span className={styles.sequenceBadge}>Event {currentEvent.sequence}</span>
              <h2>{currentEvent.type}</h2>
              <p>{currentEvent.summary}</p>
              <hr />
              <h3>Why this matters</h3>
              <p>{currentEvent.explanation}</p>
              <h3>Actor</h3><p><code>{currentEvent.actor}</code></p>
              <h3>Evidence references</h3>
              <ul>{currentEvent.evidenceRefs.map((reference) => <li key={reference}><code>{reference}</code></li>)}</ul>
            </div>
          ) : (
            <div className={styles.emptyDetail}>
              <strong>Before the first event</strong>
              <p>No event-derived facts are visible. Press play or move to the next event.</p>
            </div>
          )}
        </aside>
      </div>

      <footer className={styles.controls} aria-label="Replay controls">
        <div className={styles.controlButtons}>
          <button aria-label="Go to start" onClick={() => move(0)} type="button">↤</button>
          <button aria-label="Previous event" disabled={cursor === 0} onClick={() => move(cursor - 1)} type="button">←</button>
          <button className={styles.playButton} onClick={togglePlayback} type="button">
            {playing ? "Pause" : cursor === maximum ? "Replay" : "Play"}
          </button>
          <button aria-label="Next event" disabled={cursor === maximum} onClick={() => move(cursor + 1)} type="button">→</button>
        </div>
        <label className={styles.scrubber}>
          <span>Replay position</span>
          <input aria-label="Replay position" max={maximum} min="0" onChange={(event) => move(Number(event.target.value))} type="range" value={cursor} />
        </label>
        <label className={styles.speedControl}>
          <span>Speed</span>
          <select onChange={(event) => setSpeedFactor(Number(event.target.value))} value={speedFactor}>
            {speedOptions.map((option) => <option key={option.label} value={option.factor}>{option.label}</option>)}
          </select>
        </label>
      </footer>
    </div>
  );
}
