import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {
  triageFrontierAgent,
  triageFrontierWithFallback
} from "../src/discovery/triageFrontierAgent.js";

function createDirectPage(url) {
  return {
    canonicalUrl: url,
    title: "Future Engineers Scholarship",
    sourceDomain: "example.org",
    blockers: {
      closedSignal: false,
      pastCycleSignal: false,
      explicitStageMismatchSignal: false,
      accessBlockedSignal: false
    },
    fitSignals: {
      majorMatchSignal: true,
      ethnicityMatchSignal: false,
      stateMatchSignal: true,
      stageMatchSignal: true,
      institutionSpecificSignal: false,
      specificSchoolSignal: false
    },
    pageSignals: {
      directScholarshipSignal: true,
      hubSignal: false,
      listSignal: false,
      deadlineSignal: true,
      awardAmountSignal: true,
      eligibilitySignal: true,
      applicationSignal: true,
      indirectContentSignal: false
    },
    evidenceSnippets: {
      deadlineSnippet: "Applications due March 1, 2027.",
      eligibilitySnippet: "Open to incoming engineering freshmen.",
      amountSnippet: "$2,500 scholarship award.",
      stageRestrictionSnippet: "Incoming first-year students only.",
      closedSnippet: null
    },
    childLinks: []
  };
}

test("triageFrontierAgent accepts valid model output and derives grouped queues", async () => {
  const pageBundles = [createDirectPage("https://example.org/direct")];
  const execImpl = async ({ outputPath }) => {
    await fs.writeFile(outputPath, JSON.stringify({
      decisions: [
        {
          pageId: "page_1",
          action: "advance_to_finalize",
          rationale: "Direct scholarship page with clear supporting evidence."
        }
      ]
    }), "utf8");
  };

  const result = await triageFrontierAgent({
    pageBundles,
    remainingBudget: { pages: 5, depth: 1 },
    execImpl,
    model: "test-model"
  });

  assert.deepEqual(result.decisions, [
    {
      url: "https://example.org/direct",
      action: "advance_to_finalize",
      rationale: "Direct scholarship page with clear supporting evidence."
    }
  ]);
  assert.deepEqual(result.queue, {
    advanceToFinalize: ["https://example.org/direct"],
    holdForExpansion: [],
    dropped: []
  });
  assert.equal(result.metadata.mode, "agentic");
  assert.equal(result.metadata.model, "test-model");
});

test("triageFrontierWithFallback falls back to deterministic triage on invalid model output", async () => {
  const pageBundles = [createDirectPage("https://example.org/direct")];
  const execImpl = async ({ outputPath }) => {
    await fs.writeFile(outputPath, JSON.stringify({
      decisions: []
    }), "utf8");
  };

  const result = await triageFrontierWithFallback({
    pageBundles,
    remainingBudget: { pages: 5, depth: 1 },
    execImpl,
    model: "test-model"
  });

  assert.equal(result.metadata.mode, "deterministic_fallback");
  assert.match(result.metadata.fallbackReason, /Expected 1 decisions/);
  assert.deepEqual(result.queue, {
    advanceToFinalize: ["https://example.org/direct"],
    holdForExpansion: [],
    dropped: []
  });
});

test("triageFrontierAgent guardrails prevent finalizing aggregator summaries", async () => {
  const pageBundles = [
    {
      ...createDirectPage("https://accessscholarships.com/scholarship/latinos-in-technology-scholarship"),
      sourceDomain: "accessscholarships.com",
      pageSignals: {
        directScholarshipSignal: true,
        hubSignal: false,
        listSignal: true,
        deadlineSignal: true,
        awardAmountSignal: true,
        eligibilitySignal: true,
        applicationSignal: true,
        indirectContentSignal: true,
        aggregatorSummarySignal: true,
        originalSourceLinkSignal: true
      },
      childLinks: [
        {
          url: "https://www.siliconvalleycf.org/scholarships/lit",
          anchorText: "Apply Online",
          sourceDomain: "siliconvalleycf.org",
          sameDomain: false,
          detailPathLikely: true,
          seenRecently: false
        }
      ]
    }
  ];
  const execImpl = async ({ outputPath }) => {
    await fs.writeFile(outputPath, JSON.stringify({
      decisions: [
        {
          pageId: "page_1",
          action: "advance_to_finalize",
          rationale: "Looks direct enough."
        }
      ]
    }), "utf8");
  };

  const result = await triageFrontierAgent({
    pageBundles,
    remainingBudget: { pages: 5, depth: 1 },
    execImpl,
    model: "test-model"
  });

  assert.deepEqual(result.queue, {
    advanceToFinalize: [],
    holdForExpansion: ["https://accessscholarships.com/scholarship/latinos-in-technology-scholarship"],
    dropped: []
  });
  assert.match(result.decisions[0].rationale, /aggregator summary/i);
});
