const PROTOCOL_KEYS = ["authenticate"];
const RESULT_KEYS = ["status", "receipt"];
const CHALLENGE_KEYS = [
  "capability", "candidateCommit", "request", "requestHash", "identity", "nowEpoch", "zeroPayment",
];
const IDENTITY_KEYS = ["account", "profile", "operatorIdentity", "ownerIdentity", "testMode"];

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} is required`);
  }
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} fields do not match the test-only protocol`);
  }
}

/**
 * Test-only LocalAuthentication seam. The production/native framework is
 * deliberately not imported here: tests inject a protocol-shaped fake.
 *
 * The protocol has one operation and returns a typed result. There is no
 * caller-supplied approval boolean, completion callback, passcode fallback, or
 * IPC transport in this boundary.
 */
export function createTestOnlyLocalAuthentication({ protocol } = {}) {
  exactKeys(protocol, PROTOCOL_KEYS, "LocalAuthentication protocol");
  if (typeof protocol.authenticate !== "function") {
    throw new TypeError("LocalAuthentication protocol requires authenticate()");
  }

  return Object.freeze({
    async authenticate(challenge) {
      exactKeys(challenge, CHALLENGE_KEYS, "LocalAuthentication challenge");
      if (challenge.zeroPayment !== true) throw new Error("LocalAuthentication challenge must be zero-payment");
      const result = await protocol.authenticate(Object.freeze({
        ...challenge,
        policy: "device-owner-presence",
        fallback: "deny",
      }));
      exactKeys(result, RESULT_KEYS, "LocalAuthentication result");
      if (result.status !== "authenticated") throw new Error("LocalAuthentication did not authenticate");
      if (!result.receipt || typeof result.receipt !== "object" || Array.isArray(result.receipt)) {
        throw new Error("LocalAuthentication receipt is required");
      }
      return result.receipt;
    },
  });
}

/**
 * Produce the native-helper read-back record. This is deliberately separate
 * from the receipt: no receipt fields, credential values, provider bodies, or
 * raw native error text are suitable for read-back or evidence.
 */
export function redactLocalAuthenticationReadback({ challenge, result } = {}) {
  exactKeys(challenge, CHALLENGE_KEYS, "LocalAuthentication challenge");
  exactKeys(result, RESULT_KEYS, "LocalAuthentication result");
  if (result.status !== "authenticated") throw new Error("LocalAuthentication did not authenticate");
  exactKeys(challenge.identity, IDENTITY_KEYS, "LocalAuthentication identity");
  if (challenge.zeroPayment !== true) throw new Error("LocalAuthentication challenge must be zero-payment");
  if (!result.receipt || typeof result.receipt !== "object" || Array.isArray(result.receipt)) {
    throw new Error("LocalAuthentication receipt is required");
  }
  return Object.freeze({
    status: result.status,
    policy: "device-owner-presence",
    fallback: "deny",
    capability: challenge.capability,
    candidateCommit: challenge.candidateCommit,
    requestHash: challenge.requestHash,
    identity: Object.freeze({
      account: challenge.identity.account,
      profile: challenge.identity.profile,
      operatorIdentity: challenge.identity.operatorIdentity,
      ownerIdentity: challenge.identity.ownerIdentity,
      testMode: challenge.identity.testMode,
    }),
    zeroPayment: true,
    receiptPresent: true,
  });
}
