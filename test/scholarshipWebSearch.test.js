import test from "node:test";
import assert from "node:assert/strict";
import { scholarshipWebSearch } from "../src/discovery/scholarshipWebSearch.js";

function createMockJsonResponse(body, { status = 200 } = {}) {
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

test("scholarshipWebSearch returns normalized search results with scholarship heuristics", async () => {
  const fetchImpl = async () => createMockJsonResponse({
    web: {
      results: [
        {
          title: "Future Engineers Scholarship",
          url: "https://example.org/future-engineers-scholarship",
          description: "Scholarship for mechanical engineering students in California and incoming college freshmen."
        },
        {
          title: "Top Scholarships 2026",
          url: "https://example.org/top-scholarships-2026",
          description: "A roundup of many awards."
        }
      ]
    }
  });

  const result = await scholarshipWebSearch({
    queries: ["mechanical engineering scholarship incoming freshman"],
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
    maxResultsPerQuery: 5,
    queryFamily: "specific_fit",
    fetchImpl,
    braveApiKey: "test-key",
    urlHistory: new Map()
  });

  assert.equal(result.provider.name, "brave_search");
  assert.equal(result.provider.requestCount, 1);
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].title, "Future Engineers Scholarship");
  assert.equal(result.results[0].queryFamily, "specific_fit");
  assert.equal(result.results[0].normalizedUrl, "https://example.org/future-engineers-scholarship");
  assert.equal(typeof result.results[0].fitScore, "number");
  assert.equal(result.results[0].heuristics.surfaceType, "direct_likely");
  assert.equal(result.results[0].heuristics.majorMatch, true);
  assert.equal(result.results[0].heuristics.stateMatch, true);
  assert.equal(result.results[0].heuristics.stageMatch, true);
  assert.equal(result.results[0].heuristics.negativeGraduateSignal, false);
  assert.equal(result.results[1].heuristics.surfaceType, "list_likely");
});

test("scholarshipWebSearch filters denied domains and annotates recent history", async () => {
  const fetchImpl = async () => createMockJsonResponse({
    web: {
      results: [
        {
          title: "Future Engineers Scholarship",
          url: "https://example.org/future-engineers-scholarship",
          description: "Scholarship for mechanical engineering students in California and incoming college freshmen."
        },
        {
          title: "Scholarship Advice Roundup",
          url: "https://reddit.com/r/scholarships/comments/example",
          description: "A list of scholarships and advice."
        }
      ]
    }
  });

  const urlHistory = new Map([
    [
      "https://example.org/future-engineers-scholarship",
      {
        normalizedUrl: "https://example.org/future-engineers-scholarship",
        url: "https://example.org/future-engineers-scholarship",
        sourceDomain: "example.org",
        pageType: "direct_scholarship",
        lastFetchedAt: new Date().toISOString()
      }
    ]
  ]);

  const result = await scholarshipWebSearch({
    queries: ["mechanical engineering scholarship incoming freshman"],
    profile: {
      personalInfo: {
        intendedMajor: "Mechanical Engineering",
        state: "CA"
      },
      academics: {
        gradeLevel: "12th grade"
      }
    },
    studentStage: "starting_college",
    domainDenyHints: ["reddit.com"],
    maxResultsPerQuery: 5,
    fetchImpl,
    braveApiKey: "test-key",
    urlHistory
  });

  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].sourceDomain, "example.org");
  assert.equal(result.results[0].heuristics.seenRecently, true);
  assert.ok(result.notes.some((line) => /filtered_denied_domains=reddit.com/.test(line)));
});

test("scholarshipWebSearch classifies roundup pages as list pages and blog subdomains as bloggy", async () => {
  const fetchImpl = async () => createMockJsonResponse({
    web: {
      results: [
        {
          title: "Top 147 Mechanical Engineering Scholarships in April 2026 - Scholarships360",
          url: "https://scholarships360.org/scholarships/mechanical-engineering-scholarships/",
          description: "These mechanical engineering scholarships are designed to support students who are passionate about innovation and problem-solving."
        },
        {
          title: "The 39 Best Engineering Scholarships",
          url: "https://blog.prepscholar.com/engineering-scholarships",
          description: "A guide to engineering scholarships for students."
        },
        {
          title: "ASME mechanical engineering scholarships - ASME",
          url: "https://www.asme.org/asme-programs/students-and-faculty/scholarships",
          description: "Engineering students pursuing ME/MET degrees can apply for ASME scholarships."
        }
      ]
    }
  });

  const result = await scholarshipWebSearch({
    queries: ["mechanical engineering scholarship incoming freshman"],
    profile: {
      personalInfo: {
        intendedMajor: "Mechanical Engineering"
      },
      academics: {
        gradeLevel: "12th grade"
      }
    },
    studentStage: "starting_college",
    maxResultsPerQuery: 8,
    fetchImpl,
    braveApiKey: "test-key",
    urlHistory: new Map()
  });

  const roundup = result.results.find((item) => item.sourceDomain === "scholarships360.org");
  const blog = result.results.find((item) => item.sourceDomain === "blog.prepscholar.com");
  const hub = result.results.find((item) => item.sourceDomain === "asme.org");

  assert.equal(roundup?.heuristics.surfaceType, "list_likely");
  assert.equal(blog?.heuristics.negativeBlogSignal, true);
  assert.equal(hub?.heuristics.surfaceType, "hub_likely");
});

test("scholarshipWebSearch flags stale-cycle and indirect editorial scholarship pages", async () => {
  const staleYear = new Date().getUTCFullYear() - 2;
  const fetchImpl = async () => createMockJsonResponse({
    web: {
      results: [
        {
          title: "These scholarship applications are currently open, and you can apply today",
          url: "https://hispanicengineer.com/these-scholarship-applications-are-currently-open-and-you-can-apply-today/",
          description: `The Minority/Women in STEM Scholarship is open to high school seniors interested in STEM. The deadline for this scholarship is November 15, ${staleYear}.`
        }
      ]
    }
  });

  const result = await scholarshipWebSearch({
    queries: ["hispanic latino engineering scholarship freshman"],
    profile: {
      personalInfo: {
        intendedMajor: "Mechanical Engineering",
        ethnicity: "Hispanic/Latino"
      },
      academics: {
        gradeLevel: "12th grade"
      }
    },
    studentStage: "starting_college",
    maxResultsPerQuery: 8,
    fetchImpl,
    braveApiKey: "test-key",
    urlHistory: new Map()
  });

  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].heuristics.staleCycleSignal, true);
  assert.equal(result.results[0].heuristics.indirectContentSignal, true);
  assert.ok(result.results[0].fitScore < 10);
  assert.equal(result.results[0].heuristics.surfaceType, "list_likely");
});

test("scholarshipWebSearch marks school-specific university results with caution signals", async () => {
  const fetchImpl = async () => createMockJsonResponse({
    web: {
      results: [
        {
          title: "Mechanical Engineering Scholarships Opportunities | UH Department of Mechanical and Aerospace Engineering",
          url: "https://www.me.uh.edu/undergraduate/scholarships",
          description: "Scholarship opportunities for current and incoming students in the college of engineering."
        }
      ]
    }
  });

  const result = await scholarshipWebSearch({
    queries: ["mechanical engineering scholarship incoming freshman"],
    profile: {
      personalInfo: {
        intendedMajor: "Mechanical Engineering"
      },
      academics: {
        gradeLevel: "12th grade"
      }
    },
    studentStage: "starting_college",
    maxResultsPerQuery: 8,
    fetchImpl,
    braveApiKey: "test-key",
    urlHistory: new Map()
  });

  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].heuristics.institutionSpecificSignal, true);
  assert.equal(result.results[0].heuristics.specificSchoolSignal, true);
});

test("scholarshipWebSearch default ranking deprioritizes school-specific results relative to broader fits", async () => {
  const fetchImpl = async () => createMockJsonResponse({
    web: {
      results: [
        {
          title: "Mechanical Engineering Scholarships Opportunities | UH Department of Mechanical and Aerospace Engineering",
          url: "https://www.me.uh.edu/undergraduate/scholarships",
          description: "Scholarship opportunities for current and incoming students in the college of engineering."
        },
        {
          title: "Hispanic Engineers Scholarship",
          url: "https://example.org/hispanic-engineers-scholarship",
          description: "Scholarship for Hispanic mechanical engineering students entering college."
        }
      ]
    }
  });

  const baseRequest = {
    queries: ["mechanical engineering scholarship incoming freshman"],
    profile: {
      personalInfo: {
        intendedMajor: "Mechanical Engineering",
        ethnicity: "Hispanic/Latino"
      },
      academics: {
        gradeLevel: "12th grade"
      }
    },
    studentStage: "starting_college",
    maxResultsPerQuery: 8,
    fetchImpl,
    braveApiKey: "test-key",
    urlHistory: new Map()
  };

  const result = await scholarshipWebSearch(baseRequest);

  assert.equal(result.results[0].url, "https://example.org/hispanic-engineers-scholarship");
  const uh = result.results.find((item) => item.url === "https://www.me.uh.edu/undergraduate/scholarships");
  const broader = result.results.find((item) => item.url === "https://example.org/hispanic-engineers-scholarship");
  assert.ok(uh);
  assert.ok(broader);
  assert.ok(uh.fitScore < broader.fitScore);
});

test("scholarshipWebSearch major_precision variant penalizes broad engineering pages relative to exact-major pages", async () => {
  const fetchImpl = async () => createMockJsonResponse({
    web: {
      results: [
        {
          title: "Mechanical Engineering Scholarship",
          url: "https://example.org/mechanical-engineering-scholarship",
          description: "Scholarship for incoming mechanical engineering freshmen."
        },
        {
          title: "Electrical Engineering Scholarships",
          url: "https://collegescholarships.org/scholarships/engineering/electrical.htm",
          description: "Browse engineering scholarships for undergraduate engineering students."
        }
      ]
    }
  });

  const baseRequest = {
    queries: ["mechanical engineering scholarship incoming freshman"],
    profile: {
      personalInfo: {
        intendedMajor: "Mechanical Engineering"
      },
      academics: {
        gradeLevel: "12th grade"
      }
    },
    studentStage: "starting_college",
    maxResultsPerQuery: 8,
    fetchImpl,
    braveApiKey: "test-key",
    urlHistory: new Map()
  };

  const control = await scholarshipWebSearch({
    ...baseRequest,
    experimentVariant: "control"
  });
  const majorPrecision = await scholarshipWebSearch({
    ...baseRequest,
    experimentVariant: "major_precision"
  });

  const controlBroad = control.results.find((item) => item.url === "https://collegescholarships.org/scholarships/engineering/electrical.htm");
  const variantBroad = majorPrecision.results.find((item) => item.url === "https://collegescholarships.org/scholarships/engineering/electrical.htm");
  const controlExact = control.results.find((item) => item.url === "https://example.org/mechanical-engineering-scholarship");
  const variantExact = majorPrecision.results.find((item) => item.url === "https://example.org/mechanical-engineering-scholarship");

  assert.ok(controlBroad);
  assert.ok(variantBroad);
  assert.ok(controlExact);
  assert.ok(variantExact);
  assert.ok(variantBroad.fitScore < controlBroad.fitScore);
  assert.ok((variantExact.fitScore - variantBroad.fitScore) > (controlExact.fitScore - controlBroad.fitScore));
});

test("scholarshipWebSearch direct_link_push boosts action-oriented direct pages over plural list pages", async () => {
  const fetchImpl = async () => createMockJsonResponse({
    web: {
      results: [
        {
          title: "Mechanical Engineering Scholarship",
          url: "https://example.org/mechanical-engineering-scholarship",
          description: "Apply now. Eligibility for incoming college freshmen. Deadline is November 1, 2026."
        },
        {
          title: "Mechanical Engineering Scholarships",
          url: "https://example.org/mechanical-engineering-scholarships",
          description: "Browse scholarships and opportunities for engineering students."
        }
      ]
    }
  });

  const baseRequest = {
    queries: ["mechanical engineering scholarship incoming freshman"],
    profile: {
      personalInfo: {
        intendedMajor: "Mechanical Engineering"
      },
      academics: {
        gradeLevel: "12th grade"
      }
    },
    studentStage: "starting_college",
    maxResultsPerQuery: 8,
    fetchImpl,
    braveApiKey: "test-key",
    urlHistory: new Map()
  };

  const control = await scholarshipWebSearch({
    ...baseRequest,
    experimentVariant: "control"
  });
  const directLinkPush = await scholarshipWebSearch({
    ...baseRequest,
    experimentVariant: "direct_link_push"
  });

  const controlDirect = control.results.find((item) => item.url === "https://example.org/mechanical-engineering-scholarship");
  const controlList = control.results.find((item) => item.url === "https://example.org/mechanical-engineering-scholarships");
  const variantDirect = directLinkPush.results.find((item) => item.url === "https://example.org/mechanical-engineering-scholarship");
  const variantList = directLinkPush.results.find((item) => item.url === "https://example.org/mechanical-engineering-scholarships");

  assert.ok(controlDirect);
  assert.ok(controlList);
  assert.ok(variantDirect);
  assert.ok(variantList);
  assert.ok(variantList.fitScore < controlList.fitScore);
  assert.ok(variantDirect.fitScore > variantList.fitScore);
  assert.ok(directLinkPush.results[0].url === "https://example.org/mechanical-engineering-scholarship");
});

test("scholarshipWebSearch does not classify scholarship homepages and center pages as direct", async () => {
  const fetchImpl = async () => createMockJsonResponse({
    web: {
      results: [
        {
          title: "Hispanic Scholarship Fund: Home",
          url: "https://www.hsf.net/",
          description: "Scholarships and resources for Hispanic students."
        },
        {
          title: "UCLA Scholarship Center | First-Year Students",
          url: "https://www.scholarshipcenter.ucla.edu/src-donor-scholarships/first-year-students/",
          description: "Browse donor scholarships for first-year students."
        },
        {
          title: "Future Engineers Scholarship",
          url: "https://example.org/future-engineers-scholarship",
          description: "Apply now. Incoming college freshmen pursuing engineering may qualify."
        }
      ]
    }
  });

  const result = await scholarshipWebSearch({
    queries: ["mechanical engineering scholarship incoming freshman"],
    profile: {
      personalInfo: {
        intendedMajor: "Mechanical Engineering",
        ethnicity: "Hispanic/Latino"
      },
      academics: {
        gradeLevel: "12th grade"
      }
    },
    studentStage: "starting_college",
    maxResultsPerQuery: 8,
    fetchImpl,
    braveApiKey: "test-key",
    urlHistory: new Map()
  });

  const home = result.results.find((item) => item.url === "https://www.hsf.net/");
  const center = result.results.find((item) => item.url === "https://www.scholarshipcenter.ucla.edu/src-donor-scholarships/first-year-students/");
  const direct = result.results.find((item) => item.url === "https://example.org/future-engineers-scholarship");

  assert.ok(home);
  assert.ok(center);
  assert.ok(direct);
  assert.notEqual(home.heuristics.surfaceType, "direct_likely");
  assert.notEqual(center.heuristics.surfaceType, "direct_likely");
  assert.equal(direct.heuristics.surfaceType, "direct_likely");
});

test("scholarshipWebSearch ranks true direct pages above stronger profile-matching hubs", async () => {
  const fetchImpl = async () => createMockJsonResponse({
    web: {
      results: [
        {
          title: "Community Future Scholarship",
          url: "https://example.org/community-future-scholarship",
          description: "Apply now. Incoming college freshmen are eligible. Award amount $2,500."
        },
        {
          title: "Hispanic Mechanical Engineering Scholarships",
          url: "https://example.org/hispanic-mechanical-engineering-scholarships",
          description: "Top scholarships for Hispanic mechanical engineering students who are incoming college freshmen."
        }
      ]
    }
  });

  const result = await scholarshipWebSearch({
    queries: ["mechanical engineering scholarship incoming freshman"],
    profile: {
      personalInfo: {
        intendedMajor: "Mechanical Engineering",
        ethnicity: "Hispanic/Latino"
      },
      academics: {
        gradeLevel: "12th grade"
      }
    },
    studentStage: "starting_college",
    maxResultsPerQuery: 8,
    fetchImpl,
    braveApiKey: "test-key",
    urlHistory: new Map()
  });

  assert.equal(result.results[0].url, "https://example.org/community-future-scholarship");
  const hub = result.results.find((item) => item.url === "https://example.org/hispanic-mechanical-engineering-scholarships");
  const direct = result.results.find((item) => item.url === "https://example.org/community-future-scholarship");
  assert.ok(hub);
  assert.ok(direct);
  assert.equal(direct.heuristics.surfaceType, "direct_likely");
  assert.notEqual(hub.heuristics.surfaceType, "direct_likely");
  assert.ok(direct.fitScore > hub.fitScore);
});
