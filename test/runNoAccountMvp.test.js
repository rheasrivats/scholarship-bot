import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { runNoAccountMvp } from "../src/pipeline/runNoAccountMvp.js";
import { createScholarship, TRUSTED_SOURCE_TIERS } from "../src/schemas/scholarshipSchema.js";

test("runNoAccountMvp processes documents and keeps account-required scholarships in ranking/drafts", async () => {
  const base = path.resolve(process.cwd(), "test/fixtures");
  const scholarships = [
    createScholarship({
      id: "no-account-realistic",
      name: "Realistic No-Account Scholarship",
      sourceDomain: "hispanicinliers.com",
      sourceTier: TRUSTED_SOURCE_TIERS.TIER_1,
      requiresAccount: false,
      awardAmount: 2500,
      deadline: "2026-05-30",
      estimatedEffortMinutes: 60,
      eligibility: {
        minGpa: 3.0,
        allowedMajors: ["engineering", "computer science", "mathematics"],
        allowedEthnicities: ["hispanic", "latinx"]
      },
      essayPrompts: ["Describe how you plan to contribute to your community through STEM."],
      formFields: [
        { fieldName: "full_name", sourcePath: "personalInfo.fullName" },
        { fieldName: "email", sourcePath: "personalInfo.email" },
        { fieldName: "gpa", sourcePath: "academics.gpa" }
      ]
    }),
    createScholarship({
      id: "account-required-realistic",
      name: "Realistic Account Scholarship",
      sourceDomain: "scholarshipamerica.org",
      sourceTier: TRUSTED_SOURCE_TIERS.TIER_1,
      requiresAccount: true,
      awardAmount: 5000,
      deadline: "2026-04-28",
      estimatedEffortMinutes: 90,
      eligibility: {
        minGpa: null,
        allowedMajors: [],
        allowedEthnicities: []
      },
      essayPrompts: [],
      formFields: []
    })
  ];

  const result = await runNoAccountMvp({
    sessionId: "integration-1",
    documents: [
      { documentId: "uc-doc", filePath: path.join(base, "uc_sample.txt") },
      { documentId: "private-doc", filePath: path.join(base, "private_school_sample.txt") }
    ],
    scholarships,
    maxDrafts: 3
  });

  assert.equal(result.sessionId, "integration-1");
  assert.ok(result.mergedProfile.personalInfo.fullName);
  assert.ok(result.rankedScholarships.length > 0);
  assert.ok(result.drafts.length > 0);
  assert.ok(Array.isArray(result.needsHumanReviewScholarships));

  assert.ok(result.rankedScholarships.some((s) => s.id === "account-required-realistic"));
  assert.ok(result.drafts.some((d) => d.scholarshipId === "account-required-realistic"));
  assert.ok(!result.excludedScholarships.some((s) => s.scholarshipId === "account-required-realistic"));
});
