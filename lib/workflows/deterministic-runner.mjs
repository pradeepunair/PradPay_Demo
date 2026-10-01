import { isDeepStrictEqual } from "node:util";

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

export class DeterministicWorkflowRunner {
  #now;
  #workflows = new Map();

  constructor({ now = Date.now } = {}) {
    this.#now = now;
  }

  capabilities() {
    return Object.freeze({
      mode: "deterministic_local_fake",
      durable: false,
      automaticTimers: false,
      backgroundExecution: false,
      externalCalls: false,
    });
  }

  start({ workflowId, runId, definition, definitionVersion, input }) {
    if (!workflowId || !runId || !definition || !definitionVersion) {
      throw new TypeError("Workflow start requires stable IDs and definition version.");
    }
    const existing = this.#workflows.get(workflowId);
    if (existing) {
      const identical = existing.runId === runId
        && existing.definition === definition
        && existing.definitionVersion === definitionVersion
        && isDeepStrictEqual(existing.input, input);
      if (!identical) throw new Error("Workflow ID was already used with different workflow parameters.");
      return { ...this.status(workflowId), disposition: "replay" };
    }
    this.#workflows.set(workflowId, {
      workflowId,
      runId,
      definition,
      definitionVersion,
      input: clone(input),
      status: "running",
      attempt: 1,
      wait: null,
      callbacks: new Set(),
      lastError: null,
      updatedAt: this.#now(),
    });
    return this.status(workflowId);
  }

  resume(workflowId, { token } = {}) {
    const workflow = this.#require(workflowId);
    this.#assertNonTerminal(workflow);
    if (workflow.status !== "waiting" || workflow.wait?.kind !== "wait") {
      throw new Error("Workflow is not waiting for an explicit resume token.");
    }
    if (workflow.wait.token !== token) throw new Error("Workflow resume token does not match.");
    workflow.status = "running";
    workflow.wait = null;
    workflow.updatedAt = this.#now();
    return this.status(workflowId);
  }

  waitOrHook(workflowId, wait) {
    const workflow = this.#require(workflowId);
    this.#assertNonTerminal(workflow);
    if (workflow.status !== "running") throw new Error("Only a running workflow may wait.");
    if (wait?.kind === "hook" && !wait.hook) throw new TypeError("Hook wait requires hook.");
    if (wait?.kind === "wait" && !wait.token) throw new TypeError("Wait requires token.");
    if (!new Set(["hook", "wait"]).has(wait?.kind)) throw new TypeError("Unsupported wait kind.");
    workflow.status = "waiting";
    workflow.wait = clone(wait);
    workflow.updatedAt = this.#now();
    return this.status(workflowId);
  }

  wakeCallback(workflowId, { hook, callbackId, payload }) {
    const workflow = this.#require(workflowId);
    this.#assertNonTerminal(workflow);
    if (!callbackId) throw new TypeError("Callback wake requires callbackId.");
    if (workflow.callbacks.has(callbackId)) {
      return { ...this.status(workflowId), disposition: "duplicate" };
    }
    if (workflow.status !== "waiting" || workflow.wait?.kind !== "hook" || workflow.wait.hook !== hook) {
      throw new Error("Callback does not match the active workflow hook.");
    }
    workflow.callbacks.add(callbackId);
    workflow.callbackPayload = clone(payload);
    workflow.status = "running";
    workflow.wait = null;
    workflow.updatedAt = this.#now();
    return { ...this.status(workflowId), disposition: "woken" };
  }

  fail(workflowId, { code, retryable }) {
    const workflow = this.#require(workflowId);
    this.#assertNonTerminal(workflow);
    workflow.status = "failed_step";
    workflow.lastError = { code: code || "WORKFLOW_STEP_FAILED", retryable: retryable === true };
    workflow.updatedAt = this.#now();
    return this.status(workflowId);
  }

  retry(workflowId) {
    const workflow = this.#require(workflowId);
    this.#assertNonTerminal(workflow);
    if (workflow.status !== "failed_step" || workflow.lastError?.retryable !== true) {
      throw new Error("Workflow step is not retryable.");
    }
    workflow.attempt += 1;
    workflow.status = "running";
    workflow.lastError = null;
    workflow.updatedAt = this.#now();
    return this.status(workflowId);
  }

  cancel(workflowId, { reasonCode }) {
    const workflow = this.#require(workflowId);
    this.#assertNonTerminal(workflow);
    workflow.status = "canceled";
    workflow.cancelReasonCode = reasonCode || "CANCELED";
    workflow.wait = null;
    workflow.updatedAt = this.#now();
    return this.status(workflowId);
  }

  status(workflowId) {
    const workflow = this.#require(workflowId);
    return Object.freeze({
      workflowId: workflow.workflowId,
      runId: workflow.runId,
      definition: workflow.definition,
      definitionVersion: workflow.definitionVersion,
      status: workflow.status,
      attempt: workflow.attempt,
      wait: clone(workflow.wait),
      lastError: clone(workflow.lastError),
      updatedAt: workflow.updatedAt,
    });
  }

  #require(workflowId) {
    const workflow = this.#workflows.get(workflowId);
    if (!workflow) throw new Error("Unknown workflow.");
    return workflow;
  }

  #assertNonTerminal(workflow) {
    if (workflow.status === "canceled" || workflow.status === "completed") {
      throw new Error("Workflow is terminal.");
    }
  }
}
