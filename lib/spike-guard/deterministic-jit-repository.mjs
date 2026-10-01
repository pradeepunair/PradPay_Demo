// Local-only deterministic repository used by WP-B3 tests and rehearsals.
// It has no network, SQL client, credential, or provider dependency.
export function createDeterministicJitRepository({ failure = null, binding = null } = {}) {
  const records = new Map();
  let queue = Promise.resolve();
  const state = { transactions: 0, commits: 0, rollbacks: 0 };

  const withTransaction = (work) => {
    const run = queue.then(async () => {
      state.transactions += 1;
      if (failure) throw failure;
      const pending = new Map(records);
      try {
        const result = await work(Object.freeze({ pending }));
        for (const [nonce, value] of pending) records.set(nonce, value);
        state.commits += 1;
        return result;
      } catch (error) {
        state.rollbacks += 1;
        throw error;
      }
    });
    queue = run.catch(() => undefined);
    return run;
  };

  const consumeJitNonce = async (tx, claim) => {
    if (failure) throw failure;
    const prior = tx.pending.get(claim.nonce);
    if (prior) return { status: prior.requestHash === claim.requestHash ? "duplicate" : "replay" };
    tx.pending.set(claim.nonce, Object.freeze({ requestHash: claim.requestHash, expiresAtEpoch: claim.expiresAtEpoch }));
    return { status: "consumed" };
  };

  return Object.freeze({
    state,
    records,
    withTransaction,
    consumeJitNonce,
    async readBinding() {
      if (failure) throw failure;
      return binding;
    },
  });
}
