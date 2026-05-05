import test from "node:test";
import assert from "node:assert/strict";
import { triageFrontier } from "../src/discovery/triageFrontier.js";

test("triageFrontier routes direct, expandable, and dropped pages", () => {
  const result = triageFrontier({
    pageBundles: [
      {
        canonicalUrl: "https://example.org/direct",
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
          directScholarshipSignal: true,
          hubSignal: false,
          listSignal: false,
          deadlineSignal: true,
          awardAmountSignal: true,
          eligibilitySignal: true,
          applicationSignal: false,
          indirectContentSignal: false
        },
        evidenceSnippets: {
          deadlineSnippet: "Apply by March 1, 2027.",
          eligibilitySnippet: "Open to incoming engineering freshmen.",
          amountSnippet: "$2,500 scholarship."
        },
        childLinks: []
      },
      {
        canonicalUrl: "https://example.org/hub",
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
          hubSignal: true,
          listSignal: false,
          deadlineSignal: false,
          awardAmountSignal: false,
          eligibilitySignal: true,
          applicationSignal: true,
          indirectContentSignal: false
        },
        evidenceSnippets: {},
        childLinks: [
          {
            url: "https://example.org/scholarships/future-engineers-award",
            anchorText: "Future Engineers Award",
            detailPathLikely: true
          }
        ]
      },
      {
        canonicalUrl: "https://example.org/old-roundup",
        blockers: {
          closedSignal: false,
          pastCycleSignal: true,
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
          deadlineSignal: false,
          awardAmountSignal: false,
          eligibilitySignal: false,
          applicationSignal: false,
          indirectContentSignal: true
        },
        evidenceSnippets: {},
        childLinks: []
      }
    ],
    remainingBudget: {
      pages: 10,
      depth: 2
    }
  });

  assert.deepEqual(result.decisions, [
    {
      url: "https://example.org/direct",
      action: "advance_to_finalize",
      rationale: "Fetched page looks like a direct scholarship page with enough concrete evidence to send to finalization now."
    },
    {
      url: "https://example.org/hub",
      action: "hold_for_expansion",
      rationale: "Fetched page looks more like a gateway than a final scholarship and has useful child links worth exploring."
    },
    {
      url: "https://example.org/old-roundup",
      action: "drop",
      rationale: "Page appears tied to a past scholarship cycle and is not worth more attention in this run."
    }
  ]);

  assert.deepEqual(result.queue, {
    advanceToFinalize: ["https://example.org/direct"],
    holdForExpansion: ["https://example.org/hub"],
    dropped: ["https://example.org/old-roundup"]
  });
});

test("triageFrontier drops school-specific and stage-mismatched dead ends", () => {
  const result = triageFrontier({
    pageBundles: [
      {
        canonicalUrl: "https://school.edu/scholarships",
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
          hubSignal: false,
          listSignal: true,
          deadlineSignal: false,
          awardAmountSignal: false,
          eligibilitySignal: true,
          applicationSignal: true,
          indirectContentSignal: false
        },
        evidenceSnippets: {},
        childLinks: []
      },
      {
        canonicalUrl: "https://example.org/wrong-stage",
        blockers: {
          closedSignal: false,
          pastCycleSignal: false,
          explicitStageMismatchSignal: true,
          accessBlockedSignal: false
        },
        fitSignals: {
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
        evidenceSnippets: {},
        childLinks: []
      }
    ],
    remainingBudget: {
      pages: 10,
      depth: 2
    }
  });

  assert.deepEqual(result.queue, {
    advanceToFinalize: [],
    holdForExpansion: [],
    dropped: [
      "https://school.edu/scholarships",
      "https://example.org/wrong-stage"
    ]
  });
});

test("triageFrontier does not keep stage-mismatched pages alive on generic apply links alone", () => {
  const result = triageFrontier({
    pageBundles: [
      {
        canonicalUrl: "https://example.org/mismatch-with-apply-link",
        blockers: {
          closedSignal: false,
          pastCycleSignal: false,
          explicitStageMismatchSignal: true,
          accessBlockedSignal: false
        },
        fitSignals: {
          specificSchoolSignal: false
        },
        pageSignals: {
          directScholarshipSignal: false,
          hubSignal: false,
          listSignal: true,
          deadlineSignal: false,
          awardAmountSignal: true,
          eligibilitySignal: true,
          applicationSignal: true,
          indirectContentSignal: false
        },
        evidenceSnippets: {},
        childLinks: [
          {
            url: "https://apply.example.org",
            anchorText: "Apply Now",
            detailPathLikely: false
          },
          {
            url: "https://paypal.example.org",
            anchorText: "Donate",
            detailPathLikely: false
          }
        ]
      }
    ],
    remainingBudget: {
      pages: 10,
      depth: 2
    }
  });

  assert.deepEqual(result.decisions, [
    {
      url: "https://example.org/mismatch-with-apply-link",
      action: "drop",
      rationale: "Page shows an explicit student-stage mismatch, so it should not continue in this run."
    }
  ]);
});

test("triageFrontier expands aggregator summaries instead of finalizing them directly", () => {
  const result = triageFrontier({
    pageBundles: [
      {
        canonicalUrl: "https://accessscholarships.com/scholarship/latinos-in-technology-scholarship",
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
        evidenceSnippets: {
          deadlineSnippet: "03/01 deadline.",
          eligibilitySnippet: "Must be of Latino or Hispanic origin.",
          amountSnippet: "$30,000 value."
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
    ],
    remainingBudget: {
      pages: 5,
      depth: 1
    }
  });

  assert.deepEqual(result.decisions, [
    {
      url: "https://accessscholarships.com/scholarship/latinos-in-technology-scholarship",
      action: "hold_for_expansion",
      rationale: "Fetched page looks like an aggregator summary, so it should expand to the original source before finalization."
    }
  ]);
  assert.deepEqual(result.queue, {
    advanceToFinalize: [],
    holdForExpansion: ["https://accessscholarships.com/scholarship/latinos-in-technology-scholarship"],
    dropped: []
  });
});

test("triageFrontier drops explicit stage mismatches even when child links exist", () => {
  const result = triageFrontier({
    pageBundles: [
      {
        canonicalUrl: "https://example.org/grad-travel-grant",
        blockers: {
          closedSignal: false,
          pastCycleSignal: false,
          explicitStageMismatchSignal: true,
          accessBlockedSignal: false
        },
        fitSignals: {
          specificSchoolSignal: false
        },
        pageSignals: {
          directScholarshipSignal: true,
          hubSignal: false,
          listSignal: false,
          deadlineSignal: false,
          awardAmountSignal: true,
          eligibilitySignal: true,
          applicationSignal: false,
          indirectContentSignal: false
        },
        evidenceSnippets: {
          eligibilitySnippet: "Open to Masters and PhD students.",
          amountSnippet: "$1,000 travel grant."
        },
        childLinks: [
          {
            url: "https://example.org/another-page",
            anchorText: "Another Scholarship Page",
            detailPathLikely: true
          }
        ]
      }
    ],
    remainingBudget: {
      pages: 10,
      depth: 2
    }
  });

  assert.deepEqual(result.decisions, [
    {
      url: "https://example.org/grad-travel-grant",
      action: "drop",
      rationale: "Direct scholarship page shows an explicit stage mismatch, so it should not continue in this run."
    }
  ]);
});

test("triageFrontier drops financial-aid explainer pages", () => {
  const result = triageFrontier({
    pageBundles: [
      {
        canonicalUrl: "https://example.org/financial-aid/pell-grant",
        title: "Pell Grant: Everything You Need to Know",
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
          deadlineSignal: false,
          awardAmountSignal: true,
          eligibilitySignal: true,
          applicationSignal: true,
          indirectContentSignal: true,
          aggregatorSummarySignal: true,
          originalSourceLinkSignal: true
        },
        evidenceSnippets: {
          eligibilitySnippet: "Students can be eligible for federal financial aid.",
          amountSnippet: "Federal Pell Grant maximum and minimum award amounts.",
          stageRestrictionSnippet: "Everything you need to know about Pell Grant eligibility."
        },
        childLinks: [
          {
            url: "https://federal.example.org/pell-grant-amounts",
            anchorText: "Federal Student Aid website",
            detailPathLikely: true,
            sameDomain: false
          }
        ]
      }
    ],
    remainingBudget: {
      pages: 10,
      depth: 2
    }
  });

  assert.deepEqual(result.decisions, [
    {
      url: "https://example.org/financial-aid/pell-grant",
      action: "drop",
      rationale: "Page is a financial-aid explainer rather than a scholarship candidate page, so it should not continue in this run."
    }
  ]);
});

test("triageFrontier default policy can finalize a strong trusted aggregator detail page", () => {
  const result = triageFrontier({
    pageBundles: [
      {
        canonicalUrl: "https://scholarships360.org/scholarships/search/skechers-financial-hardship-scholarship",
        sourceDomain: "scholarships360.org",
        title: "SKECHERS Financial Hardship Scholarship This scholarship has been verified by the scholarship providing organization.",
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
        evidenceSnippets: {
          deadlineSnippet: "Grade level High School Senior Application Deadline: April 15, 2026 Winner Announcement May 22, 2026",
          eligibilitySnippet: "Verified by the scholarship providing organization.",
          amountSnippet: "15 awards worth $5,000.",
          stageRestrictionSnippet: "I’m a high school student"
        },
        childLinks: []
      }
    ],
    remainingBudget: {
      pages: 5,
      depth: 1
    }
  });

  assert.deepEqual(result.decisions, [
    {
      url: "https://scholarships360.org/scholarships/search/skechers-financial-hardship-scholarship",
      action: "advance_to_finalize",
      rationale: "Fetched page looks like a trusted aggregator detail page with enough concrete scholarship evidence to send to finalization now."
    }
  ]);
});

test("triageFrontier trusted_agg_conservative does not finalize broad roundup aggregators", () => {
  const result = triageFrontier({
    pageBundles: [
      {
        canonicalUrl: "https://scholarships360.org/scholarships/mechanical-engineering-scholarships",
        sourceDomain: "scholarships360.org",
        title: "Top 145 Mechanical Engineering Scholarships in April 2026",
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
          hubSignal: true,
          listSignal: true,
          deadlineSignal: true,
          awardAmountSignal: true,
          eligibilitySignal: true,
          applicationSignal: true,
          indirectContentSignal: true,
          aggregatorSummarySignal: true,
          originalSourceLinkSignal: true
        },
        evidenceSnippets: {
          deadlineSnippet: "Recent Scholarships360 winners.",
          eligibilitySnippet: "Why choose Scholarships360.",
          amountSnippet: "Top 145 Mechanical Engineering Scholarships in April 2026.",
          stageRestrictionSnippet: "High School Seniors Scholarships"
        },
        childLinks: [
          {
            url: "https://scholarships360.org/scholarships/200000-skechers-scholarship-program",
            anchorText: "Skechers scholarship program",
            detailPathLikely: true,
            sameDomain: true
          }
        ]
      }
    ],
    remainingBudget: {
      pages: 5,
      depth: 1
    },
    experimentVariant: "trusted_agg_conservative"
  });

  assert.deepEqual(result.decisions, [
    {
      url: "https://scholarships360.org/scholarships/mechanical-engineering-scholarships",
      action: "hold_for_expansion",
      rationale: "Fetched page looks like an aggregator summary, so it should expand to the original source before finalization."
    }
  ]);
});
