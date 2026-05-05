import fs from "node:fs/promises";
import path from "node:path";
import { loadLocalEnv } from "../config/loadEnv.js";
import { scholarshipWebSearch } from "../discovery/scholarshipWebSearch.js";
import { batchFetchPageBundles } from "../discovery/batchFetchPageBundles.js";
import { selectFetchBatch } from "../discovery/selectFetchBatch.js";
import { triageFrontier } from "../discovery/triageFrontier.js";
import { assessSearchProgress } from "../discovery/assessSearchProgress.js";
import { extractCandidateLeadsFromHubs } from "../discovery/extractCandidateLeadsFromHubs.js";
import { __testables } from "../discovery/discoveryService.js";
import { normalizeDiscoveryUrl } from "../discovery/discoveryHistoryStore.js";
import {
  stageHubLeadExtraction,
  recordHubLineageOutcomes,
  promoteHotHubReserveLeads,
  selectExpansionBatch
} from "../discovery/hubLineageState.js";

const { buildDiscoveryQueries } = __testables;
const DEFAULT_SEARCH_STRATEGY = "detail_phrase_mix";

const DEFAULT_PROFILE = {
  personalInfo: {
    intendedMajor: "Mechanical Engineering",
    ethnicity: "Hispanic/Latino",
    state: "California"
  },
  academics: {
    gradeLevel: "12th grade",
    gpa: 3.8
  }
};

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

function parseArgs(argv = []) {
  const args = [...argv];
  const output = {};
  while (args.length > 0) {
    const token = args.shift();
    if (token === "--out-dir") output.outDir = args.shift();
    else if (token === "--max-rounds") output.maxRounds = Number(args.shift());
    else if (token === "--max-queries") output.maxQueries = Number(args.shift());
    else if (token === "--max-results-per-query") output.maxResultsPerQuery = Number(args.shift());
  }
  return output;
}

function summarizePage(page = {}) {
  return {
    url: page.canonicalUrl || page.requestedUrl || "",
    title: page.title || "",
    blockers: page.blockers || {},
    fitSignals: page.fitSignals || {},
    pageSignals: page.pageSignals || {},
    evidenceSnippets: page.evidenceSnippets || {},
    childLinks: Array.isArray(page.childLinks) ? page.childLinks : []
  };
}

function findPageByUrl(pages = [], url = "") {
  const normalized = normalizeDiscoveryUrl(url);
  return pages.find((page) => (
    normalizeDiscoveryUrl(page?.canonicalUrl || page?.requestedUrl || "") === normalized
  ));
}

function queueSearchResults(searchResults = [], alreadyFetched = new Set()) {
  return searchResults.filter((result) => {
    const normalized = normalizeDiscoveryUrl(result?.normalizedUrl || result?.url || "");
    return normalized && !alreadyFetched.has(normalized);
  });
}

async function main() {
  loadLocalEnv();
  const args = parseArgs(process.argv.slice(2));
  const profile = DEFAULT_PROFILE;
  const studentStage = "starting_college";
  const maxRounds = Math.max(1, Number(args.maxRounds || 5));
  const maxQueries = Math.max(1, Number(args.maxQueries || 10));
  const maxResultsPerQuery = Math.max(1, Number(args.maxResultsPerQuery || 15));
  const outDir = path.resolve(args.outDir || path.join(process.cwd(), "data", "core_flow_runs", "deterministic_core_eval"));

  await fs.mkdir(outDir, { recursive: true });

  const queries = buildDiscoveryQueries({
    profile,
    studentStage,
    maxQueries,
    strategy: DEFAULT_SEARCH_STRATEGY
  });

  const search = await scholarshipWebSearch({
    queries,
    profile,
    studentStage,
    maxResultsPerQuery,
    queryFamily: "mixed_stage_safe",
    runContext: { round: 1 }
  });

  const alreadyFetched = new Set();
  const finalizable = [];
  const rounds = [];
  let expansionQueue = [];
  const hotHubScores = new Map();
  const hubLeadBacklog = new Map();
  const leadOrigins = new Map();
  let lastProgressDecision = null;

  for (let round = 1; round <= maxRounds; round += 1) {
    const remainingBudget = {
      pages: Math.max(0, 18 - alreadyFetched.size),
      fetchesThisRound: 6,
      depth: 1,
      searchRounds: Math.max(0, maxRounds - round),
      queries: 0,
      replans: 0
    };

    let selectedUrls = [];
    let selection = null;
    let source = "search_frontier";

    if (lastProgressDecision?.nextStep === "expand_held_hubs" && expansionQueue.length > 0) {
      source = "hub_expansion";
      const selectedExpansion = selectExpansionBatch({
        expansionQueue,
        hotHubScores,
        fetchLimit: remainingBudget.fetchesThisRound
      });
      expansionQueue = selectedExpansion.remainingItems;
      selectedUrls = uniqueStrings(selectedExpansion.selectedItems.map((item) => item.url));
      selection = {
        selectedUrls,
        rationale: "Selected child URLs from held hubs because assess_search_progress chose expand_held_hubs, prioritizing hot hub lineages first.",
        notes: [
          `selected_count=${selectedUrls.length}`,
          `hot_hub_count=${[...hotHubScores.values()].filter((score) => score > 0).length}`
        ],
        metadata: { mode: "orchestrator" }
      };
    } else {
      const frontier = queueSearchResults(search.results, alreadyFetched);
      if (frontier.length === 0) break;
      selection = selectFetchBatch({
        searchResults: frontier,
        alreadyFetchedUrls: [...alreadyFetched],
        remainingBudget,
        runState: {
          acceptedCount: finalizable.length,
          targetAcceptedCount: 5,
          round
        }
      });
      selectedUrls = selection.selectedUrls || [];
    }

    const urlsToFetch = uniqueStrings(selectedUrls)
      .filter((url) => !alreadyFetched.has(normalizeDiscoveryUrl(url)))
      .slice(0, remainingBudget.fetchesThisRound);
    if (urlsToFetch.length === 0) break;
    urlsToFetch.forEach((url) => alreadyFetched.add(normalizeDiscoveryUrl(url)));

    const bundles = await batchFetchPageBundles({
      urls: urlsToFetch,
      profile,
      studentStage,
      runContext: { round, depth: source === "hub_expansion" ? 1 : 0 }
    });

    for (const page of bundles.pages || []) {
      const requestedNormalized = normalizeDiscoveryUrl(page?.requestedUrl || "");
      const canonicalNormalized = normalizeDiscoveryUrl(page?.canonicalUrl || "");
      const parentHubUrl = leadOrigins.get(requestedNormalized);
      if (parentHubUrl && canonicalNormalized && !leadOrigins.has(canonicalNormalized)) {
        leadOrigins.set(canonicalNormalized, parentHubUrl);
      }
    }

    const triage = triageFrontier({
      pageBundles: bundles.pages,
      remainingBudget: {
        pages: Math.max(0, remainingBudget.pages - urlsToFetch.length),
        depth: 1
      }
    });

    const hotHubUpdates = recordHubLineageOutcomes({
      fetchedUrls: urlsToFetch,
      pageBundles: bundles.pages,
      triageQueue: triage.queue,
      leadOrigins,
      hotHubScores
    });
    const promotedHubLeads = promoteHotHubReserveLeads({
      expansionQueue,
      hubLeadBacklog,
      alreadyFetched,
      hotHubScores,
      maxPromotionsPerHub: 2
    });
    expansionQueue = promotedHubLeads.expansionQueue;

    for (const url of triage.queue?.advanceToFinalize || []) {
      if (!finalizable.some((item) => normalizeDiscoveryUrl(item.url) === normalizeDiscoveryUrl(url))) {
        const page = findPageByUrl(bundles.pages, url);
        finalizable.push({
          url,
          title: page?.title || "",
          sourceRound: round,
          source
        });
      }
    }

    const expansionDecisions = [];
    for (const url of triage.queue?.holdForExpansion || []) {
      const page = findPageByUrl(bundles.pages, url);
      if (!page) continue;
      const leadExtraction = extractCandidateLeadsFromHubs({
        pageBundles: [page],
        profile,
        studentStage,
        remainingBudget: {
          pages: Math.max(0, remainingBudget.pages - urlsToFetch.length - expansionQueue.length),
          depth: 1
        },
        maxLeadsPerPage: 6,
        maxTotalLeads: 6
      });
      const stagedLeads = stageHubLeadExtraction({
        leadExtraction,
        expansionQueue,
        hubLeadBacklog,
        alreadyFetched,
        enqueuedRound: round,
        coldHubQueueCap: 2
      });
      expansionQueue = stagedLeads.expansionQueue;
      for (const group of leadExtraction.leadGroups || []) {
        for (const lead of group.leads || []) {
          const normalizedLeadUrl = normalizeDiscoveryUrl(lead?.leadUrl || "");
          if (!normalizedLeadUrl) continue;
          leadOrigins.set(normalizedLeadUrl, cleanText(group.sourceUrl || ""));
        }
      }
      const selectedLeadUrls = stagedLeads.addedUrls || [];
      expansionDecisions.push({
        hubUrl: url,
        selectedChildUrls: selectedLeadUrls,
        backloggedChildUrls: stagedLeads.backloggedUrls || [],
        leadExtraction,
        rationale: selectedLeadUrls.length > 0
          ? stagedLeads.backloggedUrls?.length
            ? "Extracted named candidate leads from the held hub, queued the strongest ones now, and kept sibling reserve leads for hot-hub follow-up."
            : "Extracted named candidate leads from the held hub for verification."
          : "No named candidate leads were extracted from the held hub."
      });
    }

    lastProgressDecision = assessSearchProgress({
      runSummary: {
        round,
        queriesUsed: queries.length,
        pagesFetched: alreadyFetched.size,
        acceptedCandidates: finalizable.length,
        strongEvidenceCandidates: finalizable.length,
        targetAcceptedCandidates: 5
      },
      currentRound: {
        fetchedPages: bundles.pages.length,
        advancedToFinalize: triage.queue?.advanceToFinalize?.length || 0,
        heldForExpansion: triage.queue?.holdForExpansion?.length || 0,
        dropped: triage.queue?.dropped?.length || 0
      },
      frontierState: {
        remainingUnfetchedSearchResults: queueSearchResults(search.results, alreadyFetched).length,
        heldHubsReadyForExpansion: triage.queue?.holdForExpansion?.length || 0,
        selectedExpansionChildrenAvailable: expansionQueue.length,
        hotHubLineagesReady: [...hotHubScores.values()].filter((score) => score > 0).length,
        schoolSpecificPressure: Number((bundles.pages.filter((page) => page.fitSignals?.specificSchoolSignal).length / Math.max(1, bundles.pages.length)).toFixed(3)),
        broadOpportunityPressure: Number((bundles.pages.filter((page) => !page.fitSignals?.specificSchoolSignal).length / Math.max(1, bundles.pages.length)).toFixed(3))
      },
      remainingBudget
    });

    rounds.push({
      round,
      source,
      selection,
      fetchedUrls: urlsToFetch,
      pageBundles: bundles.pages.map(summarizePage),
      triage,
      hotHubUpdates,
      promotedHubLeads: promotedHubLeads.promotedUrls || [],
      expansionDecisions,
      assessProgress: lastProgressDecision
    });

    if (lastProgressDecision.action === "stop") break;
    if (lastProgressDecision.nextStep === "expand_held_hubs" && expansionQueue.length === 0) {
      lastProgressDecision = { ...lastProgressDecision, nextStep: "fetch_remaining_frontier" };
    }
  }

  const output = {
    generatedAt: new Date().toISOString(),
    profile,
    studentStage,
    queries,
    search: {
      resultCount: search.results.length,
      resultsArtifact: "search_results.json",
      topResults: search.results.slice(0, 20),
      provider: search.provider,
      notes: search.notes
    },
    rounds,
    totals: {
      fetchedCount: alreadyFetched.size,
      finalizableCount: finalizable.length,
      finalizable,
      expansionQueueRemaining: expansionQueue.length
    }
  };

  await fs.writeFile(path.join(outDir, "search_results.json"), `${JSON.stringify({
    generatedAt: output.generatedAt,
    profile,
    studentStage,
    queries,
    provider: search.provider,
    notes: search.notes,
    resultCount: search.results.length,
    results: search.results
  }, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(outDir, "core_flow.json"), `${JSON.stringify(output, null, 2)}\n`, "utf8");
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
  process.exit(1);
});
