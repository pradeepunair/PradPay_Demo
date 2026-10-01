"use client";

import { useEffect, useRef, useState } from "react";

import styles from "./local-run-workspace.module.css";

type Mission = { goal: string; requirements: string[] };
type SafeEvent = { eventId: string; sequence: number; type: string; occurredAt: string; safePayload: Record<string, unknown> };
type RunSnapshot = { runId: string; state: string; mode: string; scenario: string; cursor: number; events: SafeEvent[] };
type PendingRequest = { mission: Mission; idempotencyKey: string };

const runIdPattern = /^run_[0-9a-f]{48}$/;

async function resultCode(response: Response) {
  try { return (await response.json()).code as string ?? "REQUEST_FAILED"; }
  catch { return "REQUEST_FAILED"; }
}

export default function LocalRunWorkspace() {
  const [goal, setGoal] = useState("");
  const [requirements, setRequirements] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(null);
  const [events, setEvents] = useState<SafeEvent[]>([]);
  const [message, setMessage] = useState("");
  const [working, setWorking] = useState(false);
  const [pending, setPending] = useState<PendingRequest | null>(null);
  const cursor = useRef(0);

  useEffect(() => {
    const fromUrl = new URL(window.location.href).searchParams.get("run");
    if (fromUrl && runIdPattern.test(fromUrl)) setRunId(fromUrl);
  }, []);

  useEffect(() => {
    if (!runId) return;
    let active = true;
    let inFlight = false;
    cursor.current = 0;
    setSnapshot(null);
    setEvents([]);
    async function poll() {
      if (inFlight) return;
      inFlight = true;
      try {
        const response = await fetch(`/api/runs/${runId}?after=${cursor.current}`, { cache: "no-store" });
        if (!active) return;
        if (!response.ok) { setMessage(`Run unavailable: ${await resultCode(response)}.`); return; }
        const next = await response.json() as RunSnapshot;
        if (!active) return;
        cursor.current = next.cursor;
        setSnapshot(next);
        if (next.events.length) setEvents((previous) => [...previous, ...next.events]);
        setMessage("");
      } catch {
        if (active) setMessage("Run status could not be reached. The saved URL can be reopened later.");
      } finally { inFlight = false; }
    }
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 3000);
    return () => { active = false; window.clearInterval(timer); };
  }, [runId]);

  async function submit() {
    if (working) return;
    const mission = pending?.mission ?? {
      goal: goal.trim(), requirements: requirements.split("\n").map((item) => item.trim()).filter(Boolean),
    };
    if (!pending && (mission.goal.length < 8 || mission.goal.length > 240 || mission.requirements.length > 6
      || mission.requirements.some((item) => item.length > 100))) {
      setMessage("Use an 8–240 character goal and up to six requirements, each at most 100 characters.");
      return;
    }
    const request = pending ?? { mission, idempotencyKey: crypto.randomUUID() };
    setPending(request);
    setWorking(true);
    setMessage("");
    try {
      const session = await fetch("/api/sessions", { method: "POST" });
      if (!session.ok) {
        setPending(null);
        setMessage(`Local run is unavailable: ${await resultCode(session)}.`);
        return;
      }
      const response = await fetch("/api/runs", {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": request.idempotencyKey },
        body: JSON.stringify({ mission: request.mission }),
      });
      if (!response.ok) {
        const code = await resultCode(response);
        if (response.status < 500) setPending(null);
        setMessage(`Mission was not admitted: ${code}.`);
        return;
      }
      const created = await response.json() as { runId: string };
      if (!runIdPattern.test(created.runId)) throw new Error("Invalid run response");
      setPending(null);
      window.history.replaceState(null, "", `/local-run?run=${encodeURIComponent(created.runId)}`);
      setRunId(created.runId);
    } catch {
      setMessage("The result is uncertain. Retry this same request; its idempotency key is retained in this tab.");
    } finally { setWorking(false); }
  }

  return (
    <div className={styles.workspace}>
      <div className={styles.heading}>
        <p className="eyebrow">Local development · Phase 2 increment</p>
        <h1>Mission workspace</h1>
        <p>This records a mission and its evidence in local PostgreSQL. The preparation job has no worker yet, so runs remain queued. No model or payment provider is called.</p>
      </div>
      {runId ? (
        <section className={styles.panel} aria-labelledby="status-title">
          <div className={styles.statusRow}>
            <div><p className={styles.kicker}>Owned run</p><h2 id="status-title">{snapshot?.state ?? "Loading status…"}</h2></div>
            <span className={styles.badge}>Cursor {cursor.current}</span>
          </div>
          <p>Run ID: <code>{runId}</code></p>
          <p>This URL works in another tab of the same browser session. Access expires with the local session.</p>
          <h3>Committed events</h3>
          <ol className={styles.events}>
            {events.map((event) => <li key={event.eventId}>
              <strong>{event.sequence}. {event.type}</strong>
              <span>{new Date(event.occurredAt).toLocaleString()}</span>
              {event.type === "mission.confirmed" && typeof event.safePayload.goal === "string" ? <p>{event.safePayload.goal}</p> : null}
            </li>)}
          </ol>
          {events.length === 0 && <p>No committed event has loaded yet.</p>}
          <a href="/local-run" className={styles.link}>Start another mission</a>
        </section>
      ) : (
        <section className={styles.panel} aria-labelledby="mission-title">
          <h2 id="mission-title">Confirm a mission</h2>
          <label htmlFor="mission-goal">Goal</label>
          <textarea id="mission-goal" maxLength={240} minLength={8} value={goal} disabled={Boolean(pending) || working}
            onChange={(event) => setGoal(event.target.value)} placeholder="Find a durable headset within a stated budget" rows={3} />
          <label htmlFor="mission-requirements">Requirements, one per line (up to six)</label>
          <textarea id="mission-requirements" value={requirements} disabled={Boolean(pending) || working}
            onChange={(event) => setRequirements(event.target.value)} placeholder="At least eight hours of battery life" rows={5} />
          <button className={styles.submit} type="button" disabled={working} onClick={() => void submit()}>
            {working ? "Recording…" : pending ? "Retry same request" : "Record mission"}
          </button>
          <p className={styles.note}>Do not enter payment credentials or personal information. A retry uses the same request key; it cannot create a second run for the same mission.</p>
        </section>
      )}
      {message && <p className={styles.message} role="status">{message}</p>}
    </div>
  );
}
