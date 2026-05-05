import test from "node:test";
import assert from "node:assert/strict";
import { assessSearchProgress } from "../src/discovery/assessSearchProgress.js";

test("assessSearchProgress prefers expanding held hubs when selected expansion children are ready", () => {
  const result = assessSearchProgress({
    runSummary: {
      round: 2,
      queriesUsed: 4,
      pagesFetched: 15,
      acceptedCandidates: 2,
      strongEvidenceCandidates: 2,
      targetAcceptedCandidates: 5
    },
    currentRound: {
      fetchedPages: 6,
      advancedToFinalize: 1,
      heldForExpansion: 2,
      dropped: 3
    },
    frontierState: {
      remainingUnfetchedSearchResults: 8,
      heldHubsReadyForExpansion: 2,
      selectedExpansionChildrenAvailable: 4,
      schoolSpecificPressure: 0.3,
      broadOpportunityPressure: 0.4
    },
    remainingBudget: {
      searchRounds: 1,
      queries: 2,
      pages: 10,
      depth: 1,
      replans: 1
    }
  });

  assert.deepEqual(result, {
    action: "continue",
    nextStep: "expand_held_hubs",
    rationale: "Promising hub-expansion children are already selected and look like the strongest next use of fetch budget.",
    suggestedDirections: []
  });
});

test("assessSearchProgress replans when below target and the remaining opportunity set is too school-specific", () => {
  const result = assessSearchProgress({
    runSummary: {
      round: 3,
      queriesUsed: 5,
      pagesFetched: 20,
      acceptedCandidates: 1,
      strongEvidenceCandidates: 1,
      targetAcceptedCandidates: 5
    },
    currentRound: {
      fetchedPages: 6,
      advancedToFinalize: 0,
      heldForExpansion: 1,
      dropped: 5
    },
    frontierState: {
      remainingUnfetchedSearchResults: 2,
      heldHubsReadyForExpansion: 1,
      selectedExpansionChildrenAvailable: 0,
      schoolSpecificPressure: 0.8,
      broadOpportunityPressure: 0.2
    },
    remainingBudget: {
      searchRounds: 1,
      queries: 2,
      pages: 4,
      depth: 1,
      replans: 1
    }
  });

  assert.equal(result.action, "replan");
  assert.equal(result.nextStep, "widen_queries");
  assert.match(result.rationale, /below target/i);
  assert.ok(result.suggestedDirections.length >= 1);
});

test("assessSearchProgress stops when the target has been met with strong evidence", () => {
  const result = assessSearchProgress({
    runSummary: {
      round: 2,
      queriesUsed: 4,
      pagesFetched: 15,
      acceptedCandidates: 5,
      strongEvidenceCandidates: 4,
      targetAcceptedCandidates: 5
    },
    currentRound: {
      fetchedPages: 6,
      advancedToFinalize: 2,
      heldForExpansion: 0,
      dropped: 4
    },
    frontierState: {
      remainingUnfetchedSearchResults: 7,
      heldHubsReadyForExpansion: 0,
      selectedExpansionChildrenAvailable: 0,
      schoolSpecificPressure: 0.2,
      broadOpportunityPressure: 0.5
    },
    remainingBudget: {
      searchRounds: 1,
      queries: 2,
      pages: 6,
      depth: 1,
      replans: 1
    }
  });

  assert.deepEqual(result, {
    action: "stop",
    nextStep: "stop_now",
    rationale: "Accepted candidates have reached the current target with enough strong evidence to stop this run.",
    suggestedDirections: []
  });
});
