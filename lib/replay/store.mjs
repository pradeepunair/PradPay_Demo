import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { projectEvents, validateProjectionPatch } from "./reducer.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const recordingDirectory = path.join(repositoryRoot, "public", "replays");
const recordingIndex = Object.freeze([
  { slug: "synthetic-success-v1", title: "Successful delegated sale", description: "A deterministic development fixture from mission to simulated confirmation." },
]);

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`);
}
function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
}
function timestamp(value, label) {
  requiredString(value, label);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a valid timestamp`);
  return parsed;
}

export function validateRecording(recording) {
  if (recording?.schemaVersion !== "1.0.0") throw new Error("Unsupported recording schema version");
  if (recording.source !== "synthetic_development_fixture") throw new Error("Unsupported recording source; integrated recordings require a later publication gate");
  if (recording.mode !== "guided_replay") throw new Error("Recording must be guided_replay");
  for (const field of ["slug", "title", "description", "referenceTime"]) requiredString(recording[field], `Recording ${field}`);
  nonNegativeInteger(recording.durationMs, "Recording durationMs");
  if (!Array.isArray(recording.catalog) || !Array.isArray(recording.events)) throw new Error("Recording catalog and events must be arrays");

  const productIds = new Set();
  for (const product of recording.catalog) {
    for (const field of ["id", "name"]) requiredString(product?.[field], `Catalog ${field}`);
    if (productIds.has(product.id)) throw new Error("Catalog product IDs must be unique");
    for (const field of ["priceMinor", "batteryHours", "deliveryDays", "stock"]) nonNegativeInteger(product[field], `Catalog ${field}`);
    productIds.add(product.id);
  }

  const referenceTime = timestamp(recording.referenceTime, "Recording referenceTime");
  const endTime = referenceTime + recording.durationMs;
  let previousTime = referenceTime;
  let previousSequence = 0;
  const eventIds = new Set();
  for (const event of recording.events) {
    if (!Number.isSafeInteger(event.sequence) || event.sequence !== previousSequence + 1) throw new Error("Recording event sequence must be contiguous and strictly increasing");
    requiredString(event.eventId, "Event eventId");
    if (eventIds.has(event.eventId)) throw new Error("Recording event IDs must be present and unique");
    for (const field of ["type", "summary", "occurredAt", "actor", "explanation"]) requiredString(event[field], `Event ${field}`);
    const occurredAt = timestamp(event.occurredAt, "Event occurredAt");
    if (occurredAt < previousTime || occurredAt > endTime) throw new Error("Event timestamps must be ordered and within recording duration");
    if (!Array.isArray(event.evidenceRefs) || !event.evidenceRefs.every((item) => typeof item === "string" && item.trim().length > 0)) throw new Error("Event evidenceRefs must be an array of non-empty strings");
    validateProjectionPatch(event.patch);
    previousTime = occurredAt;
    previousSequence = event.sequence;
    eventIds.add(event.eventId);
  }
  return recording;
}

export async function listRecordings() { return structuredClone(recordingIndex); }
export async function loadRecording(slug) {
  if (!recordingIndex.some((recording) => recording.slug === slug)) return null;
  const text = await readFile(path.join(recordingDirectory, `${slug}.json`), "utf8");
  return validateRecording(JSON.parse(text));
}
export function projectRecording(recording, cursorSequence) {
  validateRecording(recording);
  const maximum = recording.events.at(-1)?.sequence ?? 0;
  const cursor = Math.max(0, Math.min(Number(cursorSequence) || 0, maximum));
  return { cursor, ...projectEvents(recording.events, cursor) };
}
