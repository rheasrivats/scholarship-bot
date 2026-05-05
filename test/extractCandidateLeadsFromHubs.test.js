import test from "node:test";
import assert from "node:assert/strict";
import { extractCandidateLeadsFromHubs } from "../src/discovery/extractCandidateLeadsFromHubs.js";

function createBaseHub(overrides = {}) {
  return {
    canonicalUrl: "https://example.org/scholarships",
    title: "Scholarship Hub",
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
      stateMatchSignal: false,
      stageMatchSignal: true,
      specificSchoolSignal: false
    },
    pageSignals: {
      directScholarshipSignal: false,
      hubSignal: true,
      listSignal: true,
      indirectContentSignal: false,
      aggregatorSummarySignal: false,
      originalSourceLinkSignal: false
    },
    childLinks: [],
    ...overrides
  };
}

test("extractCandidateLeadsFromHubs rejects generic advice links", () => {
  const result = extractCandidateLeadsFromHubs({
    pageBundles: [
      createBaseHub({
        canonicalUrl: "https://www.financialaidfinder.com/student-scholarship-search/student-scholarships-college-major/engineering-scholarships/latino-engineering",
        sourceDomain: "financialaidfinder.com",
        pageSignals: {
          directScholarshipSignal: false,
          hubSignal: true,
          listSignal: true,
          indirectContentSignal: true,
          aggregatorSummarySignal: true,
          originalSourceLinkSignal: false
        },
        childLinks: [
          {
            url: "https://www.financialaidfinder.com/scholarships/the-application-process",
            anchorText: "The Application Process",
            sourceDomain: "financialaidfinder.com",
            sameDomain: true,
            detailPathLikely: true,
            seenRecently: false
          },
          {
            url: "https://www.financialaidfinder.com/scholarships/college-scholarship-essays",
            anchorText: "College Scholarship Essays",
            sourceDomain: "financialaidfinder.com",
            sameDomain: true,
            detailPathLikely: true,
            seenRecently: false
          }
        ]
      })
    ],
    remainingBudget: { pages: 5, depth: 2 }
  });

  assert.deepEqual(result.selectedLeadUrls, []);
  assert.equal(result.leadGroups[0].rejectedChildren.length, 2);
  assert.match(result.leadGroups[0].rejectedChildren[0].reason, /generic advice/i);
});

test("extractCandidateLeadsFromHubs extracts named scholarship leads from list hubs", () => {
  const result = extractCandidateLeadsFromHubs({
    pageBundles: [
      createBaseHub({
        canonicalUrl: "https://collegewhale.com/college-freshman",
        sourceDomain: "collegewhale.com",
        pageSignals: {
          directScholarshipSignal: false,
          hubSignal: true,
          listSignal: true,
          indirectContentSignal: true,
          aggregatorSummarySignal: true,
          originalSourceLinkSignal: false
        },
        childLinks: [
          {
            url: "https://collegewhale.com/delete-cyberbullying-scholarship-award",
            anchorText: "Delete Cyberbullying Scholarship Award",
            sourceDomain: "collegewhale.com",
            sameDomain: true,
            detailPathLikely: false,
            seenRecently: false
          },
          {
            url: "https://collegewhale.com/op-loftbed-500-scholarship-award",
            anchorText: "OP Loftbed $500 Scholarship Award",
            sourceDomain: "collegewhale.com",
            sameDomain: true,
            detailPathLikely: false,
            seenRecently: false
          }
        ]
      })
    ],
    remainingBudget: { pages: 5, depth: 2 }
  });

  assert.deepEqual(result.selectedLeadUrls, [
    "https://collegewhale.com/delete-cyberbullying-scholarship-award",
    "https://collegewhale.com/op-loftbed-500-scholarship-award"
  ]);
  assert.equal(result.leadGroups[0].leads[0].leadName, "Delete Cyberbullying Scholarship Award");
  assert.equal(result.leadGroups[0].leads[0].needsSourceVerification, true);
  assert.equal(result.leadGroups[0].leads[0].needsEligibilityVerification, true);
  assert.equal(result.leadGroups[0].leads[0].fitSignals.stageLikely, false);
  assert.equal(result.leadGroups[0].leads[0].fitSignals.majorLikely, false);
  assert.equal(result.leadGroups[0].leads[0].fitSignals.evidenceSource, "aggregator_page_context_only");
  assert.equal(result.leadGroups[0].leads[0].riskSignals.sourceFitSignalsMayNotApply, true);
});

test("extractCandidateLeadsFromHubs marks university department leads as school specific", () => {
  const result = extractCandidateLeadsFromHubs({
    pageBundles: [
      createBaseHub({
        canonicalUrl: "https://www.me.uh.edu/undergraduate/scholarships",
        sourceDomain: "me.uh.edu",
        fitSignals: {
          majorMatchSignal: true,
          ethnicityMatchSignal: false,
          stateMatchSignal: false,
          stageMatchSignal: true,
          specificSchoolSignal: true
        },
        childLinks: [
          {
            url: "https://www.me.uh.edu/scholarships/joe-carolyn-hynes-endowed-scholarship-mechanical-engineering",
            anchorText: "Joe & Carolyn Hynes Endowed Scholarship in Mechanical Engineering",
            sourceDomain: "me.uh.edu",
            sameDomain: true,
            detailPathLikely: true,
            seenRecently: false
          }
        ]
      })
    ],
    remainingBudget: { pages: 5, depth: 2 }
  });

  assert.deepEqual(result.selectedLeadUrls, [
    "https://www.me.uh.edu/scholarships/joe-carolyn-hynes-endowed-scholarship-mechanical-engineering"
  ]);
  assert.equal(result.leadGroups[0].leads[0].fitSignals.schoolSpecificLikely, true);
  assert.equal(result.leadGroups[0].leads[0].fitSignals.stageLikely, true);
  assert.equal(result.leadGroups[0].leads[0].fitSignals.majorLikely, true);
  assert.equal(result.leadGroups[0].leads[0].fitSignals.evidenceSource, "source_page_context");
});

test("extractCandidateLeadsFromHubs prioritizes offsite official source links from aggregator summaries", () => {
  const result = extractCandidateLeadsFromHubs({
    pageBundles: [
      createBaseHub({
        canonicalUrl: "https://accessscholarships.com/scholarship/latinos-in-technology-scholarship",
        sourceDomain: "accessscholarships.com",
        pageSignals: {
          directScholarshipSignal: false,
          hubSignal: false,
          listSignal: true,
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
      })
    ],
    remainingBudget: { pages: 5, depth: 2 },
    maxLeadsPerPage: 1
  });

  assert.deepEqual(result.selectedLeadUrls, [
    "https://www.siliconvalleycf.org/scholarships/lit"
  ]);
  assert.equal(result.leadGroups[0].leads[0].isOfficialSourceLikely, true);
  assert.equal(result.leadGroups[0].leads[0].needsSourceVerification, false);
  assert.equal(result.leadGroups[0].leads[0].needsEligibilityVerification, true);
  assert.equal(result.leadGroups[0].leads[0].fitSignals.evidenceSource, "aggregator_page_context_only");
  assert.equal(result.leadGroups[0].leads[0].riskSignals.sourceFitSignalsMayNotApply, true);
});

test("extractCandidateLeadsFromHubs does not suppress distinct child leads on mixed stale pages", () => {
  const result = extractCandidateLeadsFromHubs({
    pageBundles: [
      createBaseHub({
        canonicalUrl: "https://example.org/mixed-scholarship-page",
        sourceDomain: "example.org",
        blockers: {
          closedSignal: true,
          pastCycleSignal: false,
          explicitStageMismatchSignal: false,
          accessBlockedSignal: false
        },
        pageSignals: {
          directScholarshipSignal: true,
          hubSignal: true,
          listSignal: true,
          indirectContentSignal: false,
          aggregatorSummarySignal: false,
          originalSourceLinkSignal: false
        },
        childLinks: [
          {
            url: "https://example.org/scholarship/current-freshman-award",
            anchorText: "Current Freshman Award Scholarship",
            sourceDomain: "example.org",
            sameDomain: true,
            detailPathLikely: true,
            seenRecently: false
          }
        ]
      })
    ],
    remainingBudget: { pages: 5, depth: 2 }
  });

  assert.deepEqual(result.selectedLeadUrls, [
    "https://example.org/scholarship/current-freshman-award"
  ]);
  assert.equal(result.leadGroups[0].leads[0].riskSignals.staleLikely, true);
  assert.match(result.leadGroups[0].rationale, /despite source-level stale or closed signals/i);
});

test("extractCandidateLeadsFromHubs rejects provider, referral, winner, and committee links", () => {
  const result = extractCandidateLeadsFromHubs({
    pageBundles: [
      createBaseHub({
        canonicalUrl: "https://scholarships360.org/scholarships/mechanical-engineering-scholarships",
        sourceDomain: "scholarships360.org",
        pageSignals: {
          directScholarshipSignal: false,
          hubSignal: true,
          listSignal: true,
          indirectContentSignal: true,
          aggregatorSummarySignal: true,
          originalSourceLinkSignal: true
        },
        childLinks: [
          {
            url: "https://connect.scholarships360.org/scholarship-providers",
            anchorText: "Scholarship Providers",
            sourceDomain: "connect.scholarships360.org",
            sameDomain: false,
            detailPathLikely: true,
            seenRecently: false
          },
          {
            url: "https://refer.sofi.com/c/2552737/2856921/11190?adcampaigngroup=inschool&adnetwork=BD",
            anchorText: "SoFi $2,500 Scholarship Giveaway",
            sourceDomain: "refer.sofi.com",
            sameDomain: false,
            detailPathLikely: true,
            seenRecently: false
          },
          {
            url: "https://scholarships360.org/scholarship-winners",
            anchorText: "Scholarship Winners",
            sourceDomain: "scholarships360.org",
            sameDomain: true,
            detailPathLikely: true,
            seenRecently: false
          },
          {
            url: "https://scholarships360.org/scholarship-rules",
            anchorText: "Scholarship Rules",
            sourceDomain: "scholarships360.org",
            sameDomain: true,
            detailPathLikely: true,
            seenRecently: false
          },
          {
            url: "https://www.asme.org/ASME-Programs/Students-and-Faculty/scholarships/Volunteer-Opportunity-with-the-ASME-Scholarship-Committee",
            anchorText: "Scholarship Committee/Get Involved",
            sourceDomain: "asme.org",
            sameDomain: false,
            detailPathLikely: true,
            seenRecently: false
          },
          {
            url: "https://scholarshipamerica.org/scholarship/example-scholarship",
            anchorText: "Example Scholarship",
            sourceDomain: "scholarshipamerica.org",
            sameDomain: false,
            detailPathLikely: true,
            seenRecently: false
          }
        ]
      })
    ],
    remainingBudget: { pages: 5, depth: 2 },
    maxLeadsPerPage: 5
  });

  assert.deepEqual(result.selectedLeadUrls, [
    "https://scholarshipamerica.org/scholarship/example-scholarship"
  ]);
  assert.equal(result.leadGroups[0].leads[0].isOfficialSourceLikely, true);
  assert.equal(result.leadGroups[0].rejectedChildren.length, 5);
  assert.match(result.leadGroups[0].rejectedChildren[0].reason, /generic advice|provider/i);
});

test("extractCandidateLeadsFromHubs rejects later-college stage child links for starting-college students", () => {
  const result = extractCandidateLeadsFromHubs({
    pageBundles: [
      createBaseHub({
        canonicalUrl: "https://www.asme.org/asme-programs/students-and-faculty/scholarships",
        sourceDomain: "asme.org",
        childLinks: [
          {
            url: "https://www.asme.org/ASME-Programs/Students-and-Faculty/scholarships/Available-High-School-Scholarships",
            anchorText: "High School Seniors",
            sourceDomain: "asme.org",
            sameDomain: true,
            detailPathLikely: true,
            seenRecently: false
          },
          {
            url: "https://www.asme.org/ASME-Programs/Students-and-Faculty/scholarships/4-Year-Baccalaureate-Graduate-Students",
            anchorText: "4-Year Baccalaureate and Graduate Program Students",
            sourceDomain: "asme.org",
            sameDomain: true,
            detailPathLikely: true,
            seenRecently: false
          }
        ]
      })
    ],
    studentStage: "starting_college",
    remainingBudget: { pages: 5, depth: 2 },
    maxLeadsPerPage: 5
  });

  assert.deepEqual(result.selectedLeadUrls, [
    "https://www.asme.org/ASME-Programs/Students-and-Faculty/scholarships/Available-High-School-Scholarships"
  ]);
  assert.equal(result.leadGroups[0].rejectedChildren[0].url, "https://www.asme.org/ASME-Programs/Students-and-Faculty/scholarships/4-Year-Baccalaureate-Graduate-Students");
  assert.match(result.leadGroups[0].rejectedChildren[0].reason, /later college or graduate/i);
});
