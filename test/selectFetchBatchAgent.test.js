import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {
  selectFetchBatchAgent,
  selectFetchBatchWithFallback
} from "../src/discovery/selectFetchBatchAgent.js";

const SEARCH_RESULTS = [
  {
    title: "General STEM Scholarship",
    url: "https://broad.example.org/stem-scholarship",
    normalizedUrl: "https://broad.example.org/stem-scholarship",
    sourceDomain: "broad.example.org",
    providerRank: 2,
    fitScore: 6.5,
    heuristics: {
      surfaceType: "direct_likely",
      majorMatch: true,
      ethnicityMatch: false,
      stateMatch: false,
      stageMatch: true,
      negativeGraduateSignal: false,
      negativeBlogSignal: false,
      negativeDirectorySignal: false,
      institutionSpecificSignal: false,
      specificSchoolSignal: false,
      staleCycleSignal: false,
      indirectContentSignal: false,
      sameDomainAsPriorHit: false,
      seenRecently: false,
      noveltyScore: 1
    }
  },
  {
    title: "University Department Scholarships",
    url: "https://school.edu/engineering/scholarships",
    normalizedUrl: "https://school.edu/engineering/scholarships",
    sourceDomain: "school.edu",
    providerRank: 1,
    fitScore: 7.2,
    heuristics: {
      surfaceType: "hub_likely",
      majorMatch: true,
      ethnicityMatch: false,
      stateMatch: false,
      stageMatch: true,
      negativeGraduateSignal: false,
      negativeBlogSignal: false,
      negativeDirectorySignal: false,
      institutionSpecificSignal: true,
      specificSchoolSignal: true,
      staleCycleSignal: false,
      indirectContentSignal: false,
      sameDomainAsPriorHit: false,
      seenRecently: false,
      noveltyScore: 1
    }
  }
];

test("selectFetchBatchAgent accepts valid model output and maps result IDs to URLs", async () => {
  const execImpl = async ({ outputPath }) => {
    await fs.writeFile(outputPath, JSON.stringify({
      selectedResultIds: ["result_1"],
      rationale: "Choose the broader direct scholarship before the school-specific hub.",
      notes: []
    }), "utf8");
  };

  const result = await selectFetchBatchAgent({
    searchResults: SEARCH_RESULTS,
    alreadyFetchedUrls: [],
    remainingBudget: {
      pages: 2,
      fetchesThisRound: 1
    },
    runState: {
      acceptedCount: 0,
      targetAcceptedCount: 5,
      round: 1
    },
    execImpl,
    model: "test-model"
  });

  assert.deepEqual(result.selectedUrls, [
    "https://broad.example.org/stem-scholarship"
  ]);
  assert.equal(result.metadata.mode, "agentic");
  assert.equal(result.metadata.model, "test-model");
});

test("selectFetchBatchWithFallback falls back on invalid model output", async () => {
  const execImpl = async ({ outputPath }) => {
    await fs.writeFile(outputPath, JSON.stringify({
      selectedResultIds: ["result_1", "result_2"],
      rationale: "Pick both.",
      notes: []
    }), "utf8");
  };

  const result = await selectFetchBatchWithFallback({
    searchResults: SEARCH_RESULTS,
    alreadyFetchedUrls: [],
    remainingBudget: {
      pages: 2,
      fetchesThisRound: 1
    },
    runState: {
      acceptedCount: 0,
      targetAcceptedCount: 5,
      round: 1
    },
    execImpl,
    model: "test-model"
  });

  assert.equal(result.metadata.mode, "deterministic_fallback");
  assert.match(result.metadata.fallbackReason, /batch limit/i);
  assert.deepEqual(result.selectedUrls, [
    "https://broad.example.org/stem-scholarship"
  ]);
});

test("selectFetchBatchAgent accepts an intentional empty batch", async () => {
  const execImpl = async ({ outputPath }) => {
    await fs.writeFile(outputPath, JSON.stringify({
      selectedResultIds: [],
      rationale: "The remaining frontier looks low-confidence, so it is better to stop than fetch weak pages.",
      notes: ["quality_floor_applied=true"]
    }), "utf8");
  };

  const result = await selectFetchBatchAgent({
    searchResults: SEARCH_RESULTS,
    alreadyFetchedUrls: [],
    remainingBudget: {
      pages: 2,
      fetchesThisRound: 1
    },
    runState: {
      acceptedCount: 0,
      targetAcceptedCount: 5,
      round: 2
    },
    execImpl,
    model: "test-model"
  });

  assert.deepEqual(result.selectedUrls, []);
  assert.equal(result.metadata.mode, "agentic");
  assert.ok(result.notes.some((line) => /selected_count=0/.test(line)));
});
