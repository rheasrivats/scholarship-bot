import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { writeFile, rm } from "node:fs/promises";
import { runNoAccountMvp } from "../src/pipeline/runNoAccountMvp.js";
import { TRUSTED_SOURCE_TIERS, createScholarship } from "../src/schemas/scholarshipSchema.js";

test("runNoAccountMvp applies human overrides and reranks scholarships", async () => {
  const tempPath = path.join(os.tmpdir(), `scholarship-missing-gpa-${Date.now()}.txt`);
  const content = [
    "Name: Test Student",
    "Email: test@example.com",
    "Intended Major: engineering",
    "Ethnicity: hispanic",
    "",
    "I enjoy STEM and mentoring."
  ].join("\n");

  await writeFile(tempPath, content, "utf8");

  const scholarships = [
    createScholarship({
      id: "eng-award",
      name: "Engineering Award",
      sourceDomain: "trustedfoundation.org",
      sourceTier: TRUSTED_SOURCE_TIERS.TIER_1,
      requiresAccount: false,
      awardAmount: 5000,
      deadline: "2026-07-01",
      estimatedEffortMinutes: 30,
      eligibility: {
        minGpa: 3.2,
        allowedMajors: ["engineering"],
        allowedEthnicities: ["hispanic"]
      },
      formFields: [
        { fieldName: "full_name", sourcePath: "personalInfo.fullName" },
        { fieldName: "gpa", sourcePath: "academics.gpa" }
      ]
    })
  ];

  try {
    const before = await runNoAccountMvp({
      sessionId: "before-overrides",
      documents: [{ documentId: "doc1", filePath: tempPath }],
      scholarships,
      maxDrafts: 3
    });

    assert.equal(before.rankedScholarships.length, 1);
    assert.equal(before.needsHumanReviewScholarships.length, 0);
    assert.equal(before.drafts.length, 1);
    assert.ok(before.drafts[0].manualFields.some((f) => f.fieldName === "gpa"));

    const after = await runNoAccountMvp({
      sessionId: "after-overrides",
      documents: [{ documentId: "doc1", filePath: tempPath }],
      scholarships,
      maxDrafts: 3,
      overrides: {
        "academics.gpa": "3.85"
      }
    });

    assert.equal(after.needsHumanReviewScholarships.length, 0);
    assert.equal(after.rankedScholarships.length, 1);
    assert.equal(after.mergedProfile.academics.gpa, "3.85");
    assert.equal(after.appliedOverrides["academics.gpa"], "3.85");
  } finally {
    await rm(tempPath, { force: true });
  }
});
