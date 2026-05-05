import test from "node:test";
import assert from "node:assert/strict";
import { selectFetchBatch } from "../src/discovery/selectFetchBatch.js";

test("selectFetchBatch chooses a bounded diverse next fetch batch", () => {
  const result = selectFetchBatch({
    searchResults: [
      {
        title: "ASME Scholarship Hub 1",
        url: "https://asme.org/scholarships/a",
        normalizedUrl: "https://asme.org/scholarships/a",
        sourceDomain: "asme.org",
        providerRank: 1,
        fitScore: 7,
        heuristics: {
          surfaceType: "hub_likely",
          majorMatch: true,
          ethnicityMatch: false,
          stateMatch: false,
          stageMatch: true,
          negativeGraduateSignal: false,
          negativeBlogSignal: false,
          negativeDirectorySignal: false,
          staleCycleSignal: false,
          indirectContentSignal: false,
          sameDomainAsPriorHit: false,
          seenRecently: false,
          noveltyScore: 2
        }
      },
      {
        title: "ASME Scholarship Hub 2",
        url: "https://asme.org/scholarships/b",
        normalizedUrl: "https://asme.org/scholarships/b",
        sourceDomain: "asme.org",
        providerRank: 2,
        fitScore: 6.8,
        heuristics: {
          surfaceType: "hub_likely",
          majorMatch: true,
          ethnicityMatch: false,
          stateMatch: false,
          stageMatch: true,
          negativeGraduateSignal: false,
          negativeBlogSignal: false,
          negativeDirectorySignal: false,
          staleCycleSignal: false,
          indirectContentSignal: false,
          sameDomainAsPriorHit: true,
          seenRecently: false,
          noveltyScore: 1.5
        }
      },
      {
        title: "Latinos in Technology Scholarship",
        url: "https://www.svcf.org/scholarships/latinos-in-technology-scholarship",
        normalizedUrl: "https://www.svcf.org/scholarships/latinos-in-technology-scholarship",
        sourceDomain: "svcf.org",
        providerRank: 3,
        fitScore: 6.7,
        heuristics: {
          surfaceType: "direct_likely",
          majorMatch: true,
          ethnicityMatch: true,
          stateMatch: true,
          stageMatch: false,
          negativeGraduateSignal: false,
          negativeBlogSignal: false,
          negativeDirectorySignal: false,
          staleCycleSignal: false,
          indirectContentSignal: false,
          sameDomainAsPriorHit: false,
          seenRecently: false,
          noveltyScore: 1
        }
      }
    ],
    alreadyFetchedUrls: [],
    remainingBudget: {
      pages: 3,
      fetchesThisRound: 2
    },
    runState: {
      acceptedCount: 0,
      targetAcceptedCount: 5,
      round: 1
    }
  });

  assert.equal(result.selectedUrls.length, 2);
  assert.deepEqual(result.selectedUrls, [
    "https://asme.org/scholarships/a",
    "https://asme.org/scholarships/b"
  ]);
  assert.match(result.rationale, /quality floor|high-confidence/i);
  assert.ok(result.notes.some((line) => /accepted_gap=5/.test(line)));
});

test("selectFetchBatch skips already fetched URLs and downranks stale indirect pages", () => {
  const result = selectFetchBatch({
    searchResults: [
      {
        title: "Already fetched promising result",
        url: "https://example.org/great-scholarship",
        normalizedUrl: "https://example.org/great-scholarship",
        sourceDomain: "example.org",
        providerRank: 1,
        fitScore: 8,
        heuristics: {
          surfaceType: "direct_likely",
          majorMatch: true,
          ethnicityMatch: false,
          stateMatch: false,
          stageMatch: true,
          negativeGraduateSignal: false,
          negativeBlogSignal: false,
          negativeDirectorySignal: false,
          staleCycleSignal: false,
          indirectContentSignal: false,
          sameDomainAsPriorHit: false,
          seenRecently: false,
          noveltyScore: 1
        }
      },
      {
        title: "Old roundup",
        url: "https://blog.example.org/old-roundup",
        normalizedUrl: "https://blog.example.org/old-roundup",
        sourceDomain: "blog.example.org",
        providerRank: 2,
        fitScore: 7.5,
        heuristics: {
          surfaceType: "list_likely",
          majorMatch: true,
          ethnicityMatch: false,
          stateMatch: false,
          stageMatch: true,
          negativeGraduateSignal: false,
          negativeBlogSignal: true,
          negativeDirectorySignal: true,
          staleCycleSignal: true,
          indirectContentSignal: true,
          sameDomainAsPriorHit: false,
          seenRecently: false,
          noveltyScore: 1
        }
      },
      {
        title: "Fresh direct scholarship",
        url: "https://fresh.example.org/scholarship",
        normalizedUrl: "https://fresh.example.org/scholarship",
        sourceDomain: "fresh.example.org",
        providerRank: 3,
        fitScore: 5,
        heuristics: {
          surfaceType: "direct_likely",
          majorMatch: true,
          ethnicityMatch: false,
          stateMatch: false,
          stageMatch: true,
          negativeGraduateSignal: false,
          negativeBlogSignal: false,
          negativeDirectorySignal: false,
          staleCycleSignal: false,
          indirectContentSignal: false,
          sameDomainAsPriorHit: false,
          seenRecently: false,
          noveltyScore: 2
        }
      }
    ],
    alreadyFetchedUrls: ["https://example.org/great-scholarship"],
    remainingBudget: {
      pages: 5,
      fetchesThisRound: 2
    },
    runState: {
      acceptedCount: 1,
      targetAcceptedCount: 5,
      round: 2
    }
  });

  assert.deepEqual(result.selectedUrls, [
    "https://fresh.example.org/scholarship"
  ]);
  assert.ok(result.notes.some((line) => /selected_count=1/.test(line)));
});

test("selectFetchBatch deprioritizes school-specific results when broader options exist", () => {
  const result = selectFetchBatch({
    searchResults: [
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
    ],
    alreadyFetchedUrls: [],
    remainingBudget: {
      pages: 2,
      fetchesThisRound: 1
    },
    runState: {
      acceptedCount: 0,
      targetAcceptedCount: 5,
      round: 1
    }
  });

  assert.deepEqual(result.selectedUrls, [
    "https://broad.example.org/stem-scholarship"
  ]);
});

test("selectFetchBatch can stop early when only low-quality stage results remain", () => {
  const result = selectFetchBatch({
    searchResults: [
      {
        title: "Old Engineering Scholarships Blog",
        url: "https://blog.example.org/engineering-scholarships",
        normalizedUrl: "https://blog.example.org/engineering-scholarships",
        sourceDomain: "blog.example.org",
        providerRank: 1,
        fitScore: 1.5,
        heuristics: {
          surfaceType: "list_likely",
          majorMatch: true,
          ethnicityMatch: false,
          stateMatch: false,
          stageMatch: true,
          negativeGraduateSignal: false,
          negativeBlogSignal: true,
          negativeDirectorySignal: true,
          institutionSpecificSignal: false,
          specificSchoolSignal: false,
          staleCycleSignal: true,
          indirectContentSignal: true,
          sameDomainAsPriorHit: false,
          seenRecently: false,
          noveltyScore: 1
        }
      },
      {
        title: "Scholarships for Incoming Freshman | Scholarships",
        url: "https://school.edu/freshman-scholarships",
        normalizedUrl: "https://school.edu/freshman-scholarships",
        sourceDomain: "school.edu",
        providerRank: 2,
        fitScore: -2,
        heuristics: {
          surfaceType: "list_likely",
          majorMatch: false,
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
    ],
    alreadyFetchedUrls: [],
    remainingBudget: {
      pages: 2,
      fetchesThisRound: 2
    },
    runState: {
      acceptedCount: 0,
      targetAcceptedCount: 5,
      round: 2
    }
  });

  assert.deepEqual(result.selectedUrls, []);
  assert.match(result.rationale, /quality floor/i);
  assert.ok(result.notes.some((line) => /selected_count=0/.test(line)));
});

test("selectFetchBatch keeps one trusted aggregator hub as an exploration path", () => {
  const result = selectFetchBatch({
    searchResults: [
      {
        title: "Top Scholarships for College Freshmen in April 2026 - Scholarships360",
        url: "https://scholarships360.org/scholarships/top-scholarships-for-college-freshmen/",
        normalizedUrl: "https://scholarships360.org/scholarships/top-scholarships-for-college-freshmen/",
        sourceDomain: "scholarships360.org",
        providerRank: 3,
        fitScore: -1.5,
        heuristics: {
          surfaceType: "list_likely",
          majorMatch: false,
          ethnicityMatch: false,
          stateMatch: false,
          stageMatch: true,
          negativeGraduateSignal: false,
          negativeBlogSignal: false,
          negativeDirectorySignal: false,
          institutionSpecificSignal: true,
          specificSchoolSignal: false,
          staleCycleSignal: false,
          indirectContentSignal: false,
          sameDomainAsPriorHit: false,
          seenRecently: false,
          noveltyScore: 1
        }
      },
      {
        title: "Scholarships for Incoming Freshman | Scholarships",
        url: "https://school.edu/freshman-scholarships",
        normalizedUrl: "https://school.edu/freshman-scholarships",
        sourceDomain: "school.edu",
        providerRank: 2,
        fitScore: -3.25,
        heuristics: {
          surfaceType: "list_likely",
          majorMatch: false,
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
    ],
    alreadyFetchedUrls: [],
    remainingBudget: {
      pages: 2,
      fetchesThisRound: 2
    },
    runState: {
      acceptedCount: 1,
      targetAcceptedCount: 5,
      round: 2
    }
  });

  assert.deepEqual(result.selectedUrls, [
    "https://scholarships360.org/scholarships/top-scholarships-for-college-freshmen/"
  ]);
  assert.ok(result.notes.some((line) => /exploration_floor=-6/.test(line)));
});
