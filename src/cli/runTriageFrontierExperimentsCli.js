import fs from "node:fs/promises";
import path from "node:path";
import { triageFrontier } from "../discovery/triageFrontier.js";

const VARIANTS = [
  "control",
  "trusted_agg_conservative",
  "trusted_agg_moderate",
  "trusted_agg_strict_domain"
];

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function parseArgs(argv = []) {
  const args = [...argv];
  const output = {};
  while (args.length > 0) {
    const token = args.shift();
    if (token === "--core-flow") output.coreFlow = args.shift();
    else if (token === "--page-bundles") output.pageBundles = args.shift();
    else if (token === "--out-dir") output.outDir = args.shift();
  }
  return output;
}

async function loadPageBundlesFromCoreFlow(filePath) {
  const data = JSON.parse(await fs.readFile(filePath, "utf8"));
  const pages = [];
  for (const round of Array.isArray(data.rounds) ? data.rounds : []) {
    for (const page of Array.isArray(round.pageBundles) ? round.pageBundles : []) {
      pages.push({
        canonicalUrl: page.url || "",
        title: page.title || "",
        blockers: page.blockers || {},
        fitSignals: page.fitSignals || {},
        pageSignals: page.pageSignals || {},
        evidenceSnippets: page.evidenceSnippets || {},
        childLinks: Array.isArray(page.childLinks) ? page.childLinks : []
      });
    }
  }
  return pages;
}

async function loadPageBundles(filePath) {
  const data = JSON.parse(await fs.readFile(filePath, "utf8"));
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.pageBundles)) return data.pageBundles;
  if (Array.isArray(data.pages)) return data.pages;
  throw new Error("Could not find page bundles in input JSON");
}

function summarizeVariant({ variant, result, pages }) {
  const decisionByUrl = new Map((result.decisions || []).map((decision) => [cleanText(decision.url), decision]));
  const promotedAggregatorDetails = [];
  const counts = {
    advance: 0,
    hold: 0,
    drop: 0,
    aggregatorAdvance: 0,
    aggregatorHold: 0,
    aggregatorDrop: 0
  };

  for (const page of pages) {
    const url = cleanText(page?.canonicalUrl || page?.requestedUrl || page?.url || "");
    const decision = decisionByUrl.get(url);
    const action = cleanText(decision?.action || "");
    const isAggregator = Boolean(page?.pageSignals?.aggregatorSummarySignal);

    if (action === "advance_to_finalize") counts.advance += 1;
    else if (action === "hold_for_expansion") counts.hold += 1;
    else if (action === "drop") counts.drop += 1;

    if (!isAggregator) continue;
    if (action === "advance_to_finalize") {
      counts.aggregatorAdvance += 1;
      promotedAggregatorDetails.push({
        url,
        title: page?.title || "",
        rationale: decision?.rationale || ""
      });
    } else if (action === "hold_for_expansion") counts.aggregatorHold += 1;
    else if (action === "drop") counts.aggregatorDrop += 1;
  }

  return {
    variant,
    counts,
    promotedAggregatorDetails,
    notes: result.notes || []
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.coreFlow && !args.pageBundles) {
    throw new Error("Usage: node src/cli/runTriageFrontierExperimentsCli.js --core-flow data/core_flow_runs/.../core_flow.json OR --page-bundles path/to/page_bundles.json");
  }

  const outDir = path.resolve(args.outDir || path.join(process.cwd(), "data", "triage_frontier_experiments", nowStamp()));
  await fs.mkdir(outDir, { recursive: true });

  const pages = args.coreFlow
    ? await loadPageBundlesFromCoreFlow(path.resolve(args.coreFlow))
    : await loadPageBundles(path.resolve(args.pageBundles));

  const variants = [];
  for (const variant of VARIANTS) {
    const result = triageFrontier({
      pageBundles: pages,
      remainingBudget: { pages: 20, depth: 2 },
      experimentVariant: variant
    });
    const summary = summarizeVariant({ variant, result, pages });
    variants.push(summary);
    await fs.writeFile(path.join(outDir, `${variant}.json`), `${JSON.stringify({
      variant,
      result,
      summary
    }, null, 2)}\n`, "utf8");
  }

  await fs.writeFile(path.join(outDir, "summary.json"), `${JSON.stringify({
    input: args.coreFlow ? { coreFlow: path.resolve(args.coreFlow) } : { pageBundles: path.resolve(args.pageBundles) },
    pageCount: pages.length,
    variants
  }, null, 2)}\n`, "utf8");

  process.stdout.write(`${JSON.stringify({
    outDir,
    pageCount: pages.length,
    variants
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
  process.exit(1);
});
