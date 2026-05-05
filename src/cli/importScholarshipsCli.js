#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeCandidateRecord } from "../data/candidateStore.js";

function splitCsvLine(line) {
  const out = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      out.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  out.push(current);
  return out;
}

function parseCsv(csvText) {
  const lines = csvText.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) {
    throw new Error("CSV must include header and at least one row");
  }

  const headers = splitCsvLine(lines[0]).map((h) => h.trim());

  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const row = {};
    headers.forEach((header, idx) => {
      row[header] = (cells[idx] || "").trim();
    });

    return {
      id: row.id,
      name: row.name,
      sourceDomain: row.sourceDomain,
      sourceTier: row.sourceTier,
      requiresAccount: /^(true|1|yes)$/i.test(row.requiresAccount),
      awardAmount: Number(row.awardAmount || 0),
      deadline: row.deadline,
      estimatedEffortMinutes: Number(row.estimatedEffortMinutes || 30),
      eligibility: {
        minGpa: row.minGpa ? Number(row.minGpa) : null,
        allowedMajors: row.allowedMajors || "",
        allowedEthnicities: row.allowedEthnicities || ""
      },
      essayPrompts: row.essayPrompts || "",
      formFields: [],
      sourceName: row.sourceName,
      verifiedAt: row.verifiedAt,
      sourceUrl: row.sourceUrl,
      notes: row.notes
    };
  });
}

function parseArgs(argv) {
  const args = { inFile: null, outFile: path.resolve(process.cwd(), "data/scholarships.candidates.json") };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--in") {
      args.inFile = path.resolve(process.cwd(), argv[i + 1]);
      i += 1;
      continue;
    }
    if (token === "--out") {
      args.outFile = path.resolve(process.cwd(), argv[i + 1]);
      i += 1;
      continue;
    }
  }

  if (!args.inFile) {
    throw new Error("Missing required --in path to CSV file");
  }

  return args;
}

function normalizeTier(value) {
  const tier = String(value || "").trim();
  return tier === "Tier 1" || tier === "Tier 2" || tier === "Tier 3" ? tier : "";
}

function normalizeReviewedAt(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return new Date().toISOString();
  }
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    return new Date().toISOString();
  }
  return new Date(parsed).toISOString();
}

function toImportedCandidate(row) {
  const normalized = normalizeCandidateRecord({
    id: row.id,
    name: row.name,
    sourceDomain: row.sourceDomain,
    sourceUrl: row.sourceUrl,
    sourceName: row.sourceName,
    requiresAccount: row.requiresAccount,
    awardAmount: row.awardAmount,
    deadline: row.deadline,
    estimatedEffortMinutes: row.estimatedEffortMinutes,
    eligibility: row.eligibility,
    essayPrompts: row.essayPrompts,
    formFields: row.formFields
  });
  const importedTier = normalizeTier(row.sourceTier);
  const reviewedAt = normalizeReviewedAt(row.verifiedAt);

  return {
    ...normalized,
    status: "approved",
    reviewedBy: "csv-import",
    reviewedAt,
    reviewNotes: String(row.notes || "").trim(),
    recommendedTier: importedTier || normalized.recommendedTier
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const csv = await fs.readFile(args.inFile, "utf8");
  const parsed = parseCsv(csv);
  const normalized = parsed.map(toImportedCandidate);

  await fs.writeFile(args.outFile, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  process.stdout.write(`Imported ${normalized.length} scholarship candidates to ${args.outFile}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
