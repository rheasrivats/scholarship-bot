import { rankScholarships } from "./rankScholarships.js";
import { evaluateScholarshipEligibility } from "./eligibilityEvaluator.js";
import { TRUSTED_SOURCE_TIERS } from "../schemas/scholarshipSchema.js";

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function ruleMatchesValue(rule, value) {
  const normalizedRule = String(rule || "").toLowerCase().trim();
  const normalizedValue = String(value || "").toLowerCase().trim();

  if (!normalizedRule || !normalizedValue) {
    return false;
  }

  return normalizedRule === normalizedValue
    || normalizedValue.includes(normalizedRule)
    || normalizedRule.includes(normalizedValue);
}

function scoreProfileFit({ scholarship, profile }) {
  let score = 0;
  let checks = 0;

  const majorRules = scholarship.eligibility.allowedMajors;
  if (majorRules.length > 0) {
    checks += 1;
    const major = profile?.personalInfo?.intendedMajor;
    if (majorRules.some((rule) => ruleMatchesValue(rule, major))) {
      score += 1;
    }
  }

  const ethnicityRules = scholarship.eligibility.allowedEthnicities;
  if (ethnicityRules.length > 0) {
    checks += 1;
    const ethnicity = profile?.personalInfo?.ethnicity;
    if (ethnicityRules.some((rule) => ruleMatchesValue(rule, ethnicity))) {
      score += 1;
    }
  }

  const minGpa = scholarship.eligibility.minGpa;
  if (minGpa !== null && minGpa !== undefined) {
    checks += 1;
    const gpa = Number(profile?.academics?.gpa);
    if (Number.isFinite(gpa) && gpa >= minGpa) {
      score += 1;
    }
  }

  if (checks === 0) {
    return 0.5;
  }

  return Number((score / checks).toFixed(3));
}

function scoreEssaySimilarity({ scholarship, profile }) {
  if (!scholarship.essayPrompts.length || !profile?.essays?.length) {
    return 0;
  }

  const promptTokens = new Set(normalizeText(scholarship.essayPrompts.join(" ")));
  const essayTokens = new Set(normalizeText(profile.essays.map((essay) => essay.content).join(" ")));

  if (promptTokens.size === 0 || essayTokens.size === 0) {
    return 0;
  }

  let overlap = 0;
  for (const token of promptTokens) {
    if (essayTokens.has(token)) {
      overlap += 1;
    }
  }

  return Number((overlap / promptTokens.size).toFixed(3));
}

export function matchScholarships({
  profile,
  scholarships,
  options = {}
}) {
  const {
    trustedTier = TRUSTED_SOURCE_TIERS.TIER_1,
    includeAccountRequired = false
  } = options;

  const candidates = [];
  const excluded = [];
  const needsHumanReview = [];

  for (const scholarship of scholarships) {
    if (scholarship.requiresAccount && !includeAccountRequired) {
      excluded.push({
        scholarshipId: scholarship.id,
        reason: "Requires account creation/login (excluded in no-account MVP)"
      });
      continue;
    }

    const eligibility = evaluateScholarshipEligibility({ scholarship, profile });

    candidates.push({
      ...scholarship,
      profileEligibilityStatus: eligibility.status,
      profileEligibilityNotes: eligibility.reasons,
      sourceTierAllowed: scholarship.sourceTier === trustedTier,
      profileFitScore: scoreProfileFit({ scholarship, profile }),
      essaySimilarityScore: scoreEssaySimilarity({ scholarship, profile })
    });
  }

  return {
    ranked: rankScholarships(candidates),
    excluded,
    needsHumanReview
  };
}
