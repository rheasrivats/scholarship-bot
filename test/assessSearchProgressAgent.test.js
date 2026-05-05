import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {
  assessSearchProgressAgent,
  assessSearchProgressWithFallback
} from "../src/discovery/assessSearchProgressAgent.js";

const SAMPLE_INPUT = {
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
};

test("assessSearchProgressAgent accepts valid model output", async () => {
  const execImpl = async ({ outputPath }) => {
    await fs.writeFile(outputPath, JSON.stringify({
      action: "continue",
      nextStep: "expand_held_hubs",
      rationale: "Selected expansion children are already available and look stronger than the remaining frontier.",
      suggestedDirections: []
    }), "utf8");
  };

  const result = await assessSearchProgressAgent({
    ...SAMPLE_INPUT,
    execImpl,
    model: "test-model"
  });

  assert.deepEqual(result, {
    action: "continue",
    nextStep: "expand_held_hubs",
    rationale: "Selected expansion children are already available and look stronger than the remaining frontier.",
    suggestedDirections: [],
    metadata: {
      mode: "agentic",
      model: "test-model"
    }
  });
});

test("assessSearchProgressWithFallback falls back on invalid model output", async () => {
  const execImpl = async ({ outputPath }) => {
    await fs.writeFile(outputPath, JSON.stringify({
      action: "continue",
      nextStep: "widen_queries",
      rationale: "Do both.",
      suggestedDirections: []
    }), "utf8");
  };

  const result = await assessSearchProgressWithFallback({
    ...SAMPLE_INPUT,
    execImpl,
    model: "test-model"
  });

  assert.equal(result.metadata.mode, "deterministic_fallback");
  assert.match(result.metadata.fallbackReason, /Continue action must use/i);
  assert.equal(result.action, "continue");
  assert.equal(result.nextStep, "expand_held_hubs");
});
