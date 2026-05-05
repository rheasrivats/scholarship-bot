#!/usr/bin/env node
import path from "node:path";
import { runNoAccountMvp } from "../pipeline/runNoAccountMvp.js";
import { candidateToScholarshipRecord, loadCandidates } from "../data/candidateStore.js";

function candidatesToCanonicalScholarships(candidates = []) {
  const rows = Array.isArray(candidates) ? candidates : [];
  const seen = new Set();
  const output = [];
  for (const candidate of rows) {
    if (!candidate || candidate.status === "rejected") continue;
    const scholarship = candidateToScholarshipRecord(candidate);
    const dedupeKeys = [
      String(scholarship.id || "").toLowerCase(),
      String(scholarship.sourceUrl || "").toLowerCase(),
      `${String(scholarship.name || "").toLowerCase()}::${String(scholarship.sourceDomain || "").toLowerCase()}`
    ].filter(Boolean);
    if (dedupeKeys.some((key) => seen.has(key))) continue;
    dedupeKeys.forEach((key) => seen.add(key));
    output.push(scholarship);
  }
  return output;
}

function parseArgs(argv) {
  const args = {
    sessionId: `session-${Date.now()}`,
    documents: []
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (token === "--session-id") {
      args.sessionId = argv[i + 1];
      i += 1;
      continue;
    }

    if (token === "--doc") {
      const raw = argv[i + 1];
      i += 1;
      const [documentId, filePath] = raw.split("=");
      if (!documentId || !filePath) {
        throw new Error("Invalid --doc format. Use --doc documentId=/absolute/or/relative/path");
      }

      args.documents.push({
        documentId,
        filePath: path.resolve(process.cwd(), filePath)
      });
    }
  }

  if (args.documents.length === 0) {
    throw new Error("At least one --doc is required");
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scholarships = candidatesToCanonicalScholarships(await loadCandidates({ forceReload: true }));

  const result = await runNoAccountMvp({
    sessionId: args.sessionId,
    documents: args.documents,
    scholarships
  });

  const output = {
    sessionId: result.sessionId,
    topScholarships: result.rankedScholarships.map((s) => ({
      id: s.id,
      name: s.name,
      awardAmount: s.awardAmount,
      profileFitScore: s.profileFitScore,
      essaySimilarityScore: s.essaySimilarityScore,
      sourceDomain: s.sourceDomain
    })),
    excludedScholarships: result.excludedScholarships,
    needsHumanReviewScholarships: result.needsHumanReviewScholarships,
    draftSummary: result.drafts.map((d) => ({
      scholarshipId: d.scholarshipId,
      autofillFields: d.autofillFields.length,
      manualFields: d.manualFields.length
    }))
  };

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
