import fs from "node:fs/promises";
import path from "node:path";
import { loadLocalEnv } from "../config/loadEnv.js";
import { scholarshipWebSearch } from "../discovery/scholarshipWebSearch.js";

const VARIANTS = ["control", "precision_first", "non_school_bias", "major_precision"];

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function uniqueStrings(values) {
  const seen = new Set();
  const output = [];
  for (const value of values || []) {
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
    if (token === "--request") output.requestPath = args.shift();
    else if (token === "--out-dir") output.outDir = args.shift();
  }
  return output;
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function summarizeResults(result = {}) {
  const results = Array.isArray(result?.results) ? result.results : [];
  const top10 = results.slice(0, 10);
  return {
    totalResults: results.length,
    directCount: results.filter((item) => item?.heuristics?.surfaceType === "direct_likely").length,
    hubCount: results.filter((item) => item?.heuristics?.surfaceType === "hub_likely").length,
    listCount: results.filter((item) => item?.heuristics?.surfaceType === "list_likely").length,
    schoolSpecificCount: results.filter((item) => item?.heuristics?.specificSchoolSignal).length,
    institutionSpecificCount: results.filter((item) => item?.heuristics?.institutionSpecificSignal).length,
    staleCount: results.filter((item) => item?.heuristics?.staleCycleSignal).length,
    indirectCount: results.filter((item) => item?.heuristics?.indirectContentSignal).length,
    uniqueDomains: uniqueStrings(results.map((item) => item?.sourceDomain || "")).length,
    top10: top10.map((item, index) => ({
      rank: index + 1,
      title: item?.title || "",
      url: item?.url || "",
      domain: item?.sourceDomain || "",
      fitScore: item?.fitScore || 0,
      heuristics: item?.heuristics || {}
    }))
  };
}

async function main() {
  loadLocalEnv();
  const args = parseArgs(process.argv.slice(2));
  if (!args.requestPath) {
    throw new Error("Usage: node src/cli/runScholarshipWebSearchExperimentsCli.js --request /absolute/path/request.json [--out-dir /absolute/path/output-dir]");
  }

  const requestPath = path.resolve(args.requestPath);
  const raw = await fs.readFile(requestPath, "utf8");
  const request = JSON.parse(raw);

  const outDir = path.resolve(args.outDir || path.join(process.cwd(), "data", "search_experiments", nowStamp()));
  await fs.mkdir(outDir, { recursive: true });

  const summaries = [];
  for (const variant of VARIANTS) {
    const result = await scholarshipWebSearch({
      queries: request.queries || [],
      profile: request.profile || {},
      studentStage: request.studentStage || "",
      maxResultsPerQuery: request.maxResultsPerQuery || 8,
      domainAllowHints: request.domainAllowHints || [],
      domainDenyHints: request.domainDenyHints || [],
      queryFamily: request.queryFamily || "",
      runContext: request.runContext || {},
      experimentVariant: variant
    });

    const summary = summarizeResults(result);
    summaries.push({
      variant,
      ...summary
    });

    await fs.writeFile(
      path.join(outDir, `${variant}.json`),
      `${JSON.stringify({
        variant,
        request,
        summary,
        search: result
      }, null, 2)}\n`,
      "utf8"
    );
  }

  await fs.writeFile(
    path.join(outDir, "summary.json"),
    `${JSON.stringify({
      request,
      variants: summaries
    }, null, 2)}\n`,
    "utf8"
  );

  process.stdout.write(`${JSON.stringify({ outDir, variants: summaries }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.message || String(error)}\n`);
  process.exit(1);
});
