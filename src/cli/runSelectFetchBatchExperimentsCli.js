import fs from "node:fs/promises";
import path from "node:path";
import { selectFetchBatch } from "../discovery/selectFetchBatch.js";
import { normalizeDiscoveryUrl } from "../discovery/discoveryHistoryStore.js";

const VARIANTS = ["control", "stage_detail_first", "precision_guard", "conversion_mix", "quality_floor_mix"];
const DEFAULT_FETCHES_PER_ROUND = 6;

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function uniqueStrings(values = []) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const cleaned = cleanText(value);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(cleaned);
  }
  return output;
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function parseArgs(argv = []) {
  const args = [...argv];
  const output = {};
  while (args.length > 0) {
    const token = args.shift();
    if (token === "--core-flow") output.coreFlowPath = args.shift();
    else if (token === "--search-artifact") output.searchArtifactPath = args.shift();
    else if (token === "--out-dir") output.outDir = args.shift();
    else if (token === "--fetches") output.fetchesThisRound = Number(args.shift());
    else if (token === "--rounds") output.rounds = Number(args.shift());
  }
  return output;
}

function loadSearchResultsFromArtifact(artifact = {}) {
  if (Array.isArray(artifact?.search?.results)) return artifact.search.results;
  if (Array.isArray(artifact?.search?.topResults)) return artifact.search.topResults;
  if (Array.isArray(artifact?.results)) return artifact.results;
  throw new Error("Artifact must include search.results, search.topResults, or results");
}

async function loadSearchResults({ artifact = {}, artifactPath = "" } = {}) {
  if (artifact?.search?.resultsArtifact && artifactPath) {
    const sidecarPath = path.resolve(path.dirname(artifactPath), artifact.search.resultsArtifact);
    const sidecar = JSON.parse(await fs.readFile(sidecarPath, "utf8"));
    if (Array.isArray(sidecar?.results)) return sidecar.results;
  }
  return loadSearchResultsFromArtifact(artifact);
}

function buildKnownTriageMap(coreFlow = {}) {
  const triageByUrl = new Map();
  for (const round of Array.isArray(coreFlow?.rounds) ? coreFlow.rounds : []) {
    for (const decision of round?.triage?.decisions || []) {
      const normalizedUrl = normalizeDiscoveryUrl(decision?.url || "");
      if (!normalizedUrl) continue;
      triageByUrl.set(normalizedUrl, {
        round: round.round,
        source: round.source,
        action: decision.action,
        rationale: cleanText(decision.rationale || "")
      });
    }
  }
  return triageByUrl;
}

function batchLimit(remainingBudget = {}) {
  const fetchesThisRound = Math.max(1, Math.floor(Number(remainingBudget?.fetchesThisRound || DEFAULT_FETCHES_PER_ROUND)));
  const pages = Math.max(1, Math.floor(Number(remainingBudget?.pages || fetchesThisRound)));
  return Math.min(fetchesThisRound, pages);
}

function filterUnfetched(searchResults = [], alreadyFetchedUrls = []) {
  const alreadyFetched = new Set(
    uniqueStrings(alreadyFetchedUrls)
      .map((value) => normalizeDiscoveryUrl(value))
      .filter(Boolean)
  );
  return searchResults.filter((result) => {
    const normalizedUrl = normalizeDiscoveryUrl(result?.normalizedUrl || result?.url || "");
    return normalizedUrl && !alreadyFetched.has(normalizedUrl);
  });
}

function surfaceBonus(surfaceType = "") {
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
  const domain = baseDomain(result?.sourceDomain || "");
  if (!["scholarships360.org", "accessscholarships.com"].includes(domain)) return false;
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

function scoreResult(result = {}, variant = "control") {
  const heuristics = result?.heuristics || {};
  const risk = snippetRisk(result);
  let score = Number(result?.fitScore || 0);
  score += surfaceBonus(heuristics.surfaceType);
  score += Math.max(-0.75, Math.min(0.75, Number(heuristics.noveltyScore || 0) * 0.08));

  if (heuristics.majorMatch) score += 0.5;
  if (heuristics.ethnicityMatch) score += 0.35;
  if (heuristics.stateMatch) score += 0.25;
  if (heuristics.stageMatch) score += variant === "stage_detail_first" ? 3.5 : variant === "precision_guard" ? 2.5 : 0.75;
  else if (variant === "stage_detail_first" || variant === "precision_guard") score -= 6;

  if (isLikelyNamedDetail(result)) score += variant === "stage_detail_first" ? 4 : variant === "precision_guard" ? 3 : 0;
  if (isTrustedAggregatorDetailCandidate(result)) score += variant === "stage_detail_first" ? 4.5 : variant === "precision_guard" ? 3.5 : 0;
  if (isLikelyProgramPage(result)) score += variant === "stage_detail_first" ? 2 : variant === "precision_guard" ? 1.5 : 0;
  if (isBroadRoundup(result)) score -= variant === "stage_detail_first" ? 3.5 : variant === "precision_guard" ? 5 : 0;

  if (variant === "precision_guard") {
    if (!heuristics.stageMatch) score -= 5;
    score -= risk.risk * 1.1;
  } else {
    score -= risk.risk * 0.35;
  }

  if (heuristics.negativeGraduateSignal) score -= variant === "stage_detail_first" ? 5 : 4;
  if (heuristics.negativeBlogSignal) score -= variant === "precision_guard" ? 4 : 2;
  if (heuristics.negativeDirectorySignal) score -= variant === "precision_guard" ? 4 : variant === "stage_detail_first" ? 2.5 : 1.4;
  if (heuristics.institutionSpecificSignal) score -= 1.25;
  if (heuristics.specificSchoolSignal) score -= variant === "conversion_mix" ? 0.75 : 1.5;
  if (heuristics.staleCycleSignal) score -= 5;
  if (heuristics.indirectContentSignal) score -= variant === "precision_guard" ? 4.5 : 2.5;
  if (heuristics.seenRecently) score -= 1.5;
  if (heuristics.sameDomainAsPriorHit) score -= 0.5;

  return Number(score.toFixed(3));
}

function describeResult(result = {}, variant = "") {
  const heuristics = result?.heuristics || {};
  const reasons = [];
  if (heuristics.stageMatch) reasons.push("stage");
  if (heuristics.majorMatch) reasons.push("major");
  if (heuristics.ethnicityMatch) reasons.push("ethnicity");
  if (heuristics.stateMatch) reasons.push("state");
  if (heuristics.surfaceType) reasons.push(heuristics.surfaceType);
  if (isLikelyNamedDetail(result)) reasons.push("named-detail");
  if (isTrustedAggregatorDetailCandidate(result)) reasons.push("trusted-agg-detail");
  if (isBroadRoundup(result)) reasons.push("broad-roundup");
  if (heuristics.specificSchoolSignal) reasons.push("school-specific");
  else if (heuristics.institutionSpecificSignal) reasons.push("institution-specific");
  for (const reason of snippetRisk(result).reasons) reasons.push(reason);
  if (variant) reasons.push(`${variant}_score=${scoreResult(result, variant)}`);
  return reasons.slice(0, 8);
}

function selectByScore({ searchResults = [], remainingBudget = {}, variant = "stage_first" }) {
  const limit = batchLimit(remainingBudget);
  const candidates = searchResults
    .map((result) => ({
      result,
      score: scoreResult(result, variant)
    }))
    .sort((left, right) => (
      right.score - left.score
      || Number(left.result?.providerRank || 0) - Number(right.result?.providerRank || 0)
    ));
  const selected = [];
  const domainCounts = new Map();

  while (selected.length < limit && candidates.length > 0) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const domain = cleanText(candidate.result?.sourceDomain || "").toLowerCase();
      const adjustedScore = candidate.score - (Number(domainCounts.get(domain) || 0) * 1.25);
      if (adjustedScore > bestScore) {
        bestScore = adjustedScore;
        bestIndex = index;
      }
    }
    const [chosen] = candidates.splice(bestIndex, 1);
    if (!chosen) break;
    selected.push(chosen.result);
    const domain = cleanText(chosen.result?.sourceDomain || "").toLowerCase();
    domainCounts.set(domain, Number(domainCounts.get(domain) || 0) + 1);
  }

  return {
    selectedUrls: selected.map((result) => result.url),
    rationale: `Selected ${selected.length} URLs using ${variant} scoring.`,
    notes: [
      `candidate_count=${searchResults.length}`,
      `selected_count=${selected.length}`,
      `selected_domains=${uniqueStrings(selected.map((result) => result.sourceDomain)).join(",") || "none"}`
    ]
  };
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
  if (slot === "hub_stage") {
    return heuristics.stageMatch && ["hub_likely", "list_likely"].includes(heuristics.surfaceType) && !heuristics.specificSchoolSignal && !heuristics.staleCycleSignal && !heuristics.indirectContentSignal;
  }
  if (slot === "ethnicity_stage") {
    return heuristics.stageMatch && heuristics.ethnicityMatch && !heuristics.staleCycleSignal && !heuristics.indirectContentSignal;
  }
  if (slot === "school_stage_fallback") {
    return heuristics.stageMatch && heuristics.specificSchoolSignal && !heuristics.staleCycleSignal && !heuristics.indirectContentSignal;
  }
  if (slot === "explore") {
    return heuristics.stageMatch && !heuristics.staleCycleSignal && !heuristics.indirectContentSignal;
  }
  return false;
}

function selectSlotBalanced({ searchResults = [], remainingBudget = {} }) {
  const limit = batchLimit(remainingBudget);
  const slots = ["detail_stage", "trusted_agg_detail", "program_stage", "ethnicity_stage", "hub_stage", "explore"];
  const selected = [];
  const selectedKeys = new Set();

  for (const slot of slots) {
    if (selected.length >= limit) break;
    const candidates = searchResults
      .filter((result) => {
        const key = normalizeDiscoveryUrl(result?.normalizedUrl || result?.url || "");
        return key && !selectedKeys.has(key) && matchesSlot(result, slot);
      })
      .map((result) => ({
        result,
        score: scoreResult(result, "conversion_mix")
      }))
      .sort((left, right) => (
        right.score - left.score
        || Number(left.result?.providerRank || 0) - Number(right.result?.providerRank || 0)
      ));
    const chosen = candidates[0]?.result;
    if (!chosen) continue;
    selected.push(chosen);
    selectedKeys.add(normalizeDiscoveryUrl(chosen.normalizedUrl || chosen.url || ""));
  }

  if (selected.length < limit) {
    for (const candidate of searchResults
      .filter((result) => result?.heuristics?.stageMatch)
      .map((result) => ({ result, score: scoreResult(result, "conversion_mix") }))
      .sort((left, right) => right.score - left.score)) {
      const key = normalizeDiscoveryUrl(candidate.result?.normalizedUrl || candidate.result?.url || "");
      if (!key || selectedKeys.has(key)) continue;
      selected.push(candidate.result);
      selectedKeys.add(key);
      if (selected.length >= limit) break;
    }
  }

  return {
    selectedUrls: selected.map((result) => result.url),
    rationale: `Selected ${selected.length} URLs using a conversion-mix of detail, trusted-aggregator detail, program, ethnicity, hub, and fallback slots.`,
    notes: [
      `candidate_count=${searchResults.length}`,
      `selected_count=${selected.length}`,
      `selected_domains=${uniqueStrings(selected.map((result) => result.sourceDomain)).join(",") || "none"}`
    ]
  };
}

function selectWithQualityFloor({ searchResults = [], remainingBudget = {}, minScore = 0 } = {}) {
  const limit = batchLimit(remainingBudget);
  const candidates = searchResults
    .map((result) => ({
      result,
      score: scoreResult(result, "conversion_mix")
    }))
    .filter((candidate) => candidate.score >= minScore)
    .sort((left, right) => (
      right.score - left.score
      || Number(left.result?.providerRank || 0) - Number(right.result?.providerRank || 0)
    ));

  const selected = [];
  const domainCounts = new Map();

  while (selected.length < limit && candidates.length > 0) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const domain = cleanText(candidate.result?.sourceDomain || "").toLowerCase();
      const adjustedScore = candidate.score - (Number(domainCounts.get(domain) || 0) * 1.25);
      if (adjustedScore > bestScore) {
        bestScore = adjustedScore;
        bestIndex = index;
      }
    }
    const [chosen] = candidates.splice(bestIndex, 1);
    if (!chosen) break;
    selected.push(chosen.result);
    const domain = cleanText(chosen.result?.sourceDomain || "").toLowerCase();
    domainCounts.set(domain, Number(domainCounts.get(domain) || 0) + 1);
  }

  return {
    selectedUrls: selected.map((result) => result.url),
    rationale: selected.length > 0
      ? `Selected ${selected.length} URLs above a quality floor using conversion-mix scoring.`
      : "No search results cleared the quality floor for another fetch round.",
    notes: [
      `candidate_count=${searchResults.length}`,
      `selected_count=${selected.length}`,
      `min_score=${minScore}`,
      `selected_domains=${uniqueStrings(selected.map((result) => result.sourceDomain)).join(",") || "none"}`
    ]
  };
}

function summarizeSelection({ variant, selection = {}, searchResults = [], knownTriageByUrl = new Map() }) {
  const resultByUrl = new Map(searchResults.map((result) => [
    normalizeDiscoveryUrl(result?.normalizedUrl || result?.url || ""),
    result
  ]));
  const selected = (selection.selectedUrls || []).map((url) => {
    const normalizedUrl = normalizeDiscoveryUrl(url);
    const result = resultByUrl.get(normalizedUrl) || {};
    const heuristics = result?.heuristics || {};
    const knownTriage = knownTriageByUrl.get(normalizedUrl) || null;
    return {
      title: result?.title || "",
      url,
      domain: result?.sourceDomain || "",
      fitScore: Number(result?.fitScore || 0),
      experimentScore: variant === "control" ? null : scoreResult(result, variant),
      reasons: describeResult(result, variant === "control" ? "" : variant),
      knownTriage
    };
  });
  const selectedHeuristics = selected.map((item) => resultByUrl.get(normalizeDiscoveryUrl(item.url))?.heuristics || {});
  const knownActions = selected.map((item) => item.knownTriage?.action).filter(Boolean);
  return {
    variant,
    selectedCount: selected.length,
    selectedStageMatchCount: selectedHeuristics.filter((item) => item.stageMatch).length,
    selectedNoStageMatchCount: selectedHeuristics.filter((item) => !item.stageMatch).length,
    selectedSchoolSpecificCount: selectedHeuristics.filter((item) => item.specificSchoolSignal).length,
    selectedStaleOrIndirectCount: selectedHeuristics.filter((item) => item.staleCycleSignal || item.indirectContentSignal).length,
    knownAdvanceCount: knownActions.filter((action) => action === "advance_to_finalize").length,
    knownHoldCount: knownActions.filter((action) => action === "hold_for_expansion").length,
    knownDropCount: knownActions.filter((action) => action === "drop").length,
    selected,
    rationale: selection.rationale,
    notes: selection.notes || []
  };
}

function selectVariant({
  variant,
  searchResults = [],
  alreadyFetchedUrls = [],
  remainingBudget = {},
  runState = {}
} = {}) {
  const frontier = filterUnfetched(searchResults, alreadyFetchedUrls);
  if (frontier.length === 0) {
    return {
      selectedUrls: [],
      rationale: "No unfetched search results remain.",
      notes: ["candidate_count=0", "selected_count=0"]
    };
  }
  if (variant === "control") {
    return selectFetchBatch({
      searchResults,
      alreadyFetchedUrls,
      remainingBudget,
      runState
    });
  }
  if (variant === "conversion_mix") {
    return selectSlotBalanced({ searchResults: frontier, remainingBudget });
  }
  if (variant === "quality_floor_mix") {
    return selectWithQualityFloor({ searchResults: frontier, remainingBudget, minScore: 0 });
  }
  return selectByScore({ searchResults: frontier, remainingBudget, variant });
}

function simulateVariantRounds({
  variant,
  searchResults = [],
  knownTriageByUrl = new Map(),
  totalRounds = 1,
  fetchesThisRound = DEFAULT_FETCHES_PER_ROUND,
  targetAcceptedCount = 5
} = {}) {
  const alreadyFetchedUrls = [];
  const rounds = [];
  for (let round = 1; round <= totalRounds; round += 1) {
    const remainingPages = Math.max(0, totalRounds * fetchesThisRound - alreadyFetchedUrls.length);
    if (remainingPages <= 0) break;
    const selection = selectVariant({
      variant,
      searchResults,
      alreadyFetchedUrls,
      remainingBudget: {
        pages: remainingPages,
        fetchesThisRound
      },
      runState: {
        acceptedCount: 0,
        targetAcceptedCount,
        round
      }
    });
    const summary = summarizeSelection({
      variant,
      selection,
      searchResults,
      knownTriageByUrl
    });
    rounds.push({
      round,
      ...summary
    });
    alreadyFetchedUrls.push(...(selection.selectedUrls || []));
    if (!selection.selectedUrls?.length) break;
  }

  const selected = rounds.flatMap((round) => round.selected || []);
  const selectedHeuristics = selected.map((item) => {
    const normalizedUrl = normalizeDiscoveryUrl(item.url);
    const result = searchResults.find((candidate) => (
      normalizeDiscoveryUrl(candidate?.normalizedUrl || candidate?.url || "") === normalizedUrl
    ));
    return result?.heuristics || {};
  });
  const knownActions = selected.map((item) => item.knownTriage?.action).filter(Boolean);
  return {
    variant,
    rounds,
    totals: {
      selectedCount: selected.length,
      selectedStageMatchCount: selectedHeuristics.filter((item) => item.stageMatch).length,
      selectedNoStageMatchCount: selectedHeuristics.filter((item) => !item.stageMatch).length,
      selectedSchoolSpecificCount: selectedHeuristics.filter((item) => item.specificSchoolSignal).length,
      selectedStaleOrIndirectCount: selectedHeuristics.filter((item) => item.staleCycleSignal || item.indirectContentSignal).length,
      knownAdvanceCount: knownActions.filter((action) => action === "advance_to_finalize").length,
      knownHoldCount: knownActions.filter((action) => action === "hold_for_expansion").length,
      knownDropCount: knownActions.filter((action) => action === "drop").length,
      selectedDomains: uniqueStrings(selected.map((item) => item.domain))
    }
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.coreFlowPath && !args.searchArtifactPath) {
    throw new Error("Usage: node src/cli/runSelectFetchBatchExperimentsCli.js --core-flow data/core_flow_runs/.../core_flow.json OR --search-artifact data/search_experiments/.../control.json [--out-dir data/select_fetch_batch_experiments/run]");
  }

  const artifactPath = path.resolve(args.coreFlowPath || args.searchArtifactPath);
  const artifact = JSON.parse(await fs.readFile(artifactPath, "utf8"));
  const searchResults = await loadSearchResults({ artifact, artifactPath });
  const knownTriageByUrl = args.coreFlowPath ? buildKnownTriageMap(artifact) : new Map();
  const remainingBudget = {
    pages: Number(args.fetchesThisRound || DEFAULT_FETCHES_PER_ROUND),
    fetchesThisRound: Number(args.fetchesThisRound || DEFAULT_FETCHES_PER_ROUND)
  };
  const totalRounds = Math.max(1, Math.floor(Number(args.rounds || 1)));
  const runState = {
    acceptedCount: 0,
    targetAcceptedCount: 5,
    round: 1
  };

  const outDir = path.resolve(args.outDir || path.join(process.cwd(), "data", "select_fetch_batch_experiments", nowStamp()));
  await fs.mkdir(outDir, { recursive: true });

  const summaries = [];
  for (const variant of VARIANTS) {
    const simulation = simulateVariantRounds({
      variant,
      searchResults,
      knownTriageByUrl,
      totalRounds,
      fetchesThisRound: remainingBudget.fetchesThisRound,
      targetAcceptedCount: runState.targetAcceptedCount
    });
    summaries.push(simulation);
    await fs.writeFile(path.join(outDir, `${variant}.json`), `${JSON.stringify({
      variant,
      input: {
        artifactPath,
        searchResultCount: searchResults.length,
        remainingBudget,
        runState,
        totalRounds
      },
      summary: simulation
    }, null, 2)}\n`, "utf8");
  }

  await fs.writeFile(path.join(outDir, "summary.json"), `${JSON.stringify({
    artifactPath,
    searchResultCount: searchResults.length,
    variants: summaries
  }, null, 2)}\n`, "utf8");

  process.stdout.write(`${JSON.stringify({
    outDir,
    searchResultCount: searchResults.length,
    variants: summaries
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
  process.exit(1);
});
