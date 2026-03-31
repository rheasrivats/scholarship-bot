import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const CANDIDATE_FILE_PATH = path.resolve(process.cwd(), "data/scholarships.candidates.json");

let cachedCandidates = null;

const SUSPICIOUS_DOMAIN_KEYWORDS = [
  "quickcash",
  "instant",
  "easy-money",
  "free-money",
  "guaranteed"
];

const HIGH_RISK_TLDS = [".xyz", ".click", ".top", ".buzz", ".work"];

function normalizeList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }

  if (typeof value === "string") {
    return value.split("|").map((item) => item.trim()).filter(Boolean);
  }

  return [];
}

function toBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    return /^(true|1|yes)$/i.test(value.trim());
  }

  return Boolean(value);
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function assessCandidateRisk(rawCandidate, existingScholarships = []) {
  const flags = [];
  let score = 0;

  const sourceDomain = String(rawCandidate.sourceDomain || "").toLowerCase();
  const sourceUrl = String(rawCandidate.sourceUrl || "").toLowerCase();

  if (!sourceDomain) {
    flags.push("missing_source_domain");
    score += 35;
  }

  if (sourceUrl && !sourceUrl.startsWith("https://")) {
    flags.push("non_https_source_url");
    score += 20;
  }

  for (const tld of HIGH_RISK_TLDS) {
    if (sourceDomain.endsWith(tld)) {
      flags.push(`high_risk_tld:${tld}`);
      score += 35;
      break;
    }
  }

  for (const keyword of SUSPICIOUS_DOMAIN_KEYWORDS) {
    if (sourceDomain.includes(keyword)) {
      flags.push(`suspicious_keyword:${keyword}`);
      score += 30;
      break;
    }
  }

  const duplicate = existingScholarships.find((s) => s.sourceDomain === sourceDomain || s.id === rawCandidate.id);
  if (duplicate) {
    flags.push(`already_exists_in_vetted:${duplicate.id}`);
    score += 20;
  }

  if (!rawCandidate.deadline) {
    flags.push("missing_deadline");
    score += 10;
  }

  if (!rawCandidate.sourceName) {
    flags.push("missing_source_name");
    score += 8;
  }

  if (!rawCandidate.eligibility || typeof rawCandidate.eligibility !== "object") {
    flags.push("missing_eligibility_details");
    score += 8;
  }

  const boundedScore = Math.max(0, Math.min(100, score));
  const recommendedTier = boundedScore < 25 ? "Tier 1" : boundedScore < 55 ? "Tier 2" : "Tier 3";

  return {
    riskScore: boundedScore,
    riskFlags: flags,
    recommendedTier
  };
}

export function normalizeCandidateRecord(rawCandidate, existingScholarships = []) {
  if (!rawCandidate || typeof rawCandidate !== "object") {
    throw new Error("Candidate must be an object");
  }

  if (!rawCandidate.name) {
    throw new Error("Candidate missing required field: name");
  }

  if (!rawCandidate.sourceDomain) {
    throw new Error("Candidate missing required field: sourceDomain");
  }

  const id = rawCandidate.id
    ? String(rawCandidate.id).trim()
    : `${slugify(rawCandidate.name)}-${randomUUID().slice(0, 8)}`;

  const risk = assessCandidateRisk(rawCandidate, existingScholarships);

  return {
    id,
    name: String(rawCandidate.name).trim(),
    sourceDomain: String(rawCandidate.sourceDomain).trim(),
    sourceUrl: rawCandidate.sourceUrl ? String(rawCandidate.sourceUrl).trim() : "",
    sourceName: rawCandidate.sourceName ? String(rawCandidate.sourceName).trim() : "",
    requiresAccount: toBoolean(rawCandidate.requiresAccount),
    awardAmount: Number(rawCandidate.awardAmount || 0),
    deadline: rawCandidate.deadline ? String(rawCandidate.deadline).trim() : "",
    estimatedEffortMinutes: Number(rawCandidate.estimatedEffortMinutes || 30),
    eligibility: {
      minGpa: rawCandidate.eligibility?.minGpa === null || rawCandidate.eligibility?.minGpa === undefined || rawCandidate.eligibility?.minGpa === ""
        ? null
        : Number(rawCandidate.eligibility.minGpa),
      allowedMajors: normalizeList(rawCandidate.eligibility?.allowedMajors),
      allowedEthnicities: normalizeList(rawCandidate.eligibility?.allowedEthnicities)
    },
    inferredRequirements: {
      requiredMajors: normalizeList(rawCandidate.inferredRequirements?.requiredMajors),
      requiredEthnicities: normalizeList(rawCandidate.inferredRequirements?.requiredEthnicities),
      requiredStates: normalizeList(rawCandidate.inferredRequirements?.requiredStates),
      minAge: rawCandidate.inferredRequirements?.minAge === null || rawCandidate.inferredRequirements?.minAge === undefined || rawCandidate.inferredRequirements?.minAge === ""
        ? null
        : Number(rawCandidate.inferredRequirements.minAge),
      maxAge: rawCandidate.inferredRequirements?.maxAge === null || rawCandidate.inferredRequirements?.maxAge === undefined || rawCandidate.inferredRequirements?.maxAge === ""
        ? null
        : Number(rawCandidate.inferredRequirements.maxAge),
      requirementStatements: normalizeList(rawCandidate.inferredRequirements?.requirementStatements)
    },
    essayPrompts: normalizeList(rawCandidate.essayPrompts),
    formFields: Array.isArray(rawCandidate.formFields) ? rawCandidate.formFields : [],
    status: "pending",
    reviewNotes: "",
    reviewedBy: "",
    reviewedAt: "",
    createdAt: new Date().toISOString(),
    riskScore: risk.riskScore,
    riskFlags: risk.riskFlags,
    recommendedTier: risk.recommendedTier
  };
}

async function loadRawCandidates() {
  const raw = await fs.readFile(CANDIDATE_FILE_PATH, "utf8");
  const records = JSON.parse(raw);
  if (!Array.isArray(records)) {
    throw new Error("Candidate data file must contain a JSON array");
  }

  return records;
}

async function writeCandidates(records) {
  await fs.writeFile(CANDIDATE_FILE_PATH, `${JSON.stringify(records, null, 2)}\n`, "utf8");
  cachedCandidates = records;
}

export async function loadCandidates({ forceReload = false } = {}) {
  if (!forceReload && cachedCandidates) {
    return cachedCandidates;
  }

  cachedCandidates = await loadRawCandidates();
  return cachedCandidates;
}

export async function importCandidates(rawCandidates, existingScholarships = [], options = {}) {
  if (!Array.isArray(rawCandidates)) {
    throw new Error("Candidates payload must be an array");
  }

  const existing = await loadCandidates();
  const replacePending = Boolean(options.replacePending);
  if (rawCandidates.length === 0 && !replacePending) {
    throw new Error("Candidates payload must be a non-empty array unless replacePending is true");
  }
  const preserved = replacePending
    ? existing.filter((candidate) => candidate.status !== "pending")
    : existing;
  const keys = new Set();

  for (const candidate of preserved) {
    keys.add(`id:${candidate.id}`);
    if (candidate.sourceUrl) {
      keys.add(`url:${String(candidate.sourceUrl).toLowerCase()}`);
    }
    keys.add(`name_domain:${String(candidate.name).toLowerCase()}::${String(candidate.sourceDomain).toLowerCase()}`);
  }

  for (const scholarship of existingScholarships) {
    keys.add(`id:${scholarship.id}`);
    if (scholarship.sourceUrl) {
      keys.add(`url:${String(scholarship.sourceUrl).toLowerCase()}`);
    }
    keys.add(`name_domain:${String(scholarship.name).toLowerCase()}::${String(scholarship.sourceDomain).toLowerCase()}`);
  }

  const imported = [];
  for (const candidate of rawCandidates) {
    const normalized = normalizeCandidateRecord(candidate, existingScholarships);
    const dedupeKeys = [
      `id:${normalized.id}`,
      normalized.sourceUrl ? `url:${String(normalized.sourceUrl).toLowerCase()}` : "",
      `name_domain:${String(normalized.name).toLowerCase()}::${String(normalized.sourceDomain).toLowerCase()}`
    ].filter(Boolean);

    if (dedupeKeys.some((k) => keys.has(k))) {
      continue;
    }

    dedupeKeys.forEach((k) => keys.add(k));
    imported.push(normalized);
  }

  const merged = [...preserved, ...imported];
  await writeCandidates(merged);
  return imported;
}

export async function reviewCandidate({ id, decision, reviewer = "", notes = "", tierOverride = "" }) {
  const candidates = await loadCandidates();
  const idx = candidates.findIndex((candidate) => candidate.id === id);
  if (idx < 0) {
    throw new Error(`Candidate not found: ${id}`);
  }

  if (!["approve", "reject"].includes(decision)) {
    throw new Error("decision must be 'approve' or 'reject'");
  }

  const current = candidates[idx];
  const reviewed = {
    ...current,
    status: decision === "approve" ? "approved" : "rejected",
    reviewNotes: notes,
    reviewedBy: reviewer,
    reviewedAt: new Date().toISOString()
  };

  if (tierOverride) {
    reviewed.recommendedTier = tierOverride;
  }

  candidates[idx] = reviewed;
  await writeCandidates(candidates);

  return reviewed;
}

export async function markCandidateSubmitted({ id, reviewer = "", notes = "" }) {
  const candidates = await loadCandidates();
  const idx = candidates.findIndex((candidate) => candidate.id === id);
  if (idx < 0) {
    throw new Error(`Candidate not found: ${id}`);
  }

  const current = candidates[idx];
  if (current.status === "rejected") {
    throw new Error("Rejected candidates cannot be marked as submitted");
  }

  const submitted = {
    ...current,
    status: "submitted",
    reviewNotes: notes || current.reviewNotes || "",
    reviewedBy: reviewer || current.reviewedBy || "",
    reviewedAt: new Date().toISOString()
  };

  candidates[idx] = submitted;
  await writeCandidates(candidates);

  return submitted;
}

export function candidateToScholarshipRecord(candidate) {
  return {
    id: candidate.id,
    name: candidate.name,
    sourceDomain: candidate.sourceDomain,
    sourceTier: candidate.recommendedTier,
    requiresAccount: candidate.requiresAccount,
    awardAmount: candidate.awardAmount,
    deadline: candidate.deadline,
    estimatedEffortMinutes: candidate.estimatedEffortMinutes,
    eligibility: candidate.eligibility,
    essayPrompts: candidate.essayPrompts,
    formFields: candidate.formFields,
    sourceName: candidate.sourceName,
    sourceUrl: candidate.sourceUrl,
    verifiedAt: candidate.reviewedAt ? candidate.reviewedAt.slice(0, 10) : "",
    notes: candidate.reviewNotes
  };
}

export function getCandidatesDataFilePath() {
  return CANDIDATE_FILE_PATH;
}
