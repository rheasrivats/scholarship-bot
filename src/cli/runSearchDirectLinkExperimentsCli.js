import fs from "node:fs/promises";
import path from "node:path";
import { loadLocalEnv } from "../config/loadEnv.js";
import { scholarshipWebSearch } from "../discovery/scholarshipWebSearch.js";
import { __testables } from "../discovery/discoveryService.js";

const { buildDiscoveryQueries } = __testables;

const DEFAULT_PROFILE = {
  personalInfo: {
    intendedMajor: "Mechanical Engineering",
    ethnicity: "Hispanic/Latino",
    state: "California"
  },
  academics: {
    gradeLevel: "12th grade",
    gpa: 3.8
  }
};

const VARIANTS = [
  {
    name: "control",
    queryStrategy: "control",
    rankVariant: "control"
  },
  {
    name: "control_plus_singular",
    queryStrategy: "control_plus_singular",
    rankVariant: "control"
  },
  {
    name: "singular_synonym_mix",
    queryStrategy: "singular_synonym_mix",
    rankVariant: "control"
  },
  {
    name: "detail_phrase_mix",
    queryStrategy: "detail_phrase_mix",
    rankVariant: "control"
  }
];

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function uniqueStrings(values = []) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const cleaned = cleanText(value);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(cleaned);
  }
  return output;
}

function parseArgs(argv = []) {
  const args = [...argv];
  const output = {};
  while (args.length > 0) {
    const token = args.shift();
    if (token === "--out-dir") output.outDir = args.shift();
    else if (token === "--max-queries") output.maxQueries = Number(args.shift());
    else if (token === "--max-results-per-query") output.maxResultsPerQuery = Number(args.shift());
  }
  return output;
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function normalizeStateValue(value) {
  const raw = cleanText(value).toLowerCase();
  if (!raw) return "";
  if (raw === "california" || raw === "ca") return "California";
  return cleanText(value);
}

function buildVariantQueries({ profile = {}, studentStage = "", maxQueries = 10, strategy = "control" }) {
  if (strategy === "control") {
    return uniqueStrings(buildDiscoveryQueries({
      profile,
      studentStage,
      maxQueries,
      strategy: "control"
    }));
  }

  const personal = profile?.personalInfo || {};
  const major = cleanText(personal.intendedMajor || "Mechanical Engineering");
  const ethnicity = cleanText(personal.ethnicity || "Hispanic Latino").replace(/\//g, " ");
  const state = normalizeStateValue(personal.state || "California");

  const byStrategy = {
    control_plus_singular: [
      `${major} scholarship incoming college freshman`,
      `${major} scholarship ${state === "California" ? "CA" : state} incoming college freshman`,
      `${ethnicity} ${major} scholarship incoming college freshman`,
      `${major} scholarship incoming freshman`,
      `${major} scholarship first-year student`,
      `incoming college freshman ${major} scholarship`,
      `${ethnicity} scholarship incoming college freshman`,
      "incoming college freshman scholarship",
      `${major} award incoming freshman`,
      `${state} engineering scholarship incoming freshman`
    ],
    singular_synonym_mix: [
      `${major} scholarship incoming freshman`,
      `${major} award incoming freshman`,
      `${major} grant incoming freshman`,
      `${ethnicity} ${major} scholarship incoming freshman`,
      `${ethnicity} engineering award incoming freshman`,
      `${state} engineering scholarship incoming freshman`,
      `incoming freshman scholarship ${major}`,
      `first-year student ${major} scholarship`,
      "incoming freshman STEM scholarship",
      `${ethnicity} scholarship incoming freshman`
    ],
    detail_phrase_mix: [
      `${major} scholarship incoming freshman`,
      `${major} scholarship deadline incoming freshman`,
      `${major} scholarship eligibility incoming freshman`,
      `${major} scholarship award incoming freshman`,
      `${ethnicity} ${major} scholarship incoming freshman`,
      `${ethnicity} scholarship deadline incoming freshman`,
      `${state} engineering scholarship incoming freshman`,
      "incoming freshman scholarship apply",
      "first-year student scholarship engineering",
      "incoming freshman STEM scholarship"
    ]
  };

  return uniqueStrings((byStrategy[strategy] || byStrategy.control_plus_singular).slice(0, maxQueries));
}

function summarizeTopResults(results = [], limit = 40) {
  const slice = results.slice(0, limit);
  const directCount = slice.filter((item) => item?.heuristics?.surfaceType === "direct_likely").length;
  const hubCount = slice.filter((item) => item?.heuristics?.surfaceType === "hub_likely").length;
  const listCount = slice.filter((item) => item?.heuristics?.surfaceType === "list_likely").length;
  return {
    count: slice.length,
    directCount,
    directShare: slice.length > 0 ? Number((directCount / slice.length).toFixed(3)) : 0,
    hubCount,
    listCount,
    top10: slice.slice(0, 10).map((item, index) => ({
      rank: index + 1,
      title: item?.title || "",
      url: item?.url || "",
      sourceDomain: item?.sourceDomain || "",
      fitScore: Number(item?.fitScore || 0),
      surfaceType: item?.heuristics?.surfaceType || ""
    }))
  };
}

async function main() {
  loadLocalEnv();
  const args = parseArgs(process.argv.slice(2));
  const profile = DEFAULT_PROFILE;
  const studentStage = "starting_college";
  const maxQueries = Math.max(1, Number(args.maxQueries || 10));
  const maxResultsPerQuery = Math.max(1, Number(args.maxResultsPerQuery || 15));
  const outDir = path.resolve(args.outDir || path.join(process.cwd(), "data", "search_direct_link_experiments", nowStamp()));
  await fs.mkdir(outDir, { recursive: true });

  const summaries = [];
  for (const variant of VARIANTS) {
    const queries = buildVariantQueries({
      profile,
      studentStage,
      maxQueries,
      strategy: variant.queryStrategy
    });
    const search = await scholarshipWebSearch({
      queries,
      profile,
      studentStage,
      maxResultsPerQuery,
      queryFamily: "mixed_stage_safe",
      runContext: { round: 1 },
      experimentVariant: variant.rankVariant
    });

    const summary = {
      name: variant.name,
      queryStrategy: variant.queryStrategy,
      rankVariant: variant.rankVariant,
      queries,
      totalResults: search.results.length,
      totalDirectCount: search.results.filter((item) => item?.heuristics?.surfaceType === "direct_likely").length,
      top40: summarizeTopResults(search.results, 40)
    };
    summaries.push(summary);

    await fs.writeFile(
      path.join(outDir, `${variant.name}.json`),
      `${JSON.stringify({
        variant,
        summary,
        search
      }, null, 2)}\n`,
      "utf8"
    );
  }

  await fs.writeFile(
    path.join(outDir, "summary.json"),
    `${JSON.stringify({ profile, studentStage, maxQueries, maxResultsPerQuery, variants: summaries }, null, 2)}\n`,
    "utf8"
  );

  process.stdout.write(`${JSON.stringify({ outDir, variants: summaries }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.message || String(error)}\n`);
  process.exit(1);
});
