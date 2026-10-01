import { randomUUID } from "node:crypto";
import { open, readFile, mkdir, rmdir, rename, unlink } from "node:fs/promises";
import { isAbsolute, dirname } from "node:path";

export class EvaluationBudgetError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const LIMIT_CENTS = 500;
const RESERVATION_CENTS = 50;

function checkedPath(path) {
  if (typeof path !== "string" || !isAbsolute(path)) throw new EvaluationBudgetError("BUDGET_PATH_REQUIRED");
  return path;
}

function validLedger(value) {
  return value?.version === 1 && value.limitCents === LIMIT_CENTS
    && Number.isSafeInteger(value.reservedCents) && value.reservedCents >= RESERVATION_CENTS
    && value.reservedCents <= LIMIT_CENTS && Array.isArray(value.reservations)
    && value.reservations.length === value.reservedCents / RESERVATION_CENTS
    && value.reservations.every((item) => item?.cents === RESERVATION_CENTS
      && typeof item.role === "string" && typeof item.model === "string");
}

async function loadLedger(path) {
  let ledger;
  try { ledger = JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    if (error?.code === "ENOENT") throw new EvaluationBudgetError("BUDGET_LEDGER_MISSING");
    throw new EvaluationBudgetError("BUDGET_LEDGER_INVALID");
  }
  if (!validLedger(ledger)) throw new EvaluationBudgetError("BUDGET_LEDGER_INVALID");
  return ledger;
}

export async function initializeEvaluationBudget(path) {
  checkedPath(path);
  const ledger = { version: 1, limitCents: LIMIT_CENTS, reservedCents: RESERVATION_CENTS,
    reservations: [{ role: "prior_buyer_429", model: "gpt-6-luna", cents: RESERVATION_CENTS }] };
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(ledger)}\n`);
    await handle.sync();
  } catch (error) {
    if (error?.code === "EEXIST") throw new EvaluationBudgetError("BUDGET_LEDGER_EXISTS");
    throw error;
  } finally { await handle?.close(); }
  return { limitCents: LIMIT_CENTS, reservedCents: RESERVATION_CENTS };
}

export function createLocalEvaluationBudget(path) {
  checkedPath(path);
  return Object.freeze({
    async status() {
      const { limitCents, reservedCents } = await loadLedger(path);
      return { limitCents, reservedCents, remainingCents: limitCents - reservedCents };
    },
    async reserve({ role, model }) {
      if (!["buyer", "merchant"].includes(role) || typeof model !== "string"
        || !/^gpt-[a-z0-9.-]{3,60}$/.test(model)) throw new EvaluationBudgetError("BUDGET_REQUEST_INVALID");
      const lockPath = `${path}.lock`;
      try { await mkdir(lockPath, { mode: 0o700 }); }
      catch { throw new EvaluationBudgetError("BUDGET_BUSY"); }
      let tempPath;
      try {
        const ledger = await loadLedger(path);
        if (ledger.reservedCents + RESERVATION_CENTS > LIMIT_CENTS) {
          throw new EvaluationBudgetError("BUDGET_EXHAUSTED");
        }
        ledger.reservedCents += RESERVATION_CENTS;
        ledger.reservations.push({ role, model, cents: RESERVATION_CENTS });
        tempPath = `${path}.${randomUUID()}.tmp`;
        const handle = await open(tempPath, "wx", 0o600);
        try { await handle.writeFile(`${JSON.stringify(ledger)}\n`); await handle.sync(); }
        finally { await handle.close(); }
        await rename(tempPath, path);
        tempPath = undefined;
        const dir = await open(dirname(path), "r");
        try { await dir.sync(); } finally { await dir.close(); }
        return { limitCents: LIMIT_CENTS, reservedCents: ledger.reservedCents,
          remainingCents: LIMIT_CENTS - ledger.reservedCents };
      } finally {
        if (tempPath) await unlink(tempPath).catch(() => {});
        await rmdir(lockPath);
      }
    },
  });
}
