import test from "node:test";
import assert from "node:assert/strict";
import {
  stageHubLeadExtraction,
  recordHubLineageOutcomes,
  promoteHotHubReserveLeads,
  selectExpansionBatch
} from "../src/discovery/hubLineageState.js";

test("stageHubLeadExtraction queues strongest leads and backlogs reserve siblings", () => {
  const hubLeadBacklog = new Map();
  const result = stageHubLeadExtraction({
    leadExtraction: {
      leadGroups: [
        {
          sourceUrl: "https://scholarships360.org/scholarships/top-scholarships-for-college-freshmen/",
          sourceType: "aggregator_hub",
          leads: [
            { leadUrl: "https://example.org/lead-a", verificationPriority: "high", isOfficialSourceLikely: true },
            { leadUrl: "https://example.org/lead-b", verificationPriority: "medium", isOfficialSourceLikely: false },
            { leadUrl: "https://example.org/lead-c", verificationPriority: "medium", isOfficialSourceLikely: false },
            { leadUrl: "https://example.org/lead-d", verificationPriority: "low", isOfficialSourceLikely: false }
          ]
        }
      ]
    },
    expansionQueue: [],
    hubLeadBacklog,
    alreadyFetched: new Set(),
    enqueuedRound: 2,
    coldHubQueueCap: 2
  });

  assert.deepEqual(result.addedUrls, [
    "https://example.org/lead-a",
    "https://example.org/lead-b"
  ]);
  assert.deepEqual(result.backloggedUrls, [
    "https://example.org/lead-c",
    "https://example.org/lead-d"
  ]);
  assert.equal(hubLeadBacklog.get("https://scholarships360.org/scholarships/top-scholarships-for-college-freshmen/").length, 2);
});

test("recordHubLineageOutcomes heats hubs when child pages advance or hold", () => {
  const hotHubScores = new Map();
  const leadOrigins = new Map([
    ["https://example.org/lead-a", "https://hub.example.org/a"],
    ["https://example.org/lead-b", "https://hub.example.org/a"],
    ["https://example.org/lead-c", "https://hub.example.org/b"]
  ]);

  const updates = recordHubLineageOutcomes({
    fetchedUrls: [
      "https://example.org/lead-a",
      "https://example.org/lead-b",
      "https://example.org/lead-c"
    ],
    triageQueue: {
      advanceToFinalize: ["https://example.org/lead-a"],
      holdForExpansion: ["https://example.org/lead-c"]
    },
    leadOrigins,
    hotHubScores
  });

  assert.deepEqual(updates, [
    {
      parentHubUrl: "https://hub.example.org/a",
      delta: 2,
      url: "https://example.org/lead-a"
    },
    {
      parentHubUrl: "https://hub.example.org/b",
      delta: 1,
      url: "https://example.org/lead-c"
    }
  ]);
  assert.equal(hotHubScores.get("https://hub.example.org/a"), 2);
  assert.equal(hotHubScores.get("https://hub.example.org/b"), 1);
});

test("recordHubLineageOutcomes follows canonicalized page URLs back to the parent hub", () => {
  const hotHubScores = new Map();
  const leadOrigins = new Map([
    ["https://example.org/requested-skechers", "https://hub.example.org/skechers"]
  ]);

  const updates = recordHubLineageOutcomes({
    pageBundles: [
      {
        requestedUrl: "https://example.org/requested-skechers",
        canonicalUrl: "https://example.org/canonical-skechers"
      }
    ],
    triageQueue: {
      advanceToFinalize: ["https://example.org/canonical-skechers"],
      holdForExpansion: []
    },
    leadOrigins,
    hotHubScores
  });

  assert.deepEqual(updates, [
    {
      parentHubUrl: "https://hub.example.org/skechers",
      delta: 2,
      url: "https://example.org/canonical-skechers"
    }
  ]);
  assert.equal(hotHubScores.get("https://hub.example.org/skechers"), 2);
});

test("promoteHotHubReserveLeads promotes reserve siblings for hot hubs", () => {
  const hubLeadBacklog = new Map([
    ["https://hub.example.org/a", [
      {
        url: "https://example.org/lead-c",
        parentHubUrl: "https://hub.example.org/a",
        verificationPriority: "medium",
        isOfficialSourceLikely: false,
        needsSourceVerification: true,
        enqueuedRound: 2
      },
      {
        url: "https://example.org/lead-d",
        parentHubUrl: "https://hub.example.org/a",
        verificationPriority: "low",
        isOfficialSourceLikely: false,
        needsSourceVerification: true,
        enqueuedRound: 2
      }
    ]]
  ]);

  const result = promoteHotHubReserveLeads({
    expansionQueue: [],
    hubLeadBacklog,
    alreadyFetched: new Set(),
    hotHubScores: new Map([["https://hub.example.org/a", 2]]),
    maxPromotionsPerHub: 1
  });

  assert.deepEqual(result.promotedUrls, [
    "https://example.org/lead-c"
  ]);
  assert.deepEqual(result.expansionQueue.map((item) => item.url), [
    "https://example.org/lead-c"
  ]);
  assert.deepEqual(hubLeadBacklog.get("https://hub.example.org/a").map((item) => item.url), [
    "https://example.org/lead-d"
  ]);
});

test("selectExpansionBatch prioritizes hot hub lineages before cold ones", () => {
  const result = selectExpansionBatch({
    expansionQueue: [
      {
        url: "https://example.org/cold",
        parentHubUrl: "https://hub.example.org/cold",
        verificationPriority: "high",
        isOfficialSourceLikely: false,
        needsSourceVerification: false,
        enqueuedRound: 1
      },
      {
        url: "https://example.org/hot",
        parentHubUrl: "https://hub.example.org/hot",
        verificationPriority: "medium",
        isOfficialSourceLikely: false,
        needsSourceVerification: true,
        enqueuedRound: 2
      }
    ],
    hotHubScores: new Map([["https://hub.example.org/hot", 2]]),
    fetchLimit: 1
  });

  assert.deepEqual(result.selectedItems.map((item) => item.url), [
    "https://example.org/hot"
  ]);
  assert.deepEqual(result.remainingItems.map((item) => item.url), [
    "https://example.org/cold"
  ]);
});
