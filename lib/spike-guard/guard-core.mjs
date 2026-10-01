import { assertExecutionEpoch, parseSntpSample } from "./clock.mjs";
import { FROZEN_REQUEST_HASH, assertExactSpikeRequest } from "./request.mjs";
import { CLOCK_AUTHORITY, assertActiveLease, createApprovalLease, createFilesystemOneShot } from "./state.mjs";
import { sanitizeExecutionFailure } from "./safe-errors.mjs";

async function captureTrustedClock(captureClock) {
  const snapshot = await captureClock();
  if (!snapshot || typeof snapshot !== "object" || !Object.isFrozen(snapshot)) throw new Error("trusted clock snapshot must be immutable");
  if (snapshot.authority !== CLOCK_AUTHORITY) throw new Error("trusted clock authority mismatch");
  if (!Number.isSafeInteger(snapshot.epoch) || !Number.isFinite(snapshot.capturedAtMs)) {
    throw new Error("trusted clock epoch or capture time is invalid");
  }
  if (Math.floor(snapshot.capturedAtMs / 1000) !== snapshot.epoch) {
    throw new Error("trusted clock millisecond capture does not match its epoch");
  }
  if (!snapshot.evidence || !Object.isFrozen(snapshot.evidence) || snapshot.evidence.nowEpoch !== snapshot.epoch) {
    throw new Error("trusted clock evidence must be immutable and match the snapshot epoch");
  }
  const sample = parseSntpSample(snapshot.evidence);
  assertExecutionEpoch(snapshot.epoch);
  return Object.freeze({ epoch: snapshot.epoch, capturedAtMs: snapshot.capturedAtMs, sample });
}

function assertCredentialMetadata(credential, account) {
  if (!credential || typeof credential !== "object") throw new Error("credential metadata is unavailable");
  if (credential.account !== account) throw new Error("credential account does not match the approved account");
  if (credential.livemode !== false) throw new Error("credential is not verified for test mode");
  return credential;
}

function abortError(signal) {
  return signal.reason instanceof Error ? signal.reason : new Error("action lease expired");
}

async function raceWithAbort(promise, signal) {
  if (signal.aborted) throw abortError(signal);
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export function projectProviderOutcome(value) {
  const fail = () => { throw new Error("provider outcome is not safely classifiable"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const allowed = ["statusClass", "requestReference", "objectClass", "objectReference", "hasError"];
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...allowed].sort())) return fail();
  if (typeof value.hasError !== "boolean") return fail();
  if (!["success", "redirect", "client_error", "server_error", "invalid"].includes(value.statusClass)) return fail();
  if (!["granted_token", "other", "missing"].includes(value.objectClass)) return fail();
  const validReference = (item) => item === null || (typeof item === "string" && /^sha256:[a-f0-9]{64}$/.test(item));
  if (!validReference(value.requestReference) || !validReference(value.objectReference)) return fail();
  return Object.freeze({
    statusClass: value.statusClass,
    requestReference: value.requestReference,
    objectClass: value.objectClass,
    objectReference: value.objectReference,
    hasError: value.hasError,
  });
}

async function executeStripeSpikeGuardCoreUnchecked({
  request,
  approval,
  stateDirectory,
  captureClock,
  getCredential,
  sendRequest,
} = {}) {
  if (typeof captureClock !== "function" || typeof getCredential !== "function" || typeof sendRequest !== "function") {
    throw new TypeError("trusted clock, credential, and request adapters are required");
  }
  const frozenRequest = assertExactSpikeRequest(request);
  const initialClock = await captureTrustedClock(captureClock);
  const lease = createApprovalLease({ approval, nowEpoch: initialClock.epoch });

  const milliseconds = lease.endsAtEpoch * 1000 - initialClock.capturedAtMs;
  if (milliseconds <= 0) throw new Error("action lease expired before durable claim");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("action lease expired")), milliseconds);

  try {
    const oneShot = createFilesystemOneShot({ directory: stateDirectory });
    await raceWithAbort(oneShot.claim({ lease, claimedAtEpoch: initialClock.epoch }), controller.signal);

    const credentialClock = await captureTrustedClock(captureClock);
    assertActiveLease(lease, credentialClock.epoch);
    const credential = assertCredentialMetadata(
      await raceWithAbort(Promise.resolve(getCredential({ signal: controller.signal, leaseEndsAtEpoch: lease.endsAtEpoch })), controller.signal),
      frozenRequest.account,
    );

    const dispatchClock = await captureTrustedClock(captureClock);
    assertActiveLease(lease, dispatchClock.epoch);
    let sendAuthorized = false;
    const authorizeSend = async () => {
      if (sendAuthorized) throw new Error("provider send was already authorized");
      const sendClock = await captureTrustedClock(captureClock);
      assertActiveLease(lease, sendClock.epoch);
      if (controller.signal.aborted) throw abortError(controller.signal);
      sendAuthorized = true;
      return Object.freeze({ epoch: sendClock.epoch, leaseEndsAtEpoch: lease.endsAtEpoch });
    };

    const providerOutcome = await raceWithAbort(Promise.resolve(sendRequest({
      request: frozenRequest,
      requestHash: FROZEN_REQUEST_HASH,
      credential,
      signal: controller.signal,
      leaseEndsAtEpoch: lease.endsAtEpoch,
      authorizeSend,
    })), controller.signal);
    if (!sendAuthorized) throw new Error("provider transport did not consume the send authorization boundary");
    const result = projectProviderOutcome(providerOutcome);

    return Object.freeze({
      status: "dispatched",
      requestHash: FROZEN_REQUEST_HASH,
      initialClock: initialClock.sample,
      credentialClock: credentialClock.sample,
      dispatchClock: dispatchClock.sample,
      leaseEndsAtEpoch: lease.endsAtEpoch,
      result,
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function executeStripeSpikeGuardCore(input) {
  try {
    return await executeStripeSpikeGuardCoreUnchecked(input);
  } catch (error) {
    throw sanitizeExecutionFailure(error);
  }
}
