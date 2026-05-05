function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function clampCount(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return Math.max(0, Math.floor(fallback));
  return Math.max(0, Math.floor(numeric));
}

function clampRatio(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return Math.max(0, Math.min(1, Number(fallback) || 0));
  return Math.max(0, Math.min(1, numeric));
}

function buildDecision(action, nextStep, rationale, suggestedDirections = []) {
  return {
    action,
    nextStep,
    rationale: cleanText(rationale),
    suggestedDirections: Array.isArray(suggestedDirections)
      ? suggestedDirections.map((item) => cleanText(item)).filter(Boolean).slice(0, 5)
      : []
  };
}

function budgetsExhausted(remainingBudget = {}) {
  return (
    clampCount(remainingBudget?.searchRounds, 0) <= 0
    && clampCount(remainingBudget?.queries, 0) <= 0
    && clampCount(remainingBudget?.pages, 0) <= 0
    && clampCount(remainingBudget?.depth, 0) <= 0
  );
}

export function assessSearchProgress({
  runSummary = {},
  currentRound = {},
  frontierState = {},
  remainingBudget = {}
} = {}) {
  const acceptedCandidates = clampCount(runSummary?.acceptedCandidates, 0);
  const strongEvidenceCandidates = clampCount(runSummary?.strongEvidenceCandidates, 0);
  const targetAcceptedCandidates = Math.max(1, clampCount(runSummary?.targetAcceptedCandidates, 5) || 5);
  const advancedToFinalize = clampCount(currentRound?.advancedToFinalize, 0);
  const heldForExpansion = clampCount(currentRound?.heldForExpansion, 0);
  const remainingUnfetchedSearchResults = clampCount(frontierState?.remainingUnfetchedSearchResults, 0);
  const heldHubsReadyForExpansion = clampCount(frontierState?.heldHubsReadyForExpansion, 0);
  const selectedExpansionChildrenAvailable = clampCount(frontierState?.selectedExpansionChildrenAvailable, 0);
  const schoolSpecificPressure = clampRatio(frontierState?.schoolSpecificPressure, 0);
  const broadOpportunityPressure = clampRatio(frontierState?.broadOpportunityPressure, 0);

  const pagesRemaining = clampCount(remainingBudget?.pages, 0);
  const depthRemaining = clampCount(remainingBudget?.depth, 0);
  const queriesRemaining = clampCount(remainingBudget?.queries, 0);
  const replansRemaining = clampCount(remainingBudget?.replans, 0);
  const searchRoundsRemaining = clampCount(remainingBudget?.searchRounds, 0);

  if (acceptedCandidates >= targetAcceptedCandidates && strongEvidenceCandidates > 0) {
    return buildDecision(
      "stop",
      "stop_now",
      "Accepted candidates have reached the current target with enough strong evidence to stop this run."
    );
  }

  if (budgetsExhausted(remainingBudget) || (pagesRemaining <= 0 && queriesRemaining <= 0 && depthRemaining <= 0)) {
    return buildDecision(
      "stop",
      "stop_now",
      "Meaningful search budget is exhausted, so the run should stop."
    );
  }

  if (selectedExpansionChildrenAvailable > 0 && pagesRemaining > 0 && depthRemaining > 0) {
    return buildDecision(
      "continue",
      "expand_held_hubs",
      "Promising hub-expansion children are already selected and look like the strongest next use of fetch budget."
    );
  }

  if (
    heldHubsReadyForExpansion > 0
    && heldForExpansion > 0
    && pagesRemaining > 0
    && depthRemaining > 0
    && schoolSpecificPressure <= 0.75
  ) {
    return buildDecision(
      "continue",
      "expand_held_hubs",
      "Held hub pages still look promising enough to expand before widening the search."
    );
  }

  if (
    remainingUnfetchedSearchResults > 0
    && pagesRemaining > 0
    && (broadOpportunityPressure >= schoolSpecificPressure || schoolSpecificPressure < 0.65)
  ) {
    return buildDecision(
      "continue",
      "fetch_remaining_frontier",
      "There are still unfetched search results worth inspecting before widening the search."
    );
  }

  if (
    acceptedCandidates < targetAcceptedCandidates
    && replansRemaining > 0
    && queriesRemaining > 0
    && searchRoundsRemaining > 0
  ) {
    const suggestions = [];
    if (schoolSpecificPressure >= 0.55) {
      suggestions.push("broaden toward non-school-specific undergraduate scholarships");
      suggestions.push("search professional organizations and foundations instead of department pages");
    }
    if (broadOpportunityPressure < 0.4) {
      suggestions.push("widen to broader STEM and engineering scholarship queries");
    }
    if (advancedToFinalize <= 0) {
      suggestions.push("favor direct-detail scholarship pages over hubs in the next query batch");
    }

    return buildDecision(
      "replan",
      "widen_queries",
      "Accepted count is still below target and the remaining opportunity set looks too weak or too narrow to keep the current search pattern.",
      suggestions
    );
  }

  if (remainingUnfetchedSearchResults > 0 && pagesRemaining > 0) {
    return buildDecision(
      "continue",
      "fetch_remaining_frontier",
      "Remaining search frontier is the best available next path."
    );
  }

  return buildDecision(
    "stop",
    "stop_now",
    "The remaining opportunity set does not look strong enough to justify more rounds."
  );
}
