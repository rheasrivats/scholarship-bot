import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { normalizeDiscoveryUrl } from "./discoveryHistoryStore.js";
import { selectFetchBatch } from "./selectFetchBatch.js";

const DEFAULT_SELECT_FETCH_BATCH_AI_MODEL = "gpt-5.3-codex-spark";
const DEFAULT_SELECT_FETCH_BATCH_TIMEOUT_MS = 45000;
const MAX_RATIONALE_LENGTH = 260;
const MAX_NOTE_LENGTH = 120;

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

function clampPositiveInteger(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.max(1, Math.floor(numeric));
}

function computeBatchLimit(remainingBudget = {}) {
  const fetchesThisRound = clampPositiveInteger(remainingBudget?.fetchesThisRound, 6);
  const remainingPages = clampPositiveInteger(remainingBudget?.pages, fetchesThisRound);
  return Math.max(1, Math.min(fetchesThisRound, remainingPages));
}

function truncateText(value, maxChars) {
  const text = cleanText(value);
  const limit = Math.max(1, Number(maxChars) || 0);
  if (!text || text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 3)).trim()}...`;
}

function dedupeFrontier(searchResults = [], alreadyFetchedUrls = []) {
  const alreadyFetched = new Set(
    uniqueStrings(alreadyFetchedUrls)
      .map((value) => normalizeDiscoveryUrl(value))
      .filter(Boolean)
  );

  const deduped = [];
  const seenUrls = new Set();
  for (const result of Array.isArray(searchResults) ? searchResults : []) {
    const normalizedUrl = normalizeDiscoveryUrl(result?.normalizedUrl || result?.url || "");
    if (!normalizedUrl || seenUrls.has(normalizedUrl) || alreadyFetched.has(normalizedUrl)) continue;
    seenUrls.add(normalizedUrl);
    deduped.push({
      ...result,
      normalizedUrl,
      sourceDomain: cleanText(result?.sourceDomain || "")
    });
  }
  return deduped;
}

function compactSearchResult(result = {}, index = 0) {
  const heuristics = result?.heuristics || {};
  return {
    resultId: `result_${index + 1}`,
    url: cleanText(result?.url || ""),
    title: cleanText(result?.title || ""),
    sourceDomain: cleanText(result?.sourceDomain || ""),
    providerRank: Number(result?.providerRank || 0),
    fitScore: Number(result?.fitScore || 0),
    heuristics: {
      surfaceType: cleanText(heuristics.surfaceType || ""),
      majorMatch: Boolean(heuristics.majorMatch),
      ethnicityMatch: Boolean(heuristics.ethnicityMatch),
      stateMatch: Boolean(heuristics.stateMatch),
      stageMatch: Boolean(heuristics.stageMatch),
      negativeGraduateSignal: Boolean(heuristics.negativeGraduateSignal),
      negativeBlogSignal: Boolean(heuristics.negativeBlogSignal),
      negativeDirectorySignal: Boolean(heuristics.negativeDirectorySignal),
      institutionSpecificSignal: Boolean(heuristics.institutionSpecificSignal),
      specificSchoolSignal: Boolean(heuristics.specificSchoolSignal),
      staleCycleSignal: Boolean(heuristics.staleCycleSignal),
      indirectContentSignal: Boolean(heuristics.indirectContentSignal),
      sameDomainAsPriorHit: Boolean(heuristics.sameDomainAsPriorHit),
      seenRecently: Boolean(heuristics.seenRecently),
      noveltyScore: Number(heuristics.noveltyScore || 0)
    }
  };
}

function buildPrompt({ searchResults = [], remainingBudget = {}, runState = {} } = {}) {
  const compactResults = searchResults.map((result, index) => compactSearchResult(result, index));
  return [
    "You are selecting the next small batch of scholarship search results to fetch.",
    "Return JSON only matching the provided schema.",
    "",
    "Your job:",
    "- Choose the best subset of results to fetch next.",
    "- Use the provided resultId values exactly as written.",
    "- Keep the batch bounded by the provided batch limit.",
    "- Provide one short rationale grounded only in the supplied frontier evidence.",
    "",
    "Important rules:",
    "- Use only the supplied search result data. Do not invent facts.",
    "- Prefer stage-matched opportunities for incoming freshmen over broader but fuzzier results.",
    "- Prefer direct scholarship pages, trusted aggregator detail pages, and high-signal program pages over generic roundups.",
    "- It can be worth keeping one trusted aggregator hub alive when it looks like a plausible path to real scholarship detail pages.",
    "- Prefer broad, high-signal opportunities over institution-locked pages when the frontier is mixed.",
    "- Treat school-specific or institution-specific pages as caution signals, not automatic exclusions.",
    "- Avoid stale, indirect, bloggy, or low-value results when stronger alternatives exist.",
    "- Maintain some domain diversity when reasonable.",
    "- It is okay to return fewer than the batch limit, including zero, if the remaining frontier looks low-confidence.",
    "- Do not fill the batch with weak pages just because slots remain.",
    "- Select no more than the batch limit.",
    "",
    `Batch limit: ${computeBatchLimit(remainingBudget)}`,
    `Remaining budget:\n${JSON.stringify({
      pages: Number(remainingBudget?.pages || 0),
      fetchesThisRound: Number(remainingBudget?.fetchesThisRound || 0)
    }, null, 2)}`,
    `Run state:\n${JSON.stringify({
      acceptedCount: Number(runState?.acceptedCount || 0),
      targetAcceptedCount: Number(runState?.targetAcceptedCount || 0),
      round: Number(runState?.round || 1)
    }, null, 2)}`,
    `Search frontier:\n${JSON.stringify(compactResults, null, 2)}`
  ].join("\n");
}

function buildSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      selectedResultIds: {
        type: "array",
        items: { type: "string" }
      },
      rationale: { type: "string" },
      notes: {
        type: "array",
        items: { type: "string" }
      }
    },
    required: ["selectedResultIds", "rationale", "notes"]
  };
}

function validateAgentOutput({
  output = {},
  searchResults = [],
  remainingBudget = {},
  runState = {}
} = {}) {
  const batchLimit = computeBatchLimit(remainingBudget);
  const resultMap = new Map();
  searchResults.forEach((result, index) => {
    const resultId = `result_${index + 1}`;
    const url = cleanText(result?.url || "");
    if (!url) return;
    resultMap.set(resultId, { result, url });
  });

  const selectedIds = Array.isArray(output?.selectedResultIds) ? output.selectedResultIds : [];
  const seenIds = new Set();
  const selectedUrls = selectedIds.map((value) => {
    const resultId = cleanText(value);
    if (!resultMap.has(resultId)) {
      throw new Error(`Selected unknown resultId: ${resultId || "<empty>"}`);
    }
    if (seenIds.has(resultId)) {
      throw new Error(`Duplicate selected resultId: ${resultId}`);
    }
    seenIds.add(resultId);
    return resultMap.get(resultId).url;
  });

  if (selectedUrls.length > batchLimit) {
    throw new Error(`Agent selected ${selectedUrls.length} results but batch limit is ${batchLimit}`);
  }

  const rationale = truncateText(output?.rationale || "", MAX_RATIONALE_LENGTH);
  if (!rationale) {
    throw new Error("Missing rationale for select_fetch_batch");
  }

  const notes = Array.isArray(output?.notes)
    ? output.notes.map((item) => truncateText(item, MAX_NOTE_LENGTH)).filter(Boolean).slice(0, 8)
    : [];

  const selectedDomains = uniqueStrings(
    selectedUrls.map((url) => cleanText(searchResults.find((item) => cleanText(item?.url || "") === url)?.sourceDomain || ""))
  );
  notes.push(`candidate_count=${searchResults.length}`);
  notes.push(`selected_count=${selectedUrls.length}`);
  notes.push(`selected_domains=${selectedDomains.join(",") || "none"}`);
  if (Number(runState?.acceptedCount || 0) < Number(runState?.targetAcceptedCount || 0)) {
    notes.push(`accepted_gap=${Math.max(0, Number(runState?.targetAcceptedCount || 0) - Number(runState?.acceptedCount || 0))}`);
  }

  return {
    selectedUrls,
    rationale,
    notes: uniqueStrings(notes)
  };
}

function runCodexExec({
  prompt,
  schemaPath,
  outputPath,
  cwd,
  timeoutMs = DEFAULT_SELECT_FETCH_BATCH_TIMEOUT_MS,
  model = DEFAULT_SELECT_FETCH_BATCH_AI_MODEL
}) {
  return new Promise((resolve, reject) => {
    const cmd = [
      "codex",
      "exec",
      "-m",
      model,
      "--skip-git-repo-check",
      "-C",
      cwd,
      "--output-schema",
      schemaPath,
      "--output-last-message",
      outputPath,
      "-"
    ];

    const proc = spawn(cmd[0], cmd.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`select_fetch_batch agent timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    proc.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`codex exec failed (exit ${code}): ${stderr || "unknown error"}`));
        return;
      }
      resolve();
    });

    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

export async function selectFetchBatchAgent({
  searchResults = [],
  alreadyFetchedUrls = [],
  remainingBudget = {},
  runState = {},
  timeoutMs = DEFAULT_SELECT_FETCH_BATCH_TIMEOUT_MS,
  model = String(process.env.SELECT_FETCH_BATCH_AI_MODEL || DEFAULT_SELECT_FETCH_BATCH_AI_MODEL).trim(),
  execImpl = runCodexExec
} = {}) {
  const frontier = dedupeFrontier(searchResults, alreadyFetchedUrls);
  if (frontier.length === 0) {
    throw new Error("searchResults must include at least one unfetched result");
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "select-fetch-batch-agent-"));
  try {
    const schemaPath = path.join(tempDir, "schema.json");
    const outputPath = path.join(tempDir, "output.json");
    await fs.writeFile(schemaPath, `${JSON.stringify(buildSchema(), null, 2)}\n`, "utf8");

    await execImpl({
      prompt: buildPrompt({ searchResults: frontier, remainingBudget, runState }),
      schemaPath,
      outputPath,
      cwd: process.cwd(),
      timeoutMs,
      model
    });

    const raw = await fs.readFile(outputPath, "utf8");
    const parsed = JSON.parse(raw);
    const selection = validateAgentOutput({
      output: parsed,
      searchResults: frontier,
      remainingBudget,
      runState
    });

    return {
      ...selection,
      metadata: {
        mode: "agentic",
        model
      }
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export async function selectFetchBatchWithFallback({
  searchResults = [],
  alreadyFetchedUrls = [],
  remainingBudget = {},
  runState = {},
  timeoutMs = DEFAULT_SELECT_FETCH_BATCH_TIMEOUT_MS,
  model = String(process.env.SELECT_FETCH_BATCH_AI_MODEL || DEFAULT_SELECT_FETCH_BATCH_AI_MODEL).trim(),
  execImpl = runCodexExec
} = {}) {
  try {
    return await selectFetchBatchAgent({
      searchResults,
      alreadyFetchedUrls,
      remainingBudget,
      runState,
      timeoutMs,
      model,
      execImpl
    });
  } catch (error) {
    return {
      ...selectFetchBatch({
        searchResults,
        alreadyFetchedUrls,
        remainingBudget,
        runState
      }),
      metadata: {
        mode: "deterministic_fallback",
        fallbackReason: error?.message || String(error || "unknown select_fetch_batch error")
      }
    };
  }
}
