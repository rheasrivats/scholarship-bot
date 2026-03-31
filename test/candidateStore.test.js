import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  assessCandidateRisk,
  importCandidates,
  loadCandidates,
  markCandidateSubmitted,
  normalizeCandidateRecord,
  reviewCandidate
} from "../src/data/candidateStore.js";

test("assessCandidateRisk flags suspicious domains", () => {
  const risk = assessCandidateRisk({
    id: "quick-cash",
    name: "Quick Cash Scholarship",
    sourceDomain: "quickcash-scholarship.xyz",
    sourceUrl: "http://quickcash-scholarship.xyz"
  });

  assert.ok(risk.riskScore >= 50);
  assert.ok(risk.riskFlags.some((flag) => flag.includes("high_risk_tld")));
  assert.ok(risk.recommendedTier === "Tier 2" || risk.recommendedTier === "Tier 3");
});

test("normalizeCandidateRecord sets pending review fields", () => {
  const record = normalizeCandidateRecord({
    name: "Engineering Scholars Fund",
    sourceDomain: "engineeringfund.org",
    sourceUrl: "https://engineeringfund.org",
    sourceName: "Engineering Fund",
    awardAmount: 8000,
    deadline: "2026-11-01",
    eligibility: {
      minGpa: 3.2,
      allowedMajors: "engineering|computer science",
      allowedEthnicities: ""
    },
    inferredRequirements: {
      requiredMajors: "engineering|computer science",
      requiredEthnicities: "",
      requiredStates: "CA|TX",
      minAge: 16,
      maxAge: 22,
      requirementStatements: "Must be a US citizen|Diagnosed with inflammatory disease"
    },
    essayPrompts: "Prompt one|Prompt two"
  });

  assert.equal(record.status, "pending");
  assert.equal(record.name, "Engineering Scholars Fund");
  assert.deepEqual(record.eligibility.allowedMajors, ["engineering", "computer science"]);
  assert.deepEqual(record.inferredRequirements.requiredMajors, ["engineering", "computer science"]);
  assert.deepEqual(record.inferredRequirements.requiredStates, ["CA", "TX"]);
  assert.equal(record.inferredRequirements.minAge, 16);
  assert.equal(record.inferredRequirements.maxAge, 22);
  assert.deepEqual(record.inferredRequirements.requirementStatements, [
    "Must be a US citizen",
    "Diagnosed with inflammatory disease"
  ]);
  assert.deepEqual(record.essayPrompts, ["Prompt one", "Prompt two"]);
  assert.ok(typeof record.riskScore === "number");
});

test("importCandidates with replacePending refreshes pending queue and preserves reviewed records", async () => {
  const candidatePath = path.resolve(process.cwd(), "data/scholarships.candidates.json");
  const originalRaw = await fs.readFile(candidatePath, "utf8");

  try {
    const firstImport = await importCandidates([
      { name: "Pending One", sourceDomain: "example.org", sourceUrl: "https://example.org/one" },
      { name: "Pending Two", sourceDomain: "example.org", sourceUrl: "https://example.org/two" }
    ], [], { replacePending: true });

    await reviewCandidate({
      id: firstImport[0].id,
      decision: "approve",
      reviewer: "test",
      notes: "keep this one"
    });

    await importCandidates([
      { name: "Fresh Pending", sourceDomain: "example.org", sourceUrl: "https://example.org/fresh" }
    ], [], { replacePending: true });

    const after = await loadCandidates({ forceReload: true });
    assert.ok(after.some((c) => c.name === "Pending One" && c.status === "approved"));
    assert.ok(!after.some((c) => c.name === "Pending Two"));
    assert.ok(after.some((c) => c.name === "Fresh Pending" && c.status === "pending"));
  } finally {
    await fs.writeFile(candidatePath, originalRaw, "utf8");
    await loadCandidates({ forceReload: true });
  }
});

test("importCandidates with empty list and replacePending clears pending queue but preserves reviewed records", async () => {
  const candidatePath = path.resolve(process.cwd(), "data/scholarships.candidates.json");
  const originalRaw = await fs.readFile(candidatePath, "utf8");

  try {
    const firstImport = await importCandidates([
      { name: "Pending Keep", sourceDomain: "example.org", sourceUrl: "https://example.org/keep" },
      { name: "Pending Clear", sourceDomain: "example.org", sourceUrl: "https://example.org/clear" }
    ], [], { replacePending: true });

    await reviewCandidate({
      id: firstImport[0].id,
      decision: "approve",
      reviewer: "test",
      notes: "preserve approved"
    });

    const cleared = await importCandidates([], [], { replacePending: true });
    assert.deepEqual(cleared, []);

    const after = await loadCandidates({ forceReload: true });
    assert.ok(after.some((c) => c.name === "Pending Keep" && c.status === "approved"));
    assert.ok(!after.some((c) => c.name === "Pending Clear"));
    assert.ok(!after.some((c) => c.status === "pending"));
  } finally {
    await fs.writeFile(candidatePath, originalRaw, "utf8");
    await loadCandidates({ forceReload: true });
  }
});

test("markCandidateSubmitted persists submitted status and future imports do not requeue it", async () => {
  const candidatePath = path.resolve(process.cwd(), "data/scholarships.candidates.json");
  const originalRaw = await fs.readFile(candidatePath, "utf8");

  try {
    const imported = await importCandidates([
      { name: "Submitted Keep", sourceDomain: "example.org", sourceUrl: "https://example.org/submitted-keep" }
    ], [], { replacePending: true });

    const submitted = await markCandidateSubmitted({
      id: imported[0].id,
      reviewer: "test",
      notes: "user already submitted"
    });

    assert.equal(submitted.status, "submitted");

    const rerun = await importCandidates([
      { name: "Submitted Keep", sourceDomain: "example.org", sourceUrl: "https://example.org/submitted-keep" },
      { name: "Fresh Pending", sourceDomain: "example.org", sourceUrl: "https://example.org/fresh-after-submit" }
    ], [], { replacePending: true });

    assert.equal(rerun.length, 1);
    assert.equal(rerun[0].name, "Fresh Pending");

    const after = await loadCandidates({ forceReload: true });
    assert.ok(after.some((c) => c.name === "Submitted Keep" && c.status === "submitted"));
    assert.ok(after.some((c) => c.name === "Fresh Pending" && c.status === "pending"));
  } finally {
    await fs.writeFile(candidatePath, originalRaw, "utf8");
    await loadCandidates({ forceReload: true });
  }
});
