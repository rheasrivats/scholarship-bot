import test from "node:test";
import assert from "node:assert/strict";
import { matchScholarships } from "../src/matching/matchScholarships.js";
import { TRUSTED_SOURCE_TIERS } from "../src/schemas/scholarshipSchema.js";

test("matchScholarships only hard-excludes account-required scholarships in no-account MVP", () => {
  const profile = {
    personalInfo: { intendedMajor: "engineering", ethnicity: "hispanic" },
    academics: { gpa: "3.9" },
    essays: [{ content: "I care about STEM leadership and community service." }]
  };

  const scholarships = [
    {
      id: "tier1-no-account",
      sourceTier: TRUSTED_SOURCE_TIERS.TIER_1,
      requiresAccount: false,
      awardAmount: 10000,
      profileFitScore: 0,
      essaySimilarityScore: 0,
      deadline: "2026-07-01",
      estimatedEffortMinutes: 40,
      eligibility: {
        minGpa: 3.0,
        allowedMajors: ["engineering"],
        allowedEthnicities: ["hispanic"]
      },
      essayPrompts: ["Describe your STEM leadership and community service."]
    },
    {
      id: "tier1-account",
      sourceTier: TRUSTED_SOURCE_TIERS.TIER_1,
      requiresAccount: true,
      awardAmount: 12000,
      deadline: "2026-07-01",
      estimatedEffortMinutes: 40,
      eligibility: { minGpa: 3.0, allowedMajors: [], allowedEthnicities: [] },
      essayPrompts: []
    },
    {
      id: "tier2",
      sourceTier: TRUSTED_SOURCE_TIERS.TIER_2,
      requiresAccount: false,
      awardAmount: 15000,
      deadline: "2026-07-01",
      estimatedEffortMinutes: 40,
      eligibility: { minGpa: 3.0, allowedMajors: [], allowedEthnicities: [] },
      essayPrompts: []
    }
  ];

  const result = matchScholarships({ profile, scholarships });

  assert.deepEqual(result.ranked.map((s) => s.id), ["tier2", "tier1-no-account"]);
  assert.equal(result.excluded.length, 1);
  assert.equal(result.needsHumanReview.length, 0);
  assert.ok(result.excluded.some((e) => e.scholarshipId === "tier1-account"));
});

test("matchScholarships keeps scholarships in ranking even when profile has missing fields", () => {
  const profile = {
    personalInfo: { intendedMajor: null, ethnicity: "hispanic" },
    academics: { gpa: null },
    essays: [{ content: "STEM and service." }]
  };

  const scholarships = [
    {
      id: "needs-review",
      sourceTier: TRUSTED_SOURCE_TIERS.TIER_1,
      requiresAccount: false,
      awardAmount: 12000,
      deadline: "2026-07-01",
      estimatedEffortMinutes: 40,
      eligibility: {
        minGpa: 3.0,
        allowedMajors: ["engineering"],
        allowedEthnicities: ["hispanic"]
      },
      essayPrompts: ["Describe your STEM leadership."]
    }
  ];

  const result = matchScholarships({ profile, scholarships });

  assert.equal(result.ranked.length, 1);
  assert.equal(result.excluded.length, 0);
  assert.equal(result.needsHumanReview.length, 0);
  assert.equal(result.ranked[0].id, "needs-review");
  assert.equal(result.ranked[0].profileEligibilityStatus, "needs_human_review");
});
