import test from "node:test";
import assert from "node:assert/strict";
import { batchFetchPageBundles } from "../src/discovery/batchFetchPageBundles.js";

function createMockTextResponse(body, {
  status = 200,
  contentType = "text/html; charset=utf-8",
  url = ""
} = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: {
      get(name) {
        return String(name || "").toLowerCase() === "content-type" ? contentType : "";
      }
    },
    async text() {
      return String(body || "");
    }
  };
}

test("batchFetchPageBundles returns bounded page bundles with explicit stage mismatch and evidence snippets", async () => {
  const fetchImpl = async () => createMockTextResponse(`
    <html>
      <head><title>Latinos in Technology Scholarship</title></head>
      <body>
        <h1>Latinos in Technology Scholarship</h1>
        <p>For Latino students who have declared a major in a STEM-related field.</p>
        <p>We financially support third and fourth-year undergraduate Latino students at a 4-year university.</p>
        <p>Award amount: $6,000 per year.</p>
        <p>Application deadline: March 1, 2027.</p>
        <p>Applicants must be enrolled full-time and maintain good academic standing.</p>
      </body>
    </html>
  `, {
    url: "https://www.svcf.org/scholarships/latinos-in-technology-scholarship"
  });

  const result = await batchFetchPageBundles({
    urls: ["https://www.svcf.org/scholarships/latinos-in-technology-scholarship"],
    profile: {
      personalInfo: {
        intendedMajor: "Mechanical Engineering",
        ethnicity: "Hispanic/Latino",
        state: "California"
      },
      academics: {
        gradeLevel: "12th grade"
      }
    },
    studentStage: "starting_college",
    fetchImpl
  });

  assert.equal(result.pages.length, 1);
  assert.equal(result.pages[0].canonicalUrl, "https://www.svcf.org/scholarships/latinos-in-technology-scholarship");
  assert.equal(result.pages[0].fetchStatus, "ok");
  assert.equal(result.pages[0].blockers.explicitStageMismatchSignal, true);
  assert.equal(result.pages[0].fitSignals.majorMatchSignal, true);
  assert.equal(result.pages[0].fitSignals.ethnicityMatchSignal, true);
  assert.equal(result.pages[0].fitSignals.specificSchoolSignal, false);
  assert.equal(result.pages[0].pageSignals.directScholarshipSignal, true);
  assert.equal(result.pages[0].pageSignals.deadlineSignal, true);
  assert.equal(result.pages[0].pageSignals.awardAmountSignal, true);
  assert.ok(/March 1, 2027/i.test(String(result.pages[0].evidenceSnippets.deadlineSnippet || "")));
  assert.ok(/third and fourth-year undergraduate/i.test(String(result.pages[0].evidenceSnippets.stageRestrictionSnippet || "")));
});

test("batchFetchPageBundles extracts compact child links, respects history, and flags indirect stale pages", async () => {
  const staleYear = new Date().getUTCFullYear() - 2;
  const fetchImpl = async (url) => {
    if (/indirect-page/.test(String(url))) {
      return createMockTextResponse(`
        <html>
          <head><title>These scholarship applications are currently open</title></head>
          <body>
            <p>The deadline for this scholarship is November 15, ${staleYear}.</p>
            <p>Learn more on the website of the American Meteorological Society.</p>
          </body>
        </html>
      `, { url: "https://example.org/indirect-page" });
    }

    return createMockTextResponse(`
      <html>
        <head><title>Engineering Scholarships</title></head>
        <body>
          <h1>Engineering Scholarships</h1>
          <p>Browse current scholarship opportunities and application details.</p>
          <a href="/scholarships/future-engineers-award">Future Engineers Award</a>
          <a href="https://partner.example.com/scholarship/community-stem-award">Community STEM Award</a>
          <a href="/about">About</a>
          <a href="/scholarships/future-engineers-award">Future Engineers Award Duplicate</a>
        </body>
      </html>
    `, { url: "https://example.org/hub" });
  };

  const urlHistory = new Map([
    [
      "https://partner.example.com/scholarship/community-stem-award",
      {
        normalizedUrl: "https://partner.example.com/scholarship/community-stem-award",
        url: "https://partner.example.com/scholarship/community-stem-award",
        sourceDomain: "partner.example.com",
        pageType: "direct_scholarship",
        lastFetchedAt: new Date().toISOString()
      }
    ]
  ]);

  const result = await batchFetchPageBundles({
    urls: ["https://example.org/hub", "https://example.org/indirect-page"],
    profile: {
      personalInfo: {
        intendedMajor: "Mechanical Engineering"
      },
      academics: {
        gradeLevel: "12th grade"
      }
    },
    studentStage: "starting_college",
    maxChildLinksPerPage: 5,
    fetchImpl,
    urlHistory
  });

  const hub = result.pages.find((page) => page.canonicalUrl === "https://example.org/hub");
  const indirect = result.pages.find((page) => page.canonicalUrl === "https://example.org/indirect-page");

  assert.equal(hub?.pageSignals.listSignal, true);
  assert.equal(hub?.fitSignals.specificSchoolSignal, false);
  assert.equal(hub?.childLinks.length, 2);
  assert.deepEqual(hub?.childLinks[0], {
    url: "https://example.org/scholarships/future-engineers-award",
    anchorText: "Future Engineers Award",
    sourceDomain: "example.org",
    sameDomain: true,
    detailPathLikely: true,
    seenRecently: false
  });
  assert.equal(hub?.childLinks[1].sameDomain, false);
  assert.equal(hub?.childLinks[1].seenRecently, true);

  assert.equal(indirect?.blockers.pastCycleSignal, true);
  assert.equal(indirect?.pageSignals.indirectContentSignal, true);
});

test("batchFetchPageBundles does not mark mixed-stage school pages as explicit mismatches and surfaces school specificity", async () => {
  const fetchImpl = async () => createMockTextResponse(`
    <html>
      <head><title>UCLA Samueli Scholarships For Undergraduates | OASA</title></head>
      <body>
        <h1>UCLA Samueli Undergraduate Scholarships</h1>
        <p>We have scholarship opportunities available for students of all backgrounds including new freshman and transfers.</p>
        <p>The Samueli School of Engineering offers scholarships for undergraduate students studying engineering at UCLA.</p>
        <p>Application period June 1st - June 26th, 2026.</p>
      </body>
    </html>
  `, {
    url: "https://www.seasoasa.ucla.edu/scholarships-for-undergraduates/"
  });

  const result = await batchFetchPageBundles({
    urls: ["https://www.seasoasa.ucla.edu/scholarships-for-undergraduates/"],
    profile: {
      personalInfo: {
        intendedMajor: "Mechanical Engineering",
        state: "California"
      },
      academics: {
        gradeLevel: "12th grade"
      }
    },
    studentStage: "starting_college",
    fetchImpl
  });

  assert.equal(result.pages.length, 1);
  assert.equal(result.pages[0].blockers.explicitStageMismatchSignal, false);
  assert.equal(result.pages[0].fitSignals.stageMatchSignal, true);
  assert.equal(result.pages[0].fitSignals.specificSchoolSignal, true);
});

test("batchFetchPageBundles does not treat current and incoming student hubs as explicit stage mismatches", async () => {
  const fetchImpl = async () => createMockTextResponse(`
    <html>
      <head><title>Mechanical Engineering Scholarships Opportunities</title></head>
      <body>
        <h1>Mechanical Engineering Scholarships Opportunities</h1>
        <p>The Mechanical and Aerospace Engineering department offers various scholarship opportunities to current and incoming students to the college of engineering.</p>
        <p>These scholarships are awarded to our prominent Mechanical Engineering undergraduate students who meet the qualifications.</p>
        <a href="/scholarships/joe-carolyn-hynes-endowed-scholarship-mechanical-engineering">Joe & Carolyn Hynes Endowed Scholarship in Mechanical Engineering</a>
      </body>
    </html>
  `, {
    url: "https://www.me.uh.edu/undergraduate/scholarships"
  });

  const result = await batchFetchPageBundles({
    urls: ["https://www.me.uh.edu/undergraduate/scholarships"],
    profile: {
      personalInfo: {
        intendedMajor: "Mechanical Engineering",
        state: "California"
      },
      academics: {
        gradeLevel: "12th grade"
      }
    },
    studentStage: "starting_college",
    fetchImpl
  });

  assert.equal(result.pages.length, 1);
  assert.equal(result.pages[0].fitSignals.stageMatchSignal, true);
  assert.equal(result.pages[0].blockers.explicitStageMismatchSignal, false);
  assert.equal(result.pages[0].fitSignals.specificSchoolSignal, true);
});

test("batchFetchPageBundles treats application closes dates as expired blockers when the close date is in the past", async () => {
  const fetchImpl = async () => createMockTextResponse(`
    <html>
      <head><title>ScholarSHPE - SHPE</title></head>
      <body>
        <h1>ScholarSHPE</h1>
        <p>Currently we have a few offerings that are available to high school seniors.</p>
        <p><strong>Application opens:</strong> February 2, 2026</p>
        <p><strong>Application closes:</strong> February 16, 2026</p>
        <p>Students must be enrolled full-time at a community college or 4-year university.</p>
      </body>
    </html>
  `, {
    url: "https://shpe.org/engage/programs/scholarshpe/"
  });

  const result = await batchFetchPageBundles({
    urls: ["https://shpe.org/engage/programs/scholarshpe/"],
    profile: {
      personalInfo: {
        intendedMajor: "Mechanical Engineering",
        ethnicity: "Hispanic/Latino",
        state: "California"
      },
      academics: {
        gradeLevel: "12th grade"
      }
    },
    studentStage: "starting_college",
    fetchImpl
  });

  assert.equal(result.pages.length, 1);
  assert.equal(result.pages[0].blockers.closedSignal, true);
  assert.equal(result.pages[0].pageSignals.deadlineSignal, true);
  assert.match(String(result.pages[0].evidenceSnippets.deadlineSnippet || ""), /application closes/i);
  assert.equal(result.pages[0].fitSignals.stageMatchSignal, true);
});

test("batchFetchPageBundles treats current-cycle partial deadlines as expired blockers", async () => {
  const fetchImpl = async () => createMockTextResponse(`
    <html>
      <head><title>Engineering Scholarships - High School Seniors - ASME</title></head>
      <body>
        <h1>High School Scholarships</h1>
        <p>Attention graduating high school seniors!</p>
        <p>Students must be enrolled full-time in an ABET-accredited mechanical engineering program no later than the fall after their senior year in high school.</p>
        <p>High School Senior Application Deadline March 15</p>
        <p>Award amount: $3,000.</p>
        <a href="https://asme.applyists.net/ASMEHS">Apply Today</a>
      </body>
    </html>
  `, {
    url: "https://www.asme.org/asme-programs/students-and-faculty/scholarships/available-high-school-scholarships"
  });

  const result = await batchFetchPageBundles({
    urls: ["https://www.asme.org/asme-programs/students-and-faculty/scholarships/available-high-school-scholarships"],
    profile: {
      personalInfo: {
        intendedMajor: "Mechanical Engineering",
        state: "California"
      },
      academics: {
        gradeLevel: "12th grade"
      }
    },
    studentStage: "starting_college",
    now: new Date("2026-04-10T12:00:00Z"),
    fetchImpl
  });

  assert.equal(result.pages.length, 1);
  assert.equal(result.pages[0].blockers.closedSignal, true);
  assert.equal(result.pages[0].pageSignals.deadlineSignal, true);
  assert.match(String(result.pages[0].evidenceSnippets.deadlineSnippet || ""), /deadline march 15/i);
});

test("batchFetchPageBundles flags aggregator detail pages and offsite original-source links", async () => {
  const fetchImpl = async () => createMockTextResponse(`
    <html>
      <head><title>Latinos in Technology Scholarship - Access Scholarships</title></head>
      <body>
        <h1>Latinos in Technology Scholarship</h1>
        <nav>
          <a href="/scholarship-directory">Scholarship Directory</a>
          <a href="/submit-a-scholarship">Submit a Scholarship</a>
        </nav>
        <p>Eligibility: Must be of Latino or Hispanic origin.</p>
        <p>Application form required. Transcript required. Essay required.</p>
        <p>How To Apply Online at:
          <a href="https://www.siliconvalleycf.org/scholarships/lit">Apply Online</a>
        </p>
        <p>$30,000 Value. 03/01 Deadline.</p>
        <p>See something that's not right? Print Scholarship.</p>
      </body>
    </html>
  `, {
    url: "https://accessscholarships.com/scholarship/latinos-in-technology-scholarship"
  });

  const result = await batchFetchPageBundles({
    urls: ["https://accessscholarships.com/scholarship/latinos-in-technology-scholarship"],
    profile: {
      personalInfo: {
        intendedMajor: "Mechanical Engineering",
        ethnicity: "Hispanic/Latino",
        state: "California"
      },
      academics: {
        gradeLevel: "12th grade"
      }
    },
    studentStage: "starting_college",
    fetchImpl
  });

  const page = result.pages[0];
  assert.equal(page.pageSignals.aggregatorSummarySignal, true);
  assert.equal(page.pageSignals.originalSourceLinkSignal, true);
  assert.equal(page.pageSignals.indirectContentSignal, true);
  assert.equal(page.pageSignals.listSignal, true);
  assert.equal(page.pageSignals.directScholarshipSignal, false);
  assert.ok(page.childLinks.some((link) => link.url === "https://www.siliconvalleycf.org/scholarships/lit"));
});

test("batchFetchPageBundles prefers scholarship document title over noisy non-scholarship heading", async () => {
  const fetchImpl = async () => createMockTextResponse(`
    <html>
      <head><title>HACU Scholarship Program - HACU</title></head>
      <body>
        <h1>HACU 40th Annual Conference</h1>
        <p>American Red Cross Biomedical Services (OPEN)</p>
        <p>Amount: $3,000. Term or Year: Fall 2026.</p>
        <p>Deadline Extended: April 15, 2026 at 11:59 p.m.</p>
        <p>Eligible students should complete extra steps like essays if required.</p>
      </body>
    </html>
  `, {
    url: "https://hacu.net/programs/hacu-scholarship-program/"
  });

  const result = await batchFetchPageBundles({
    urls: ["https://hacu.net/programs/hacu-scholarship-program/"],
    profile: {
      personalInfo: {
        intendedMajor: "Mechanical Engineering",
        ethnicity: "Hispanic/Latino",
        state: "California"
      },
      academics: {
        gradeLevel: "12th grade"
      }
    },
    studentStage: "starting_college",
    fetchImpl
  });

  assert.equal(result.pages[0].title, "HACU Scholarship Program - HACU");
});
