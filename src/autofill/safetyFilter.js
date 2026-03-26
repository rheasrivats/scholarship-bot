const SENSITIVE_FIELD_NAME_PATTERNS = [
  /ssn/i,
  /social\s*security/i,
  /itin/i,
  /taxpayer/i,
  /passport/i,
  /driver'?s?\s*license/i,
  /state\s*id/i,
  /credit\s*card/i,
  /debit\s*card/i,
  /routing\s*number/i,
  /bank\s*account/i,
  /insurance\s*member\s*id/i
];

const SENSITIVE_VALUE_PATTERNS = [
  /\b\d{3}-\d{2}-\d{4}\b/, // SSN formatted
  /\b\d{9}\b/, // Generic taxpayer/routing pattern
  /\b[0-9]{13,19}\b/, // Potential payment card numbers
  /\b(?=[A-Z0-9]{6,9}\b)(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*\d)[A-Z0-9]+\b/ // Passport-like token, requires mixed alphanumeric
];

export function isSensitiveFieldName(fieldName) {
  return SENSITIVE_FIELD_NAME_PATTERNS.some((pattern) => pattern.test(fieldName));
}

export function containsSensitiveValue(value) {
  if (typeof value !== "string") {
    return false;
  }

  return SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

export function shouldBlockAutofill({ fieldName, value }) {
  return isSensitiveFieldName(fieldName) || containsSensitiveValue(value);
}

export function maskSensitiveValue(value) {
  if (!value || typeof value !== "string") {
    return value;
  }

  const tail = value.slice(-4);
  return `***${tail}`;
}
