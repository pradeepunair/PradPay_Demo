function typeMatches(value, type) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function resolveReference(root, reference) {
  if (!reference.startsWith("#/$defs/")) throw new Error("Only local vendored schema references are supported");
  const name = reference.slice("#/$defs/".length);
  const schema = root.$defs?.[name];
  if (!schema) throw new Error(`Unknown vendored schema reference: ${name}`);
  return schema;
}

function sameValue(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => sameValue(item, right[index]));
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key, index) => key === rightKeys[index] && sameValue(left[key], right[key]));
  }
  return false;
}

function validFormat(value, format) {
  if (format === "date-time") {
    if (typeof value !== "string") return false;
    const match = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/.exec(value);
    if (!match) return false;
    const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] = match;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return month >= 1
      && month <= 12
      && day >= 1
      && day <= days[month - 1]
      && Number(hourText) <= 23
      && Number(minuteText) <= 59
      && Number(secondText) <= 60
      && (offsetHourText === undefined || (Number(offsetHourText) <= 23 && Number(offsetMinuteText) <= 59));
  }
  if (format === "email") return typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  if (format === "uri") {
    try {
      const parsed = new URL(value);
      return Boolean(parsed.protocol);
    } catch {
      return false;
    }
  }
  return true;
}

function collectErrors(root, schema, value, path) {
  if (schema.$ref) return collectErrors(root, resolveReference(root, schema.$ref), value, path);

  const errors = [];
  for (const branch of schema.allOf ?? []) errors.push(...collectErrors(root, branch, value, path));
  if (schema.if) {
    const conditionMatches = collectErrors(root, schema.if, value, path).length === 0;
    if (conditionMatches && schema.then) errors.push(...collectErrors(root, schema.then, value, path));
    if (!conditionMatches && schema.else) errors.push(...collectErrors(root, schema.else, value, path));
  }
  if (schema.anyOf && !schema.anyOf.some((branch) => collectErrors(root, branch, value, path).length === 0)) {
    errors.push(`${path} must match at least one allowed schema`);
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((branch) => collectErrors(root, branch, value, path).length === 0).length;
    if (matches !== 1) errors.push(`${path} must match exactly one allowed schema`);
  }
  if (schema.not && collectErrors(root, schema.not, value, path).length === 0) errors.push(`${path} uses a disallowed shape`);

  if (schema.const !== undefined && !sameValue(value, schema.const)) errors.push(`${path} must equal the required constant`);
  if (schema.enum && !schema.enum.some((candidate) => sameValue(value, candidate))) errors.push(`${path} is not an allowed value`);

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => typeMatches(value, type))) {
      errors.push(`${path} must be ${types.join(" or ")}`);
      return errors;
    }
  }

  if (typeof value === "string") {
    const length = Array.from(value).length;
    if (schema.minLength !== undefined && length < schema.minLength) errors.push(`${path} is too short`);
    if (schema.maxLength !== undefined && length > schema.maxLength) errors.push(`${path} is too long`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path} has an invalid format`);
    if (schema.format && !validFormat(value, schema.format)) errors.push(`${path} has an invalid ${schema.format} format`);
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path} is below the minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path} exceeds the maximum`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) errors.push(`${path} must exceed the minimum`);
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) errors.push(`${path} must be below the maximum`);
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path} has too few items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path} has too many items`);
    if (schema.uniqueItems && value.some((item, index) => value.slice(0, index).some((prior) => sameValue(item, prior)))) errors.push(`${path} must contain unique items`);
    if (schema.items) value.forEach((item, index) => errors.push(...collectErrors(root, schema.items, item, `${path}[${index}]`)));
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const properties = schema.properties ?? {};
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) errors.push(`${path}.${required} is required`);
    }
    for (const [key, child] of Object.entries(value)) {
      if (properties[key]) errors.push(...collectErrors(root, properties[key], child, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${key} is not supported`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        errors.push(...collectErrors(root, schema.additionalProperties, child, `${path}.${key}`));
      }
    }
  }

  return errors;
}

export function validateAgainstVendoredSchema(root, definition, value) {
  const schema = root.$defs?.[definition];
  if (!schema) throw new Error(`Unknown vendored schema definition: ${definition}`);
  const errors = collectErrors(root, schema, value, "$");
  return { valid: errors.length === 0, errors };
}
