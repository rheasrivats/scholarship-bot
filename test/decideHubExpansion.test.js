import test from "node:test";
import assert from "node:assert/strict";
import { decideHubExpansion } from "../src/discovery/decideHubExpansion.js";

function createHubPageBundle() {
  return {
    canonicalUrl: "https://example.edu/scholarships",
    title: "Engineering Scholarships",
    blockers: {
      closedSignal: false,
      pastCycleSignal: false,
      explicitStageMismatchSignal: false,
      accessBlockedSignal: false
    },
    fitSignals: {
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
        url: "https://example.edu/scholarships/merit-grant",
        anchorText: "Merit Grant",
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

test("decideHubExpansion selects promising child links and reports rejected ones", () => {
  const result = decideHubExpansion({
    hubPageBundle: createHubPageBundle(),
    remainingBudget: { pages: 2, depth: 1 },
    maxChildrenToSelect: 3
  });

  assert.equal(result.expand, true);
  assert.deepEqual(result.selectedChildUrls, [
    "https://example.edu/scholarships/future-engineers-award",
    "https://example.edu/scholarships/merit-grant"
  ]);
  assert.deepEqual(result.selectedChildren, [
    {
      url: "https://example.edu/scholarships/future-engineers-award",
      reason: "Looks like a likely scholarship-detail child worth fetching next."
    },
    {
      url: "https://example.edu/scholarships/merit-grant",
      reason: "Looks like a likely scholarship-detail child worth fetching next."
    }
  ]);
  assert.deepEqual(result.rejectedChildren, [
    {
      url: "https://example.edu/donate",
      reason: "Looks navigational or unrelated to scholarship detail."
    }
  ]);
});

test("decideHubExpansion declines expansion when budget is exhausted", () => {
  const result = decideHubExpansion({
    hubPageBundle: createHubPageBundle(),
    remainingBudget: { pages: 0, depth: 1 },
    maxChildrenToSelect: 2
  });

  assert.equal(result.expand, false);
  assert.deepEqual(result.selectedChildUrls, []);
  assert.match(result.rationale, /budget does not support expanding/i);
});

test("decideHubExpansion prefers offsite original-source links for aggregator summaries", () => {
  const result = decideHubExpansion({
    hubPageBundle: {
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
    },
    remainingBudget: { pages: 2, depth: 1 },
    maxChildrenToSelect: 2
  });

  assert.equal(result.expand, true);
  assert.deepEqual(result.selectedChildUrls, [
    "https://www.siliconvalleycf.org/scholarships/lit"
  ]);
  assert.deepEqual(result.selectedChildren, [
    {
      url: "https://www.siliconvalleycf.org/scholarships/lit",
      reason: "Looks like an offsite original-source path for an aggregator summary page."
    }
  ]);
  assert.deepEqual(result.rejectedChildren, [
    {
      url: "https://accessscholarships.com/scholarship/related-stem-award",
      reason: "Same-domain aggregator detail page is weaker than fetching an original-source link first."
    }
  ]);
  assert.match(result.rationale, /original-source/i);
});
