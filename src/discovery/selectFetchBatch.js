import { normalizeDiscoveryUrl } from "./discoveryHistoryStore.js";

const DEFAULT_FETCHES_PER_ROUND = 6;
const QUALITY_FLOOR_SCORE = 0;
const EXPLORATION_FLOOR_SCORE = -6;

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function uniqueStrings(values) {
  const seen = new Set();
  const output = [];
  for (const value of values || []) {
    const cleaned = cleanText(value);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(cleaned);
  }
  return output;
}

function clampPositiveInteger(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.max(1, Math.floor(numeric));
}

function computeBatchLimit(remainingBudget = {}) {
  const fetchesThisRound = clampPositiveInteger(remainingBudget?.fetchesThisRound, DEFAULT_FETCHES_PER_ROUND);
  const remainingPages = clampPositiveInteger(remainingBudget?.pages, fetchesThisRound);
  return Math.max(1, Math.min(fetchesThisRound, remainingPages));
}

function surfaceTypeBonus(surfaceType = "") {
  if (surfaceType === "direct_likely") return 1.25;
  if (surfaceType === "hub_likely") return 0.7;
  if (surfaceType === "list_likely") return -0.2;
  return 0;
}

function resultText(result = {}) {
  return cleanText(`${result?.title || ""} ${result?.snippet || ""} ${result?.url || ""}`).toLowerCase();
}

function baseDomain(value = "") {
  const parts = cleanText(value).toLowerCase().split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  return parts.slice(-2).join(".");
}

function isTrustedAggregatorDomain(value = "") {
  return ["scholarships360.org", "accessscholarships.com"].includes(baseDomain(value));
}

function isBroadRoundup(result = {}) {
  const text = resultText(result);
  return /\b(top|best|\d{2,}|list of|scholarships for|scholarship directory|scholarships by|roundup)\b/.test(text)
    || /\bscholarships\b/.test(cleanText(result?.title || "").toLowerCase());
}

function isLikelyNamedDetail(result = {}) {
  const title = cleanText(result?.title || "");
  const heuristics = result?.heuristics || {};
  const text = resultText(result);
  if (!/\b(scholarship|award|grant|fellowship)\b/i.test(title)) return false;
  if (/\bscholarships\b/i.test(title)) return false;
  if (/\b(top|best|\d{2,}|directory|blog)\b/i.test(title)) return false;
  if (heuristics.surfaceType === "direct_likely") return true;
  return /\b(application deadline|winner announcement|verified by|reviewed by|offered by)\b/.test(text);
}

function isTrustedAggregatorDetailCandidate(result = {}) {
  if (!isTrustedAggregatorDomain(result?.sourceDomain || "")) return false;
  if (!isLikelyNamedDetail(result)) return false;
  return /\b(verified by|reviewed by|offered by|application deadline|winner announcement)\b/.test(resultText(result));
}

function isLikelyProgramPage(result = {}) {
  const title = cleanText(result?.title || "");
  const heuristics = result?.heuristics || {};
  if (/\b(scholarship program|scholarship)\b/i.test(title) && !/\bscholarships\b/i.test(title)) return true;
  return heuristics.surfaceType === "direct_likely" && !heuristics.negativeDirectorySignal;
}

function snippetRisk(result = {}) {
  const text = cleanText(`${result?.title || ""} ${result?.snippet || ""}`).toLowerCase();
  let risk = 0;
  const reasons = [];
  if (/\b(third|fourth)[- ]year\b|\bjunior|senior year\b/.test(text) && !/\bhigh school senior|incoming freshman|freshman\b/.test(text)) {
    risk += 5;
    reasons.push("wrong-stage snippet risk");
  }
  if (/\b(application is closed|applications are closed|application closed|deadline has passed|no longer accepting)\b/.test(text)) {
    risk += 6;
    reasons.push("closed snippet risk");
  }
  if (/\bgraduate fellowship|graduate fellowships|master'?s|phd\b/.test(text) && !/\bhigh school senior|incoming freshman|freshman\b/.test(text)) {
    risk += 4;
    reasons.push("graduate snippet risk");
  }
  if (/\b0 results\b|\bscholarship finder\b|\buse our scholarship finder\b/.test(text)) {
    risk += 3;
    reasons.push("generic finder risk");
  }
  return { risk, reasons };
}

function computeCandidateScore(result) {
  const heuristics = result?.heuristics || {};
  const risk = snippetRisk(result);
  let score = Number(result?.fitScore || 0);

  score += surfaceTypeBonus(heuristics.surfaceType);
  score += Math.max(-0.75, Math.min(0.75, Number(heuristics.noveltyScore || 0) * 0.08));

  if (heuristics.majorMatch) score += 0.5;
  if (heuristics.ethnicityMatch) score += 0.35;
  if (heuristics.stateMatch) score += 0.25;
  if (heuristics.stageMatch) score += 0.75;

  if (isLikelyNamedDetail(result)) score += 1.25;
  if (isTrustedAggregatorDetailCandidate(result)) score += 1.25;
  if (isLikelyProgramPage(result)) score += 0.8;
  if (isBroadRoundup(result)) score -= 1.75;

  if (heuristics.negativeGraduateSignal) score -= 4;
  if (heuristics.negativeBlogSignal) score -= 2;
  if (heuristics.negativeDirectorySignal) score -= 1.4;
  if (heuristics.institutionSpecificSignal) score -= 1.25;
  if (heuristics.specificSchoolSignal) score -= 0.75;
  if (heuristics.staleCycleSignal) score -= 5;
  if (heuristics.indirectContentSignal) score -= 2.5;
  if (heuristics.seenRecently) score -= 1.5;
  if (heuristics.sameDomainAsPriorHit) score -= 0.5;
  score -= risk.risk * 0.35;

  return Number(score.toFixed(3));
}

function summarizeReasons(result) {
  const heuristics = result?.heuristics || {};
  const reasons = [];
  if (heuristics.majorMatch) reasons.push("major fit");
  if (heuristics.ethnicityMatch) reasons.push("ethnicity fit");
  if (heuristics.stateMatch) reasons.push("state fit");
  if (heuristics.stageMatch) reasons.push("stage fit");
  if (isLikelyNamedDetail(result)) reasons.push("named scholarship detail");
  else if (isTrustedAggregatorDetailCandidate(result)) reasons.push("trusted aggregator detail");
  else if (isTrustedAggregatorDomain(result?.sourceDomain || "") && ["hub_likely", "list_likely"].includes(heuristics.surfaceType)) reasons.push("trusted aggregator hub");
  else if (isLikelyProgramPage(result)) reasons.push("program page");
  else if (heuristics.surfaceType === "direct_likely") reasons.push("direct-looking page");
  else if (heuristics.surfaceType === "hub_likely") reasons.push("promising hub");
  if (heuristics.specificSchoolSignal) reasons.push("school-specific caution");
  else if (heuristics.institutionSpecificSignal) reasons.push("institution-specific caution");
  if (isBroadRoundup(result)) reasons.push("broad roundup caution");
  for (const reason of snippetRisk(result).reasons) reasons.push(reason);
  if (heuristics.staleCycleSignal) reasons.push("stale-cycle risk");
  if (heuristics.indirectContentSignal) reasons.push("indirect-content risk");
  if (heuristics.negativeBlogSignal) reasons.push("blog/editorial risk");
  return reasons;
}

function matchesSlot(result = {}, slot = "") {
  const heuristics = result?.heuristics || {};
  if (slot === "detail_stage") {
    return heuristics.stageMatch && isLikelyNamedDetail(result) && !heuristics.staleCycleSignal;
  }
  if (slot === "trusted_agg_detail") {
    return heuristics.stageMatch && isTrustedAggregatorDetailCandidate(result) && !heuristics.staleCycleSignal;
  }
  if (slot === "program_stage") {
    return heuristics.stageMatch && isLikelyProgramPage(result) && !isBroadRoundup(result) && !heuristics.staleCycleSignal;
  }
  if (slot === "trusted_agg_hub_stage") {
    return heuristics.stageMatch
      && isTrustedAggregatorDomain(result?.sourceDomain || "")
      && ["hub_likely", "list_likely"].includes(heuristics.surfaceType)
      && !heuristics.staleCycleSignal
      && !heuristics.indirectContentSignal;
  }
  if (slot === "ethnicity_stage") {
    return heuristics.stageMatch && heuristics.ethnicityMatch && !heuristics.staleCycleSignal && !heuristics.indirectContentSignal;
  }
  if (slot === "hub_stage") {
    return heuristics.stageMatch
      && ["hub_likely", "list_likely"].includes(heuristics.surfaceType)
      && !heuristics.specificSchoolSignal
      && !heuristics.staleCycleSignal
      && !heuristics.indirectContentSignal;
  }
  if (slot === "explore") {
    return heuristics.stageMatch && !heuristics.staleCycleSignal && !heuristics.indirectContentSignal;
  }
  return false;
}

function minScoreForSlot(slot = "") {
  if (slot === "trusted_agg_hub_stage") return EXPLORATION_FLOOR_SCORE;
  return QUALITY_FLOOR_SCORE;
}

function pickBestCandidate(candidates = [], selectedDomainCounts = new Map()) {
  let bestIndex = -1;
  let bestAdjustedScore = -Infinity;

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const domain = String(candidate?.result?.sourceDomain || "").toLowerCase();
    const sameDomainCount = Number(selectedDomainCounts.get(domain) || 0);
    const adjustedScore = candidate.score - (sameDomainCount * 1.25);
    if (adjustedScore > bestAdjustedScore) {
      bestAdjustedScore = adjustedScore;
      bestIndex = index;
    }
  }

  if (bestIndex < 0) return null;
  const [chosen] = candidates.splice(bestIndex, 1);
  if (!chosen) return null;
  return {
    ...chosen,
    adjustedScore: Number(bestAdjustedScore.toFixed(3))
  };
}

export function selectFetchBatch({
  searchResults = [],
  alreadyFetchedUrls = [],
  remainingBudget = {},
  runState = {}
} = {}) {
  const frontier = Array.isArray(searchResults) ? searchResults : [];
  if (frontier.length === 0) {
    throw new Error("searchResults must be a non-empty array");
  }

  const alreadyFetched = new Set(
    uniqueStrings(alreadyFetchedUrls)
      .map((value) => normalizeDiscoveryUrl(value))
      .filter(Boolean)
  );

  const deduped = [];
  const seenUrls = new Set();
  for (const result of frontier) {
    const normalizedUrl = normalizeDiscoveryUrl(result?.normalizedUrl || result?.url || "");
    if (!normalizedUrl || seenUrls.has(normalizedUrl) || alreadyFetched.has(normalizedUrl)) continue;
    seenUrls.add(normalizedUrl);
    deduped.push({
      ...result,
      normalizedUrl,
      sourceDomain: cleanText(result?.sourceDomain || "")
    });
  }

  const batchLimit = computeBatchLimit(remainingBudget);
  const candidates = deduped
    .map((result) => ({
      result,
      score: computeCandidateScore(result),
      reasons: summarizeReasons(result)
    }))
    .sort((left, right) => (
      (right.score || 0) - (left.score || 0)
      || (left.result?.providerRank || 0) - (right.result?.providerRank || 0)
    ));

  const selected = [];
  const selectedDomainCounts = new Map();
  const selectedKeys = new Set();
  const notes = [];

  const slotOrder = ["detail_stage", "trusted_agg_detail", "program_stage", "trusted_agg_hub_stage", "ethnicity_stage", "hub_stage", "explore"];
  for (const slot of slotOrder) {
    if (selected.length >= batchLimit) break;
    const slotCandidates = candidates.filter((candidate) => {
      const key = normalizeDiscoveryUrl(candidate?.result?.normalizedUrl || candidate?.result?.url || "");
      return key
        && !selectedKeys.has(key)
        && candidate.score >= minScoreForSlot(slot)
        && matchesSlot(candidate.result, slot);
    });
    const chosen = pickBestCandidate(slotCandidates, selectedDomainCounts);
    if (!chosen) continue;
    const domain = String(chosen.result?.sourceDomain || "").toLowerCase();
    const key = normalizeDiscoveryUrl(chosen.result?.normalizedUrl || chosen.result?.url || "");
    selected.push(chosen);
    selectedKeys.add(key);
    selectedDomainCounts.set(domain, (selectedDomainCounts.get(domain) || 0) + 1);
  }

  while (selected.length < batchLimit) {
    const fallbackCandidates = candidates.filter((candidate) => {
      const key = normalizeDiscoveryUrl(candidate?.result?.normalizedUrl || candidate?.result?.url || "");
      return key
        && !selectedKeys.has(key)
        && candidate.score >= QUALITY_FLOOR_SCORE
        && candidate?.result?.heuristics?.stageMatch;
    });
    const chosen = pickBestCandidate(fallbackCandidates, selectedDomainCounts);
    if (!chosen) break;
    const domain = String(chosen.result?.sourceDomain || "").toLowerCase();
    const key = normalizeDiscoveryUrl(chosen.result?.normalizedUrl || chosen.result?.url || "");
    selected.push(chosen);
    selectedKeys.add(key);
    selectedDomainCounts.set(domain, (selectedDomainCounts.get(domain) || 0) + 1);
  }

  const selectedUrls = selected.map((item) => item.result.url);
  const selectedDomains = uniqueStrings(selected.map((item) => item.result.sourceDomain));
  const selectedSummary = selected
    .slice(0, 3)
    .map((item) => {
      const label = cleanText(item.result?.title || item.result?.url || "");
      const reasons = item.reasons.filter((reason) => !/risk/i.test(reason)).slice(0, 2);
      return reasons.length > 0 ? `${label} (${reasons.join(", ")})` : label;
    });

  notes.push(`candidate_count=${deduped.length}`);
  notes.push(`selected_count=${selectedUrls.length}`);
  notes.push(`quality_floor=${QUALITY_FLOOR_SCORE}`);
  notes.push(`exploration_floor=${EXPLORATION_FLOOR_SCORE}`);
  notes.push(`selected_domains=${selectedDomains.join(",") || "none"}`);
  if (Number(runState?.acceptedCount || 0) < Number(runState?.targetAcceptedCount || 0)) {
    notes.push(`accepted_gap=${Math.max(0, Number(runState?.targetAcceptedCount || 0) - Number(runState?.acceptedCount || 0))}`);
  }

  return {
    selectedUrls,
    rationale: selectedUrls.length === 0
      ? "No search results cleared the quality floor for another fetch round."
      : selectedUrls.length < batchLimit
        ? `Selected ${selectedUrls.length} high-confidence URLs for the next fetch round and stopped early because the remaining frontier looked weaker. Top picks: ${selectedSummary.join("; ")}.`
        : `Selected ${selectedUrls.length} high-confidence URLs for the next fetch round using stage-first conversion slots and a quality floor. Top picks: ${selectedSummary.join("; ")}.`,
    notes
  };
}
