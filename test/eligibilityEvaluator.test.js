import test from "node:test";
import assert from "node:assert/strict";
import { evaluateScholarshipEligibility } from "../src/matching/eligibilityEvaluator.js";

test("evaluateScholarshipEligibility returns eligible when all constraints pass", () => {
  const result = evaluateScholarshipEligibility({
    scholarship: {
      eligibility: {
        minGpa: 3.5,
        allowedMajors: ["engineering"],
        allowedEthnicities: ["hispanic"]
      }
    },
    profile: {
      academics: { gpa: "3.8" },
      personalInfo: { intendedMajor: "engineering", ethnicity: "hispanic" }
    }
  });

  assert.equal(result.isEligible, true);
  assert.equal(result.status, "eligible");
  assert.deepEqual(result.reasons, []);
});

test("evaluateScholarshipEligibility returns reasons when constraints fail", () => {
  const result = evaluateScholarshipEligibility({
    scholarship: {
      eligibility: {
        minGpa: 3.7,
        allowedMajors: ["engineering"],
        allowedEthnicities: ["hispanic"]
      }
    },
    profile: {
      academics: { gpa: "3.2" },
      personalInfo: { intendedMajor: "history", ethnicity: "white" }
    }
  });

  assert.equal(result.isEligible, false);
  assert.equal(result.status, "ineligible");
  assert.equal(result.failedRules.length, 3);
});

test("evaluateScholarshipEligibility marks missing fields as needs_human_review", () => {
  const result = evaluateScholarshipEligibility({
    scholarship: {
      eligibility: {
        minGpa: 3.2,
        allowedMajors: ["engineering"],
        allowedEthnicities: ["hispanic"]
      }
    },
    profile: {
      academics: { gpa: null },
      personalInfo: { intendedMajor: null, ethnicity: "hispanic" }
    }
  });

  assert.equal(result.isEligible, false);
  assert.equal(result.status, "needs_human_review");
  assert.ok(result.missingRequiredInfo.some((reason) => reason.includes("Missing GPA")));
  assert.ok(result.missingRequiredInfo.some((reason) => reason.includes("Missing intended major")));
});
