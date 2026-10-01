const forbiddenFragments = [
  "authorization", "bearer", "cardnumber", "credential", "hiddenreasoning",
  "merchantprivate", "password", "paymenttoken", "rawpayload", "riskrule", "secret",
];

function isForbiddenKey(key) {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return forbiddenFragments.some((forbidden) => normalized.includes(forbidden)) ||
    normalized === "apikey" || normalized === "token" || normalized.endsWith("accesstoken") ||
    normalized.endsWith("paymenttoken") || normalized.endsWith("bearertoken") ||
    normalized.endsWith("pan") || normalized.endsWith("cvv") || normalized.endsWith("cvc");
}

function passesLuhn(value) {
  let sum = 0;
  let doubleDigit = false;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    let digit = Number(value[index]);
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

function isSensitiveString(value) {
  if (/\bBearer\s+\S+/i.test(value)) return true;
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(value)) return true;
  if (/\b(?:[a-z]{2,12}_(?:live|test)|whsec|tok|pm|src)_[A-Za-z0-9_-]{4,}\b/i.test(value)) return true;
  if (/\b(?:AKIA[0-9A-Z]{16}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/.test(value)) return true;
  if (/\b(?:api[-_ ]?key|password|secret|access[-_ ]?token)\s*[:=]\s*\S+/i.test(value)) return true;
  if (/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/.test(value)) return true;
  const digits = value.replace(/[ -]/g, "");
  return /^\d{13,19}$/.test(digits) && passesLuhn(digits);
}

export function assertSafeEventPayload(value, path = "safePayload", depth = 0) {
  if (depth > 12) throw new TypeError(`${path} exceeds maximum nesting depth`);
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError(`${path} must contain only finite numbers`);
  }
  if (typeof value === "string" && isSensitiveString(value)) {
    throw new TypeError(`${path} contains a credential-shaped value`);
  }
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeEventPayload(item, `${path}[${index}]`, depth + 1));
    return value;
  }
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${path} must contain only JSON-compatible values`);
  }
  for (const [key, item] of Object.entries(value)) {
    if (isForbiddenKey(key)) throw new TypeError(`${path}.${key} is not permitted in a safe payload`);
    assertSafeEventPayload(item, `${path}.${key}`, depth + 1);
  }
  return value;
}
