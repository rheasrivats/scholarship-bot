import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {
  decideHubExpansionAgent,
  decideHubExpansionWithFallback
} from "../src/discovery/decideHubExpansionAgent.js";

function createHubPageBundle() {
  return {
    canonicalUrl: "https://example.edu/scholarships",
    title: "Engineering Scholarships",
    sourceDomain: "example.edu",
    blockers: {
      closedSignal: false,
      pastCycleSignal: false,
      explicitStageMismatchSignal: false,
      accessBlockedSignal: false
    },
    fitSignals: {
      majorMatchSignal: true,
      stageMatchSignal: true,
      specificSchoolSignal: true
    },
    pageSignals: {
      directScholarshipSignal: false,
      hubSignal: true,
      listSignal: true,
      deadlineSignal: false,
      awardAmountSignal: true,
      eligibilitySignal: true,
      applicationSignal: true,
      indirectContentSignal: false
    },
    evidenceSnippets: {
      eligibilitySnippet: "Engineering students may apply for multiple scholarships."
    },
    childLinks: [
      {
        url: "https://example.edu/scholarships/future-engineers-award",
        anchorText: "Future Engineers Award",
        sourceDomain: "example.edu",
        sameDomain: true,
        detailPathLikely: true,
        seenRecently: false
      },
      {
        url: "https://example.edu/donate",
        anchorText: "Donate",
        sourceDomain: "example.edu",
        sameDomain: true,
        detailPathLikely: false,
        seenRecently: false
      }
    ]
  };
}

test("decideHubExpansionAgent accepts valid model output and maps child IDs back to URLs", async () => {
  const execImpl = async ({ outputPath }) => {
    await fs.writeFile(outputPath, JSON.stringify({
      expand: true,
      selectedChildren: [
        {
          childId: "child_1",
          reason: "This looks like a likely detail page for a concrete scholarship."
        }
      ],
      rejectedChildren: [
        {
          childId: "child_2",
          reason: "This looks navigational rather than scholarship-specific."
        }
      ],
      rationale: "Hub has a clear scholarship-detail child worth fetching next.",
      notes: []
    }), "utf8");
  };

  const result = await decideHubExpansionAgent({
    hubPageBundle: createHubPageBundle(),
    remainingBudget: { pages: 2, depth: 1 },
    maxChildrenToSelect: 2,
    execImpl,
    model: "test-model"
  });

  assert.equal(result.expand, true);
  assert.deepEqual(result.selectedChildUrls, [
    "https://example.edu/scholarships/future-engineers-award"
  ]);
  assert.deepEqual(result.selectedChildren, [
    {
      url: "https://example.edu/scholarships/future-engineers-award",
      reason: "This looks like a likely detail page for a concrete scholarship."
    }
  ]);
  assert.deepEqual(result.rejectedChildren, [
    {
      url: "https://example.edu/donate",
      reason: "This looks navigational rather than scholarship-specific."
    }
  ]);
  assert.equal(result.metadata.mode, "agentic");
  assert.equal(result.metadata.model, "test-model");
});

test("decideHubExpansionWithFallback falls back when the model output is invalid", async () => {
  const execImpl = async ({ outputPath }) => {
    await fs.writeFile(outputPath, JSON.stringify({
      expand: true,
      selectedChildren: [],
      rejectedChildren: [],
      rationale: "Expand it.",
      notes: []
    }), "utf8");
  };

  const result = await decideHubExpansionWithFallback({
    hubPageBundle: createHubPageBundle(),
    remainingBudget: { pages: 2, depth: 1 },
    maxChildrenToSelect: 2,
    execImpl,
    model: "test-model"
  });

  assert.equal(result.metadata.mode, "deterministic_fallback");
  assert.match(result.metadata.fallbackReason, /expand=true without selecting any child links/i);
  assert.deepEqual(result.selectedChildUrls, [
    "https://example.edu/scholarships/future-engineers-award"
  ]);
});

test("decideHubExpansionAgent guardrails prefer original-source links for aggregator summaries", async () => {
  const hubPageBundle = {
    canonicalUrl: "https://accessscholarships.com/scholarship/latinos-in-technology-scholarship",
    title: "Latinos in Technology Scholarship - Access Scholarships",
    sourceDomain: "accessscholarships.com",
    blockers: {
      closedSignal: false,
      pastCycleSignal: false,
      explicitStageMismatchSignal: false,
      accessBlockedSignal: false
    },
    fitSignals: {
      majorMatchSignal: false,
      stageMatchSignal: false,
      specificSchoolSignal: false
    },
    pageSignals: {
      directScholarshipSignal: false,
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
    evidenceSnippets: {},
    childLinks: [
      {
        url: "https://accessscholarships.com/scholarship/related-stem-award",
        anchorText: "Related STEM Award",
        sourceDomain: "accessscholarships.com",
        sameDomain: true,
        detailPathLikely: true,
        seenRecently: false
      },
      {
        url: "https://www.siliconvalleycf.org/scholarships/lit",
        anchorText: "Apply Online",
        sourceDomain: "siliconvalleycf.org",
        sameDomain: false,
        detailPathLikely: true,
        seenRecently: false
      }
    ]
  };
  const execImpl = async ({ outputPath }) => {
    await fs.writeFile(outputPath, JSON.stringify({
      expand: true,
      selectedChildren: [
        {
          childId: "child_1",
          reason: "Looks like a scholarship detail page."
        }
      ],
      rejectedChildren: [
        {
          childId: "child_2",
          reason: "Generic apply link."
        }
      ],
      rationale: "Expand the same-domain detail.",
      notes: []
    }), "utf8");
  };

  const result = await decideHubExpansionAgent({
    hubPageBundle,
    remainingBudget: { pages: 2, depth: 1 },
    maxChildrenToSelect: 2,
    execImpl,
    model: "test-model"
  });

  assert.deepEqual(result.selectedChildUrls, [
    "https://www.siliconvalleycf.org/scholarships/lit"
  ]);
  assert.match(result.rationale, /original-source/i);
  assert.ok(result.notes.includes("agent_selection_overridden_to_prefer_original_source_links"));
});
