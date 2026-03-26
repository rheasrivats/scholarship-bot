import { processSessionDocuments } from "./processSessionDocuments.js";
import { matchScholarships } from "../matching/matchScholarships.js";
import { createNoAccountAutofillDraft } from "../autofill/noAccountAutofillAdapter.js";

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function setByPath(target, path, value) {
  const parts = String(path || "").split(".").filter(Boolean);
  if (parts.length === 0) {
    return;
  }

  let cursor = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    if (!cursor[key] || typeof cursor[key] !== "object") {
      cursor[key] = {};
    }
    cursor = cursor[key];
  }

  cursor[parts[parts.length - 1]] = value;
}

function applyProfileOverrides(profile, overrides = {}) {
  const updated = deepClone(profile);
  const applied = {};

  for (const [path, rawValue] of Object.entries(overrides)) {
    const normalized = typeof rawValue === "string" ? rawValue.trim() : rawValue;
    if (normalized === undefined || normalized === null || normalized === "") {
      continue;
    }

    setByPath(updated, path, normalized);
    updated.extractionConfidence[path] = 1.0;
    updated.fieldProvenance[path] = "human_input";
    applied[path] = normalized;
  }

  return { updatedProfile: updated, appliedOverrides: applied };
}

export async function runNoAccountMvp({
  sessionId,
  documents,
  scholarships,
  maxDrafts = 5,
  overrides = {},
  enableAiEnrichment = false,
  aiTimeoutMs = 45000
}) {
  const ingestionResult = await processSessionDocuments({
    sessionId,
    documents,
    enableAiEnrichment,
    aiTimeoutMs
  });
  const { updatedProfile, appliedOverrides } = applyProfileOverrides(ingestionResult.mergedProfile, overrides);

  const matchingResult = matchScholarships({
    profile: updatedProfile,
    scholarships,
    options: {
      includeAccountRequired: true
    }
  });

  const drafts = matchingResult.ranked
    .slice(0, maxDrafts)
    .map((scholarship) => createNoAccountAutofillDraft({ scholarship, profile: updatedProfile }));

  return {
    sessionId,
    mergedProfile: updatedProfile,
    aiEnrichment: ingestionResult.aiEnrichment,
    appliedOverrides,
    rankedScholarships: matchingResult.ranked,
    excludedScholarships: matchingResult.excluded,
    needsHumanReviewScholarships: matchingResult.needsHumanReview,
    drafts
  };
}
