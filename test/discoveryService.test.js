import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { discoverScholarshipCandidates, __testables } from "../src/discovery/discoveryService.js";

const {
  buildDiscoveryQueries,
  parseBraveWebSearchResults,
  buildCandidateFromPage,
  scoreCandidateFit,
  scoreSearchResultFitLikelihood,
  rerankSearchResultsForDiscovery,
  selectInitialFrontier,
  extractLikelyScholarshipLinks,
  extractDeadline,
  normalizeDateString
} = __testables;

const SEARCH_JSON = {
  web: {
    results: [
      {
        title: "Future Engineers Scholarship",
        url: "https://example.org/future-engineers-scholarship",
        description: "Scholarship for mechanical engineering students in California."
      },
      {
        title: "Top Scholarships 2026",
        url: "https://example.org/top-scholarships-2026",
        description: "A roundup of many awards."
      }
    ]
  }
};

const GOOD_PAGE_HTML = `
  <html>
    <head>
      <title>Future Engineers Scholarship</title>
      <meta property="og:title" content="Future Engineers Scholarship" />
    </head>
    <body>
      <h1>Future Engineers Scholarship</h1>
      <p>Applicants must be California residents pursuing a degree in engineering or mechanical engineering.</p>
      <p>Students must have a minimum 3.5 GPA and be incoming college freshmen.</p>
      <p>The scholarship award is $5,000.</p>
      <p>Application deadline: November 1, 2026.</p>
      <p>Essay prompt: Describe how you will use engineering to serve your community.</p>
    </body>
  </html>
`;

const LIST_PAGE_HTML = `
  <html>
    <head><title>Top Scholarships 2026</title></head>
    <body>
      <h1>Top Scholarships 2026</h1>
      <p>This directory highlights a list of scholarships for students across many categories.</p>
    </body>
  </html>
`;

const AGGREGATOR_PAGE_HTML = `
  <html>
    <head><title>Mechanical Engineering Scholarships for 2026</title></head>
    <body>
      <h1>Mechanical Engineering Scholarships for 2026</h1>
      <p>We found the best scholarships for mechanical engineering students.</p>
      <a href="/scholarships/search/future-engineers-scholarship/">Future Engineers Scholarship</a>
      <a href="/scholarships/search/community-stem-award/">Community STEM Award</a>
      <a href="/scholarships/search/another-stem-grant/">Another STEM Grant</a>
      <a href="/scholarships/search/example-four/">Example Four Scholarship</a>
      <a href="/scholarships/search/example-five/">Example Five Scholarship</a>
      <a href="/scholarships/search/example-six/">Example Six Scholarship</a>
      <a href="/scholarships/search/example-seven/">Example Seven Scholarship</a>
      <a href="/scholarships/search/example-eight/">Example Eight Scholarship</a>
      <a href="/scholarships/search/example-nine/">Example Nine Scholarship</a>
      <a href="/scholarships/search/example-ten/">Example Ten Scholarship</a>
      <a href="/scholarships/search/example-eleven/">Example Eleven Scholarship</a>
      <a href="/scholarships/search/example-twelve/">Example Twelve Scholarship</a>
      <p>Scholarship A - $1,000 - deadline Nov 1, 2026.</p>
      <p>Scholarship B - $2,500 - deadline Dec 1, 2026.</p>
      <p>Scholarship C - $5,000 - deadline Jan 10, 2027.</p>
    </body>
  </html>
`;

const GENERIC_HUB_PAGE_HTML = `
  <html>
    <head><title>Engineering Scholarships</title></head>
    <body>
      <h1>Engineering Scholarships</h1>
      <p>Browse engineering scholarships, awards, and grants for students.</p>
      <a href="/scholarships/alpha-engineering-scholarship">Alpha Engineering Scholarship</a>
      <a href="/scholarships/bravo-stem-award">Bravo STEM Award</a>
      <a href="/scholarships/charlie-fellowship">Charlie Fellowship</a>
      <a href="/scholarships/delta-grant">Delta Grant</a>
    </body>
  </html>
`;

const HOMEPAGE_PORTAL_HTML = `
  <html>
    <head><title>Empowering Courageous Leaders</title></head>
    <body>
      <h1>Empowering Courageous Leaders</h1>
      <p>We support students with scholarships and resources for college success.</p>
      <a href="/scholarship-one">Scholarship One</a>
      <a href="/scholarship-two">Scholarship Two</a>
      <a href="/scholarship-three">Scholarship Three</a>
      <a href="/scholarship-four">Scholarship Four</a>
    </body>
  </html>
`;

const BORDERLINE_GUIDE_PAGE_HTML = `
  <html>
    <head><title>Future Engineers Scholarship</title></head>
    <body>
      <h1>Future Engineers Scholarship</h1>
      <p>Applicants can review scholarship requirements and explore opportunities for engineering students.</p>
      <a href="/scholarships/future-engineers-award">Future Engineers Award</a>
    </body>
  </html>
`;

const LISTY_DETAIL_PAGE_HTML = `
  <html>
    <head><title>Future Engineers Scholarship</title></head>
    <body>
      <h1>Future Engineers Scholarship</h1>
      <p>Applicants must be incoming college freshmen pursuing engineering or mechanical engineering in California.</p>
      <p>Application deadline: November 1, 2026.</p>
      <p>Scholarship award: $5,000.</p>
      <p>Related scholarships you may also want to explore:</p>
      <a href="/scholarships/community-stem-award">Community STEM Award</a>
      <a href="/scholarships/innovation-grant">Innovation Grant</a>
      <a href="/scholarships/next-gen-engineers-scholarship">Next Gen Engineers Scholarship</a>
    </body>
  </html>
`;

const NESTED_LIST_PAGE_HTML = `
  <html>
    <head><title>Engineering Scholarships Hub</title></head>
    <body>
      <h1>Engineering Scholarships Hub</h1>
      <p>Explore a list of engineering scholarships and awards for many student groups.</p>
      <a href="/scholarships/future-engineers-scholarship-hub">Future Engineers Scholarship Hub</a>
    </body>
  </html>
`;

const PROMISING_FRESHMAN_LIST_PAGE_HTML = `
  <html>
    <head><title>Mechanical Engineering Scholarships for Incoming Freshmen</title></head>
    <body>
      <h1>Mechanical Engineering Scholarships for Incoming Freshmen</h1>
      <p>We found the best scholarships for incoming college freshmen pursuing mechanical engineering.</p>
      <a href="/scholarships/future-engineers-freshman-scholarship">Future Engineers Freshman Scholarship</a>
      <a href="/scholarships/future-engineers-state-award">Future Engineers State Award</a>
      <a href="/scholarships/engineering-freshman-opportunity">Engineering Freshman Opportunity</a>
      <a href="/scholarships/example-four">Example Four Scholarship</a>
      <a href="/scholarships/example-five">Example Five Scholarship</a>
      <a href="/scholarships/example-six">Example Six Scholarship</a>
      <a href="/scholarships/example-seven">Example Seven Scholarship</a>
      <a href="/scholarships/example-eight">Example Eight Scholarship</a>
      <a href="/scholarships/example-nine">Example Nine Scholarship</a>
      <a href="/scholarships/example-ten">Example Ten Scholarship</a>
      <a href="/scholarships/example-eleven">Example Eleven Scholarship</a>
      <a href="/scholarships/example-twelve">Example Twelve Scholarship</a>
      <p>Scholarship A - $1,000 - deadline Nov 1, 2026.</p>
      <p>Scholarship B - $2,500 - deadline Dec 1, 2026.</p>
      <p>Scholarship C - $5,000 - deadline Jan 10, 2027.</p>
    </body>
  </html>
`;

const EXPLICIT_ETHNICITY_PAGE_HTML = `
  <html>
    <head><title>Hue Ta Asian American Scholarship</title></head>
    <body>
      <h1>Hue Ta Asian American Scholarship</h1>
      <p>This scholarship honors community impact and supports students interested in expanding mental health access.</p>
      <p>Applicants must be Asian American students.</p>
      <p>Applicants must have a minimum 3.0 GPA.</p>
      <p>Scholarship award: $2,500.</p>
      <p>Application deadline: December 7, 2026.</p>
      <p>Essay prompt: Describe your commitment to supporting mental health in your community.</p>
      <p>Ideal applicants may have experience in education, nursing, or advocacy.</p>
    </body>
  </html>
`;

const CONTINUING_COLLEGE_PAGE_HTML = `
  <html>
    <head><title>John Rice Memorial Scholarship ASME Metropolitan Section</title></head>
    <body>
      <h1>John Rice Memorial Scholarship ASME Metropolitan Section</h1>
      <p>Applicants must be college juniors and seniors pursuing mechanical engineering.</p>
      <p>Students must be attending an eligible college within the New York metro area.</p>
      <p>Scholarship award: $3,000.</p>
      <p>Application deadline: March 1, 2027.</p>
    </body>
  </html>
`;

function createMockResponse(body, {
  status = 200,
  contentType = "text/html; charset=utf-8"
} = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return String(name || "").toLowerCase() === "content-type" ? contentType : "";
      }
    },
    async text() {
      return body;
    }
  };
}

function createMockJsonResponse(body, {
  status = 200
} = {}) {
  const textBody = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return String(name || "").toLowerCase() === "content-type" ? "application/json; charset=utf-8" : "";
      }
    },
    async text() {
      return textBody;
    }
  };
}

test("buildDiscoveryQueries creates profile-aware scholarship searches", () => {
  const queries = buildDiscoveryQueries({
    profile: {
      personalInfo: {
        intendedMajor: "Mechanical Engineering, B.S.",
        ethnicity: "Hispanic/Latino",
        state: "California"
      },
      academics: {
        gradeLevel: "12th grade"
      }
    },
    studentStage: "starting_college",
    maxQueries: 6
  });

  assert.ok(queries.length > 0);
  assert.ok(queries.some((query) => /mechanical engineering/i.test(query)));
  assert.ok(queries.some((query) => /hispanic|latino/i.test(query)));
  assert.ok(queries.some((query) => /california|CA/.test(query)));
  assert.ok(!queries.some((query) => /\bB\.?S\.?\b/i.test(query)));
});

test("buildDiscoveryQueries expands to a broader manual rerun query set", () => {
  const queries = buildDiscoveryQueries({
    profile: {
      personalInfo: {
        intendedMajor: "Mechanical Engineering, B.S.",
        ethnicity: "Hispanic/Latino",
        state: "California"
      },
      academics: {
        gradeLevel: "12th grade"
      }
    },
    studentStage: "starting_college",
    maxQueries: 12
  });

  assert.equal(queries.length >= 10, true);
  assert.ok(queries.some((query) => /undergraduate scholarship/i.test(query)));
  assert.ok(queries.some((query) => /first year college/i.test(query)));
  assert.ok(queries.some((query) => /incoming freshman/i.test(query)));
  assert.ok(queries.some((query) => /first-year student/i.test(query) || /first year student/i.test(query)));
});

test("parseBraveWebSearchResults extracts ranked links", () => {
  const results = parseBraveWebSearchResults(SEARCH_JSON, "engineering scholarship", 5);

  assert.equal(results.length, 2);
  assert.equal(results[0].title, "Future Engineers Scholarship");
  assert.equal(results[0].url, "https://example.org/future-engineers-scholarship");
  assert.equal(results[0].rank, 1);
});

test("fit-first search ranking prefers direct scholarship pages over list pages", () => {
  const ranked = rerankSearchResultsForDiscovery([
    {
      title: "Mechanical Engineering Scholarships for 2026",
      url: "https://example.org/scholarships/mechanical-engineering-scholarships",
      snippet: "Top scholarships and directory listings for engineering students.",
      query: "mechanical engineering scholarship incoming college freshman",
      globalRank: 1,
      passPriority: 1
    },
    {
      title: "Future Engineers Scholarship",
      url: "https://example.org/scholarships/future-engineers-scholarship",
      snippet: "Mechanical engineering scholarship for incoming college freshmen in California.",
      query: "mechanical engineering scholarship incoming college freshman",
      globalRank: 2,
      passPriority: 0
    }
  ], new Map(), {
    personalInfo: {
      intendedMajor: "Mechanical Engineering",
      ethnicity: "Hispanic/Latino",
      state: "California"
    },
    academics: {
      gradeLevel: "12th grade"
    }
  }, "starting_college", []);

  assert.equal(ranked[0].url, "https://example.org/scholarships/future-engineers-scholarship");
  assert.equal(ranked[0].surfaceType, "direct_likely");
  assert.ok(ranked[0].fitScore > ranked[1].fitScore);
});

test("search reranking boosts domains with approved history over heavily rejected domains", () => {
  const ranked = rerankSearchResultsForDiscovery([
    {
      title: "Future Engineers Scholarship",
      url: "https://trusted.example.org/scholarships/future-engineers-scholarship",
      snippet: "Mechanical engineering scholarship for incoming college freshmen in California.",
      query: "mechanical engineering scholarship incoming college freshman",
      globalRank: 2,
      passPriority: 0
    },
    {
      title: "Future Engineers Scholarship",
      url: "https://spammy.example.org/scholarships/future-engineers-scholarship",
      snippet: "Mechanical engineering scholarship for incoming college freshmen in California.",
      query: "mechanical engineering scholarship incoming college freshman",
      globalRank: 1,
      passPriority: 0
    }
  ], new Map(), {
    personalInfo: {
      intendedMajor: "Mechanical Engineering",
      ethnicity: "Hispanic/Latino",
      state: "California"
    },
    academics: {
      gradeLevel: "12th grade"
    }
  }, "starting_college", [], new Map([
    ["trusted.example.org", { approved: 2, submitted: 0, rejected: 0, pending: 0 }],
    ["spammy.example.org", { approved: 0, submitted: 0, rejected: 3, pending: 0 }]
  ]));

  assert.equal(ranked[0].url, "https://trusted.example.org/scholarships/future-engineers-scholarship");
  assert.ok(ranked[0].fitScore > ranked[1].fitScore);
});

test("search-result fit scoring penalizes junior/senior scholarships for starting_college", () => {
  const freshmanScore = scoreSearchResultFitLikelihood({
    title: "Future Engineers Scholarship",
    url: "https://example.org/scholarships/future-engineers-scholarship",
    snippet: "Mechanical engineering scholarship for incoming college freshmen in California."
  }, {
    personalInfo: {
      intendedMajor: "Mechanical Engineering",
      ethnicity: "Hispanic/Latino",
      state: "California"
    },
    academics: {
      gradeLevel: "12th grade"
    }
  }, "starting_college");

  const upperclassScore = scoreSearchResultFitLikelihood({
    title: "John Rice Memorial Scholarship",
    url: "https://example.org/scholarships/john-rice-memorial-scholarship",
    snippet: "Mechanical engineering scholarship for college juniors and seniors already enrolled in eligible colleges."
  }, {
    personalInfo: {
      intendedMajor: "Mechanical Engineering",
      ethnicity: "Hispanic/Latino",
      state: "California"
    },
    academics: {
      gradeLevel: "12th grade"
    }
  }, "starting_college");

  assert.ok(freshmanScore > upperclassScore);
});

test("selectInitialFrontier reserves direct and list crawl budgets separately", () => {
  const selected = selectInitialFrontier([
    {
      title: "Future Engineers Scholarship",
      url: "https://example.org/scholarships/future-engineers-scholarship",
      fitScore: 10,
      noveltyScore: 5,
      surfaceType: "direct_likely",
      globalRank: 1
    },
    {
      title: "Top Engineering Scholarships",
      url: "https://example.org/scholarships/engineering-scholarships",
      fitScore: 9,
      noveltyScore: 4,
      surfaceType: "list_likely",
      globalRank: 2
    }
  ], []);

  assert.equal(selected.length, 2);
  assert.equal(selected[0].expansionDepth, 0);
  assert.ok(selected.some((item) => item.surfaceType === "direct_likely"));
  assert.ok(selected.some((item) => item.surfaceType === "list_likely"));
});

test("buildCandidateFromPage extracts structured scholarship fields", () => {
  const result = buildCandidateFromPage({
    url: "https://example.org/future-engineers-scholarship",
    html: GOOD_PAGE_HTML,
    searchResult: {
      title: "Future Engineers Scholarship"
    }
  });

  assert.ok(result.candidate);
  assert.equal(result.candidate.name, "Future Engineers Scholarship");
  assert.equal(result.candidate.awardAmount, 5000);
  assert.equal(result.candidate.deadline, "2026-11-01");
  assert.equal(result.candidate.eligibility.minGpa, 3.5);
  assert.ok(result.candidate.eligibility.allowedMajors.includes("engineering"));
  assert.ok(result.candidate.inferredRequirements.requiredStates.includes("CA"));
  assert.ok(result.candidate.essayPrompts.some((prompt) => /describe how you will use engineering/i.test(prompt)));
});

test("buildCandidateFromPage only infers ethnicity and major requirements from explicit eligibility language", () => {
  const result = buildCandidateFromPage({
    url: "https://bold.org/scholarships/hue-ta-asian-american-scholarship/",
    html: EXPLICIT_ETHNICITY_PAGE_HTML,
    searchResult: {
      title: "Hue Ta Asian American Scholarship"
    }
  });

  assert.ok(result.candidate);
  assert.deepEqual(result.candidate.eligibility.allowedEthnicities, ["asian", "asian american"]);
  assert.deepEqual(result.candidate.eligibility.allowedMajors, []);
  assert.equal(result.candidate.eligibility.minGpa, 3);
});

test("scoreCandidateFit marks explicit ethnicity mismatches as ineligible", () => {
  const extraction = buildCandidateFromPage({
    url: "https://bold.org/scholarships/hue-ta-asian-american-scholarship/",
    html: EXPLICIT_ETHNICITY_PAGE_HTML,
    searchResult: {
      title: "Hue Ta Asian American Scholarship"
    }
  });

  const scoring = scoreCandidateFit({
    candidate: extraction.candidate,
    profile: {
      personalInfo: {
        intendedMajor: "Mechanical Engineering",
        ethnicity: "Hispanic/Latino",
        state: "California"
      },
      academics: {
        gpa: 3.9
      }
    },
    searchRank: 1
  });

  assert.equal(scoring.isEligible, false);
  assert.ok(scoring.eligibilityBlockers.includes("ethnicity_mismatch"));
  assert.ok(!scoring.reasons.includes("ethnicity_match"));
});

test("buildCandidateFromPage extracts continuing college stage requirements from explicit eligibility language", () => {
  const extraction = buildCandidateFromPage({
    url: "https://example.org/scholarships/john-rice-memorial-scholarship",
    html: CONTINUING_COLLEGE_PAGE_HTML,
    searchResult: {
      title: "John Rice Memorial Scholarship ASME Metropolitan Section"
    }
  });

  assert.ok(extraction.candidate);
  assert.ok(extraction.candidate.inferredRequirements.requiredStudentStages.includes("continuing_college"));
});

test("scoreCandidateFit marks junior and senior scholarships as ineligible for starting_college", () => {
  const extraction = buildCandidateFromPage({
    url: "https://example.org/scholarships/john-rice-memorial-scholarship",
    html: CONTINUING_COLLEGE_PAGE_HTML,
    searchResult: {
      title: "John Rice Memorial Scholarship ASME Metropolitan Section"
    }
  });

  const scoring = scoreCandidateFit({
    candidate: extraction.candidate,
    profile: {
      personalInfo: {
        intendedMajor: "Mechanical Engineering",
        ethnicity: "Hispanic/Latino",
        state: "California"
      },
      academics: {
        gpa: 3.9,
        gradeLevel: "12th grade"
      }
    },
    studentStage: "starting_college",
    searchRank: 1
  });

  assert.equal(scoring.isEligible, false);
  assert.ok(scoring.eligibilityBlockers.includes("stage_mismatch_continuing_college"));
});

test("buildCandidateFromPage rejects scholarship roundup pages", () => {
  const result = buildCandidateFromPage({
    url: "https://scholarships360.org/scholarships/mechanical-engineering-scholarships/",
    html: AGGREGATOR_PAGE_HTML,
    searchResult: {
      title: "Mechanical Engineering Scholarships for 2026"
    }
  });

  assert.equal(result.candidate, null);
  assert.equal(result.skipReason, "scholarship_list_page");
  assert.ok(Array.isArray(result.childUrls));
  assert.ok(result.childUrls.some((url) => url.includes("future-engineers-scholarship")));
});

test("buildCandidateFromPage rejects generic scholarship hub pages", () => {
  const result = buildCandidateFromPage({
    url: "https://www.asme.org/asme-programs/students-and-faculty/scholarships",
    html: GENERIC_HUB_PAGE_HTML,
    searchResult: {
      title: "Engineering Scholarships"
    }
  });

  assert.equal(result.candidate, null);
  assert.equal(result.skipReason, "scholarship_list_page");
});

test("buildCandidateFromPage rejects scholarship portal homepages", () => {
  const result = buildCandidateFromPage({
    url: "https://www.hsf.net/",
    html: HOMEPAGE_PORTAL_HTML,
    searchResult: {
      title: "Empowering Courageous Leaders"
    }
  });

  assert.equal(result.candidate, null);
  assert.equal(result.skipReason, "scholarship_list_page");
});

test("extractLikelyScholarshipLinks ranks direct scholarship links ahead of graduate fellowship links", () => {
  const html = `
    <html>
      <body>
        <a href="/scholarships/engineering-scholars-award">Engineering Scholars Award</a>
        <a href="/fellowships/graduate-research-fellowship">Graduate Research Fellowship</a>
        <a href="/scholarships/future-engineers-scholarship">Future Engineers Scholarship</a>
      </body>
    </html>
  `;

  const urls = extractLikelyScholarshipLinks(html, "https://example.org/hub");
  assert.equal(urls[0], "https://example.org/scholarships/future-engineers-scholarship");
  assert.ok(urls.includes("https://example.org/fellowships/graduate-research-fellowship"));
});

test("extractDeadline preserves month abbreviations and normalizes to ISO", () => {
  assert.equal(extractDeadline("Application deadline: Nov 8, 2026."), "2026-11-08");
  assert.equal(normalizeDateString("Nov 8, 2026"), "2026-11-08");
  assert.equal(extractDeadline("Application deadline: January 1."), "");
  assert.equal(normalizeDateString("January 1"), "");
});

test("buildCandidateFromPage rejects scholarships with explicit past deadlines", () => {
  const result = buildCandidateFromPage({
    url: "https://example.org/expired-scholarship",
    html: `
      <html>
        <body>
          <h1>Expired Scholarship</h1>
          <p>Applicants must be incoming college freshmen studying engineering.</p>
          <p>Scholarship award: $1,000.</p>
          <p>Application deadline: January 1, 2024.</p>
        </body>
      </html>
    `,
    searchResult: {
      title: "Expired Scholarship"
    }
  });

  assert.equal(result.candidate, null);
  assert.equal(result.skipReason, "scholarship_closed");
});

test("discoverScholarshipCandidates runs deterministic search, fetch, and extraction", async () => {
  const fetchImpl = async (url) => {
    const href = typeof url === "string" ? url : url.toString();
    if (href.startsWith("https://api.search.brave.com/res/v1/web/search")) {
      return createMockJsonResponse(SEARCH_JSON);
    }
    if (href === "https://example.org/future-engineers-scholarship") {
      return createMockResponse(GOOD_PAGE_HTML);
    }
    if (href === "https://example.org/top-scholarships-2026") {
      return createMockResponse(LIST_PAGE_HTML);
    }
    throw new Error(`Unexpected URL: ${href}`);
  };

  const result = await discoverScholarshipCandidates({
    sessionId: "discovery-test-1",
    studentStage: "starting_college",
    discoveryMaxResults: 5,
    discoveryQueryBudget: 4,
    documents: [
      {
        documentId: "doc-1",
        fileName: "student.txt",
        rawText: [
          "First Name: Noe",
          "Last Name: Zuleta",
          "Intended Major: Mechanical Engineering",
          "Ethnicity: Hispanic/Latino",
          "State: California",
          "GPA: 3.9",
          "Current Grade Level: 12th grade",
          "Activity: Robotics captain",
          "Award: STEM honors"
        ].join("\n")
      }
    ],
    fetchImpl,
    braveApiKey: "test-brave-key"
  });

  assert.ok(result.queries.length > 0);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].candidate.name, "Future Engineers Scholarship");
  assert.equal(result.candidates[0].candidate.awardAmount, 5000);
  assert.ok(result.candidates[0].score > 0);
  assert.equal(result.diagnostics.searchResults > 0, true);
  assert.equal(result.diagnostics.fetchedPages, 2);
});

test("discoverScholarshipCandidates skips explicitly ineligible scholarships instead of importing them", async () => {
  const fetchImpl = async (url) => {
    const href = typeof url === "string" ? url : url.toString();
    if (href.startsWith("https://api.search.brave.com/res/v1/web/search")) {
      return createMockJsonResponse({
        web: {
          results: [
            {
              title: "Hue Ta Asian American Scholarship",
              url: "https://bold.org/scholarships/hue-ta-asian-american-scholarship/",
              description: "Scholarship supporting Asian American students."
            }
          ]
        }
      });
    }
    if (href === "https://bold.org/scholarships/hue-ta-asian-american-scholarship/") {
      return createMockResponse(EXPLICIT_ETHNICITY_PAGE_HTML);
    }
    throw new Error(`Unexpected URL: ${href}`);
  };

  const result = await discoverScholarshipCandidates({
    sessionId: "discovery-test-ineligible-ethnicity",
    studentStage: "starting_college",
    discoveryMaxResults: 5,
    discoveryQueryBudget: 2,
    documents: [
      {
        documentId: "doc-1",
        fileName: "student.txt",
        rawText: [
          "First Name: Noe",
          "Last Name: Zuleta",
          "Intended Major: Mechanical Engineering",
          "Ethnicity: Hispanic/Latino",
          "State: California",
          "GPA: 3.9",
          "Current Grade Level: 12th grade"
        ].join("\n")
      }
    ],
    fetchImpl,
    braveApiKey: "test-brave-key"
  });

  assert.equal(result.candidates.length, 0);
  assert.ok(result.logs.some((line) => /reason=profile_ineligible/.test(line)));
});

test("discoverScholarshipCandidates skips recently fetched URLs from history on rerun", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "discovery-history-test-"));
  const historyPath = path.join(tempDir, "url-history.json");
  const now = new Date().toISOString();
  await fs.writeFile(historyPath, JSON.stringify([
    {
      url: "https://example.org/future-engineers-scholarship",
      normalizedUrl: "https://example.org/future-engineers-scholarship",
      sourceDomain: "example.org",
      pageType: "direct_scholarship",
      lastSeenAt: now,
      lastFetchedAt: now,
      lastSearchQuery: "mechanical engineering scholarship incoming college freshman",
      lastError: "",
      candidateId: "future-engineers-scholarship-example.org",
      candidateName: "Future Engineers Scholarship"
    }
  ], null, 2));

  const originalHistoryPath = process.env.DISCOVERY_URL_HISTORY_PATH;
  process.env.DISCOVERY_URL_HISTORY_PATH = historyPath;

  const fetchedUrls = [];
  const fetchImpl = async (url) => {
    const href = typeof url === "string" ? url : url.toString();
    if (href.startsWith("https://api.search.brave.com/res/v1/web/search")) {
      return createMockJsonResponse({
        web: {
          results: [
            {
              title: "Future Engineers Scholarship",
              url: "https://example.org/future-engineers-scholarship",
              description: "Known scholarship already seen."
            },
            {
              title: "New Community STEM Award",
              url: "https://example.org/new-community-stem-award",
              description: "New scholarship for incoming engineering freshmen."
            }
          ]
        }
      });
    }
    fetchedUrls.push(href);
    if (href === "https://example.org/new-community-stem-award") {
      return createMockResponse(GOOD_PAGE_HTML.replaceAll("Future Engineers Scholarship", "New Community STEM Award"));
    }
    if (href === "https://example.org/future-engineers-scholarship") {
      throw new Error("recent history URL should have been skipped");
    }
    throw new Error(`Unexpected URL: ${href}`);
  };

  try {
    const result = await discoverScholarshipCandidates({
      sessionId: "discovery-test-history-skip",
      studentStage: "starting_college",
      discoveryMaxResults: 5,
      discoveryQueryBudget: 2,
      documents: [
        {
          documentId: "doc-1",
          fileName: "student.txt",
          rawText: [
            "First Name: Noe",
            "Last Name: Zuleta",
            "Intended Major: Mechanical Engineering",
            "Ethnicity: Hispanic/Latino",
            "State: California",
            "GPA: 3.9",
            "Current Grade Level: 12th grade"
          ].join("\n")
        }
      ],
      fetchImpl,
      enableUrlHistory: true,
      braveApiKey: "test-brave-key"
    });

    assert.equal(result.diagnostics.historySkippedPages >= 1, true);
    assert.ok(result.logs.some((line) => /history-skip/.test(line)));
    assert.deepEqual(fetchedUrls, ["https://example.org/new-community-stem-award"]);
  } finally {
    if (originalHistoryPath === undefined) {
      delete process.env.DISCOVERY_URL_HISTORY_PATH;
    } else {
      process.env.DISCOVERY_URL_HISTORY_PATH = originalHistoryPath;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("discoverScholarshipCandidates expands scholarship list pages into individual scholarship pages", async () => {
  const listOnlySearchJson = {
    web: {
      results: [
        {
          title: "Mechanical Engineering Scholarships for 2026",
          url: "https://scholarships360.org/scholarships/mechanical-engineering-scholarships/",
          description: "Roundup of scholarships for mechanical engineering students."
        }
      ]
    }
  };

  const fetchImpl = async (url) => {
    const href = typeof url === "string" ? url : url.toString();
    if (href.startsWith("https://api.search.brave.com/res/v1/web/search")) {
      return createMockJsonResponse(listOnlySearchJson);
    }
    if (href === "https://scholarships360.org/scholarships/mechanical-engineering-scholarships/") {
      return createMockResponse(AGGREGATOR_PAGE_HTML);
    }
    if (href === "https://scholarships360.org/scholarships/search/future-engineers-scholarship/") {
      return createMockResponse(GOOD_PAGE_HTML);
    }
    return createMockResponse("<html><body><h1>Placeholder</h1></body></html>");
  };

  const result = await discoverScholarshipCandidates({
    sessionId: "discovery-test-list-expand",
    studentStage: "starting_college",
    discoveryMaxResults: 5,
    discoveryQueryBudget: 2,
    documents: [
      {
        documentId: "doc-1",
        fileName: "student.txt",
        rawText: [
          "First Name: Noe",
          "Last Name: Zuleta",
          "Intended Major: Mechanical Engineering",
          "Ethnicity: Hispanic/Latino",
          "State: California",
          "GPA: 3.9",
          "Current Grade Level: 12th grade"
        ].join("\n")
      }
    ],
    fetchImpl,
    braveApiKey: "test-brave-key"
  });

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].candidate.name, "Future Engineers Scholarship");
  assert.ok(result.candidates[0].matchReasons.includes("list_expanded"));
});

test("discoverScholarshipCandidates can use AI to reclassify borderline pages into list expansion", async () => {
  const guideSearchJson = {
    web: {
      results: [
        {
          title: "Future Engineers Scholarship",
          url: "https://example.org/scholarships/future-engineers-scholarship-guide",
          description: "Engineering scholarship guide page."
        }
      ]
    }
  };

  const fetchImpl = async (url) => {
    const href = typeof url === "string" ? url : url.toString();
    if (href.startsWith("https://api.search.brave.com/res/v1/web/search")) {
      return createMockJsonResponse(guideSearchJson);
    }
    if (href === "https://example.org/scholarships/future-engineers-scholarship-guide") {
      return createMockResponse(BORDERLINE_GUIDE_PAGE_HTML);
    }
    if (href === "https://example.org/scholarships/future-engineers-award") {
      return createMockResponse(GOOD_PAGE_HTML);
    }
    return createMockResponse("<html><body><h1>Placeholder</h1></body></html>");
  };

  const result = await discoverScholarshipCandidates({
    sessionId: "discovery-test-ai-list-reclassify",
    studentStage: "starting_college",
    discoveryMaxResults: 5,
    discoveryQueryBudget: 2,
    documents: [
      {
        documentId: "doc-1",
        fileName: "student.txt",
        rawText: [
          "First Name: Noe",
          "Last Name: Zuleta",
          "Intended Major: Mechanical Engineering",
          "Ethnicity: Hispanic/Latino",
          "State: California",
          "GPA: 3.9",
          "Current Grade Level: 12th grade"
        ].join("\n")
      }
    ],
    fetchImpl,
    braveApiKey: "test-brave-key",
    enableAiPageClassifier: true,
    aiClassifyPageEvaluationsImpl: async ({ pages }) => ({
      decisions: (pages || []).map((page) => ({
        sourceUrl: page.sourceUrl,
        classification: "scholarship_list_page",
        confidence: 0.94,
        rationale: "This page is a guide that links to multiple scholarships."
      })),
      metadata: {
        mode: "test_stub"
      }
    })
  });

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].candidate.name, "Future Engineers Scholarship");
  assert.ok(result.candidates[0].matchReasons.includes("list_expanded"));
  assert.equal(result.diagnostics.aiPageClassifier.mode, "test_stub");
});

test("discoverScholarshipCandidates can use AI to rescue misclassified list-page rejects as direct scholarships", async () => {
  const searchJson = {
    web: {
      results: [
        {
          title: "Future Engineers Scholarship",
          url: "https://example.org/scholarships/future-engineers-scholarship",
          description: "Scholarship for incoming engineering students."
        }
      ]
    }
  };

  const fetchImpl = async (url) => {
    const href = typeof url === "string" ? url : url.toString();
    if (href.startsWith("https://api.search.brave.com/res/v1/web/search")) {
      return createMockJsonResponse(searchJson);
    }
    if (href === "https://example.org/scholarships/future-engineers-scholarship") {
      return createMockResponse(LISTY_DETAIL_PAGE_HTML);
    }
    return createMockResponse("<html><body><h1>Placeholder</h1></body></html>");
  };

  const result = await discoverScholarshipCandidates({
    sessionId: "discovery-test-ai-direct-rescue",
    studentStage: "starting_college",
    discoveryMaxResults: 5,
    discoveryQueryBudget: 2,
    documents: [
      {
        documentId: "doc-1",
        fileName: "student.txt",
        rawText: [
          "First Name: Noe",
          "Last Name: Zuleta",
          "Intended Major: Mechanical Engineering",
          "Ethnicity: Hispanic/Latino",
          "State: California",
          "GPA: 3.9",
          "Current Grade Level: 12th grade"
        ].join("\n")
      }
    ],
    fetchImpl,
    braveApiKey: "test-brave-key",
    enableAiPageClassifier: true,
    aiClassifyPageEvaluationsImpl: async ({ pages }) => ({
      decisions: (pages || []).map((page) => ({
        sourceUrl: page.sourceUrl,
        classification: "direct_scholarship",
        confidence: 0.96,
        rationale: "This page is primarily describing one scholarship even though it links to related awards."
      })),
      metadata: {
        mode: "test_stub"
      }
    })
  });

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].candidate.name, "Future Engineers Scholarship");
  assert.equal(result.candidates[0].candidate.awardAmount, 5000);
  assert.ok(result.candidates[0].matchReasons.includes("ai_page_rescue"));
  assert.equal(result.diagnostics.aiPageClassifier.mode, "test_stub");
});

test("discoverScholarshipCandidates supports bounded recursive list expansion", async () => {
  const nestedListSearchJson = {
    web: {
      results: [
        {
          title: "Engineering Scholarships Hub",
          url: "https://example.org/engineering-awards-hub",
          description: "Directory of engineering scholarships."
        }
      ]
    }
  };

  const fetchImpl = async (url) => {
    const href = typeof url === "string" ? url : url.toString();
    if (href.startsWith("https://api.search.brave.com/res/v1/web/search")) {
      return createMockJsonResponse(nestedListSearchJson);
    }
    if (href === "https://example.org/engineering-awards-hub") {
      return createMockResponse(NESTED_LIST_PAGE_HTML);
    }
    if (href === "https://example.org/scholarships/future-engineers-scholarship-hub") {
      return createMockResponse(AGGREGATOR_PAGE_HTML);
    }
    if (href === "https://example.org/scholarships/search/future-engineers-scholarship/") {
      return createMockResponse(GOOD_PAGE_HTML);
    }
    return createMockResponse("<html><body><h1>Placeholder</h1></body></html>");
  };

  const result = await discoverScholarshipCandidates({
    sessionId: "discovery-test-recursive-list-expand",
    studentStage: "starting_college",
    discoveryMaxResults: 5,
    discoveryQueryBudget: 2,
    documents: [
      {
        documentId: "doc-1",
        fileName: "student.txt",
        rawText: [
          "First Name: Noe",
          "Last Name: Zuleta",
          "Intended Major: Mechanical Engineering",
          "Ethnicity: Hispanic/Latino",
          "State: California",
          "GPA: 3.9",
          "Current Grade Level: 12th grade"
        ].join("\n")
      }
    ],
    fetchImpl,
    braveApiKey: "test-brave-key",
    enableAiPageClassifier: false,
    maxListExpansionDepth: 2
  });

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].candidate.name, "Future Engineers Scholarship");
  assert.ok(result.candidates[0].matchReasons.includes("list_expanded"));
  assert.ok(result.logs.some((line) => /depth 1/i.test(line)));
  assert.ok(result.logs.some((line) => /depth 2/i.test(line)));
});

test("discoverScholarshipCandidates still expands child links when top-level result set is large", async () => {
  const manyQueriesFetch = async (url) => {
    const href = typeof url === "string" ? url : url.toString();
    if (href.startsWith("https://api.search.brave.com/res/v1/web/search")) {
      const parsed = new URL(href);
      const q = parsed.searchParams.get("q") || "default";
      const slug = q.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "query";
      return createMockJsonResponse({
        web: {
          results: Array.from({ length: 6 }, (_, index) => ({
            title: `Hub ${slug} ${index + 1}`,
            url: `https://example.org/${slug}/hub-${index + 1}`,
            description: "Roundup of scholarships."
          }))
        }
      });
    }
    if (/https:\/\/example\.org\/.+\/hub-\d+$/.test(href)) {
      return createMockResponse(`
        <html>
          <head><title>Scholarship Directory</title></head>
          <body>
            <h1>Scholarship Directory</h1>
            <p>Browse a list of scholarships.</p>
            <a href="/scholarships/search/future-engineers-scholarship/">Future Engineers Scholarship</a>
          </body>
        </html>
      `);
    }
    if (href === "https://example.org/scholarships/search/future-engineers-scholarship/") {
      return createMockResponse(GOOD_PAGE_HTML);
    }
    return createMockResponse("<html><body><h1>Placeholder</h1></body></html>");
  };

  const result = await discoverScholarshipCandidates({
    sessionId: "discovery-test-large-top-level-expansion",
    studentStage: "starting_college",
    discoveryMaxResults: 5,
    discoveryQueryBudget: 5,
    documents: [
      {
        documentId: "doc-1",
        fileName: "student.txt",
        rawText: [
          "First Name: Noe",
          "Last Name: Zuleta",
          "Intended Major: Mechanical Engineering",
          "Ethnicity: Hispanic/Latino",
          "State: California",
          "GPA: 3.9",
          "Current Grade Level: 12th grade"
        ].join("\n")
      }
    ],
    fetchImpl: manyQueriesFetch,
    braveApiKey: "test-brave-key",
    enableAiPageClassifier: false,
    maxListExpansionDepth: 1
  });

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].candidate.name, "Future Engineers Scholarship");
  assert.ok(result.logs.some((line) => /\[expand\] queued/i.test(line)));
});

test("discoverScholarshipCandidates allows promising depth-3 expansion on manual reruns", async () => {
  const searchJson = {
    web: {
      results: [
        {
          title: "Engineering Scholarships Hub",
          url: "https://example.org/engineering-awards-hub",
          description: "Directory of engineering scholarships."
        }
      ]
    }
  };

  const fetchImpl = async (url) => {
    const href = typeof url === "string" ? url : url.toString();
    if (href.startsWith("https://api.search.brave.com/res/v1/web/search")) {
      return createMockJsonResponse(searchJson);
    }
    if (href === "https://example.org/engineering-awards-hub") {
      return createMockResponse(NESTED_LIST_PAGE_HTML);
    }
    if (href === "https://example.org/scholarships/future-engineers-scholarship-hub") {
      return createMockResponse(PROMISING_FRESHMAN_LIST_PAGE_HTML);
    }
    if (href === "https://example.org/scholarships/future-engineers-freshman-scholarship") {
      return createMockResponse(PROMISING_FRESHMAN_LIST_PAGE_HTML.replace(
        "/scholarships/future-engineers-freshman-scholarship",
        "/scholarships/search/future-engineers-scholarship/"
      ).replace(
        /Future Engineers Freshman Scholarship/g,
        "Future Engineers Scholarship Directory"
      ));
    }
    if (href === "https://example.org/scholarships/search/future-engineers-scholarship/") {
      return createMockResponse(GOOD_PAGE_HTML);
    }
    return createMockResponse("<html><body><h1>Placeholder</h1></body></html>");
  };

  const result = await discoverScholarshipCandidates({
    sessionId: "discovery-test-manual-depth-3",
    studentStage: "starting_college",
    discoveryMaxResults: 5,
    discoveryQueryBudget: 2,
    documents: [
      {
        documentId: "doc-1",
        fileName: "student.txt",
        rawText: [
          "First Name: Noe",
          "Last Name: Zuleta",
          "Intended Major: Mechanical Engineering",
          "Ethnicity: Hispanic/Latino",
          "State: California",
          "GPA: 3.9",
          "Current Grade Level: 12th grade"
        ].join("\n")
      }
    ],
    fetchImpl,
    braveApiKey: "test-brave-key",
    enableAiPageClassifier: false,
    maxListExpansionDepth: 2,
    manualRerun: true
  });

  assert.ok(result.logs.some((line) => /effective_max_depth=3/i.test(line)));
  assert.ok(result.logs.some((line) => /\[expand\] queued .* depth 3/i.test(line)));
  assert.ok(!result.logs.some((line) => /depth_3_not_promising/i.test(line)));
});

test("discoverScholarshipCandidates surfaces search-provider API failures", async () => {
  const fetchImpl = async (url) => {
    const href = typeof url === "string" ? url : url.toString();
    if (href.startsWith("https://api.search.brave.com/res/v1/web/search")) {
      return createMockJsonResponse({
        error: {
          detail: "Rate limit exceeded"
        }
      }, { status: 429 });
    }
    throw new Error(`Unexpected URL: ${href}`);
  };

  await assert.rejects(
    () => discoverScholarshipCandidates({
      sessionId: "discovery-test-2",
      studentStage: "starting_college",
      discoveryMaxResults: 5,
      discoveryQueryBudget: 2,
      documents: [
        {
          documentId: "doc-1",
          fileName: "student.txt",
          rawText: [
            "First Name: Noe",
            "Last Name: Zuleta",
            "Intended Major: Mechanical Engineering, B.S.",
            "Ethnicity: Hispanic/Latino",
            "State: California"
          ].join("\n")
        }
      ],
      fetchImpl,
      braveApiKey: "test-brave-key"
    }),
    /Brave search request failed \(429\)/i
  );
});
