import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createLocalEvaluationBudget, initializeEvaluationBudget } from "../lib/agents/local-evaluation-budget.mjs";

test("budget persists across processes, includes prior 429, and blocks the eleventh reservation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "paymentlab-budget-"));
  const path = join(dir, "ledger.json");
  try {
    await initializeEvaluationBudget(path);
    await assert.rejects(initializeEvaluationBudget(path), /BUDGET_LEDGER_EXISTS/);
    for (let i = 0; i < 9; i += 1) {
      const budget = createLocalEvaluationBudget(path);
      await budget.reserve({ role: i % 2 ? "merchant" : "buyer", model: "gpt-6-sol" });
    }
    const budget = createLocalEvaluationBudget(path);
    assert.deepEqual(await budget.status(), { limitCents: 500, reservedCents: 500, remainingCents: 0 });
    await assert.rejects(budget.reserve({ role: "buyer", model: "gpt-6-luna" }), /BUDGET_EXHAUSTED/);
    assert.equal(JSON.parse(await readFile(path, "utf8")).reservations.length, 10);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("missing, malformed, and locked ledgers fail closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "paymentlab-budget-"));
  const path = join(dir, "ledger.json");
  try {
    const budget = createLocalEvaluationBudget(path);
    await assert.rejects(budget.reserve({ role: "buyer", model: "gpt-6-luna" }), /BUDGET_LEDGER_MISSING/);
    await writeFile(path, "not json");
    await assert.rejects(budget.reserve({ role: "buyer", model: "gpt-6-luna" }), /BUDGET_LEDGER_INVALID/);
    await rm(path);
    await initializeEvaluationBudget(path);
    await mkdir(`${path}.lock`);
    await assert.rejects(budget.reserve({ role: "buyer", model: "gpt-6-luna" }), /BUDGET_BUSY/);
    await rm(`${path}.lock`, { recursive: true });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
