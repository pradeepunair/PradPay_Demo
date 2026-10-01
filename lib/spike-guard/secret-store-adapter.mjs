const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const FORBIDDEN_KEYS = /(?:secret|token|password|credential|api[_-]?key|private[_-]?key|value)/i;
const METADATA_KEYS = ["name", "present", "version"];

export const SECRET_STORE_REDACTED_MESSAGE = "Secret-store operation stopped safely; secret values are unavailable.";

export class SecretStoreContractError extends Error {
  constructor(code) {
    super(SECRET_STORE_REDACTED_MESSAGE);
    this.name = "SecretStoreContractError";
    this.code = code;
  }
}

function exactObject(value, keys, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SecretStoreContractError(code);
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...keys].sort())) throw new SecretStoreContractError(code);
}

/**
 * Local/test-only metadata port. It can prove whether a named secret is
 * configured, but intentionally has no method that can retrieve or receive a
 * secret value. Production vaults and provider clients must not be injected.
 */
export function createTestOnlySecretStoreAdapter({ readMetadata } = {}) {
  if (typeof readMetadata !== "function") throw new TypeError("readMetadata is required");

  return Object.freeze({
    async inspect(input) {
      exactObject(input, ["name"], "SECRET_NAME_INVALID");
      if (typeof input.name !== "string" || !NAME_PATTERN.test(input.name)) {
        throw new SecretStoreContractError("SECRET_NAME_INVALID");
      }
      let metadata;
      try {
        metadata = await readMetadata(Object.freeze({ name: input.name, mode: "test" }));
      } catch {
        throw new SecretStoreContractError("SECRET_STORE_UNAVAILABLE");
      }
      exactObject(metadata, METADATA_KEYS, "SECRET_METADATA_INVALID");
      if (metadata.name !== input.name || typeof metadata.present !== "boolean"
        || (metadata.version !== null && (typeof metadata.version !== "string" || metadata.version.length > 128))) {
        throw new SecretStoreContractError("SECRET_METADATA_INVALID");
      }
      return Object.freeze({ name: metadata.name, present: metadata.present, version: metadata.version });
    },
  });
}

export function redactSecretStoreError(_error) {
  return new Error(SECRET_STORE_REDACTED_MESSAGE);
}

export function assertNoSecretBearingKeys(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.test(key)) throw new SecretStoreContractError("SECRET_BEARING_FIELD_FORBIDDEN");
  }
}
