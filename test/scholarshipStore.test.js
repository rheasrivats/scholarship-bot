import test from "node:test";
import assert from "node:assert/strict";
import { loadScholarships, normalizeScholarshipRecord } from "../src/data/scholarshipStore.js";

test("loadScholarships loads vetted dataset", async () => {
  const scholarships = await loadScholarships({ forceReload: true });
  assert.ok(Array.isArray(scholarships));
  for (const scholarship of scholarships) {
    assert.ok(scholarship.id);
    assert.ok(scholarship.name);
    assert.ok(scholarship.sourceDomain);
    assert.ok(["Tier 1", "Tier 2", "Tier 3"].includes(scholarship.sourceTier));
  }
});

test("normalizeScholarshipRecord supports pipe-delimited list fields", () => {
  const normalized = normalizeScholarshipRecord({
    id: "sample",
    name: "Sample Scholarship",
    sourceDomain: "example.org",
    sourceTier: "Tier 1",
    requiresAccount: false,
    awardAmount: 1000,
    deadline: "2026-10-01",
    estimatedEffortMinutes: 20,
    eligibility: {
      minGpa: 3.0,
      allowedMajors: "engineering|computer science",
      allowedEthnicities: "hispanic|latinx"
    },
    essayPrompts: "Prompt one|Prompt two",
    formFields: []
  });

  assert.deepEqual(normalized.eligibility.allowedMajors, ["engineering", "computer science"]);
  assert.deepEqual(normalized.eligibility.allowedEthnicities, ["hispanic", "latinx"]);
  assert.deepEqual(normalized.essayPrompts, ["Prompt one", "Prompt two"]);
});
