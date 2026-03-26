import test from "node:test";
import assert from "node:assert/strict";
import { createNoAccountAutofillDraft } from "../src/autofill/noAccountAutofillAdapter.js";

test("createNoAccountAutofillDraft blocks sensitive fields and prepares review draft", () => {
  const scholarship = {
    id: "s1",
    name: "No Account Scholarship",
    sourceDomain: "example.org",
    requiresAccount: false,
    formFields: [
      { fieldName: "full_name", sourcePath: "personalInfo.fullName" },
      { fieldName: "intended_major", sourcePath: "personalInfo.intendedMajor" },
      { fieldName: "social_security_number", sourcePath: "personalInfo.ssn" }
    ]
  };

  const profile = {
    personalInfo: {
      fullName: "Alex Rivera",
      intendedMajor: "engineering",
      ssn: "123-45-6789"
    }
  };

  const draft = createNoAccountAutofillDraft({ scholarship, profile });

  assert.equal(draft.autofillFields.length, 2);
  assert.equal(draft.manualFields.length, 1);
  assert.equal(draft.manualFields[0].fieldName, "social_security_number");
  assert.equal(draft.manualFields[0].maskedPreview, "***6789");
});

test("createNoAccountAutofillDraft supports account-required scholarships and marks flag", () => {
  const draft = createNoAccountAutofillDraft({
    scholarship: {
      id: "s2",
      name: "Account Scholarship",
      sourceDomain: "example.org",
      requiresAccount: true,
      formFields: []
    },
    profile: { personalInfo: {} }
  });

  assert.equal(draft.scholarshipId, "s2");
  assert.equal(draft.requiresAccount, true);
});
