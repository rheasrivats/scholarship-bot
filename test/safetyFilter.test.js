import test from "node:test";
import assert from "node:assert/strict";
import { shouldBlockAutofill, isSensitiveFieldName, containsSensitiveValue, maskSensitiveValue } from "../src/autofill/safetyFilter.js";

test("sensitive field names are blocked", () => {
  assert.equal(isSensitiveFieldName("Social Security Number"), true);
  assert.equal(isSensitiveFieldName("passportNumber"), true);
  assert.equal(isSensitiveFieldName("intendedMajor"), false);
});

test("sensitive values are blocked", () => {
  assert.equal(containsSensitiveValue("123-45-6789"), true);
  assert.equal(containsSensitiveValue("4111111111111111"), true);
  assert.equal(containsSensitiveValue("engineering"), false);
  assert.equal(containsSensitiveValue("MISSION SENIOR HIGH SCHOOL"), false);
  assert.equal(containsSensitiveValue("A12B34C"), true);
});

test("autofill blocker combines name and value checks", () => {
  assert.equal(shouldBlockAutofill({ fieldName: "gpa", value: "3.9" }), false);
  assert.equal(shouldBlockAutofill({ fieldName: "bankAccountNumber", value: "123456789" }), true);
  assert.equal(shouldBlockAutofill({ fieldName: "notes", value: "SSN 123-45-6789" }), true);
  assert.equal(maskSensitiveValue("123-45-6789"), "***6789");
});
