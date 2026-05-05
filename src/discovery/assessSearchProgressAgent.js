import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { assessSearchProgress } from "./assessSearchProgress.js";

const DEFAULT_ASSESS_PROGRESS_AI_MODEL = "gpt-5.3-codex-spark";
const DEFAULT_ASSESS_PROGRESS_TIMEOUT_MS = 45000;
const MAX_RATIONALE_LENGTH = 260;
const MAX_DIRECTION_LENGTH = 140;

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function clampCount(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return Math.max(0, Math.floor(fallback));
  return Math.max(0, Math.floor(numeric));
}

function clampRatio(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return Math.max(0, Math.min(1, Number(fallback) || 0));
  return Math.max(0, Math.min(1, numeric));
}

function truncateText(value, maxChars) {
  const text = cleanText(value);
  const limit = Math.max(1, Number(maxChars) || 0);
  if (!text || text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 3)).trim()}...`;
}

function compactInput({
  runSummary = {},
  currentRound = {},
  frontierState = {},
  remainingBudget = {}
} = {}) {
  return {
    runSummary: {
      round: clampCount(runSummary?.round, 1),
      queriesUsed: clampCount(runSummary?.queriesUsed, 0),
      pagesFetched: clampCount(runSummary?.pagesFetched, 0),
      acceptedCandidates: clampCount(runSummary?.acceptedCandidates, 0),
      strongEvidenceCandidates: clampCount(runSummary?.strongEvidenceCandidates, 0),
      targetAcceptedCandidates: Math.max(1, clampCount(runSummary?.targetAcceptedCandidates, 5) || 5)
    },
    currentRound: {
      fetchedPages: clampCount(currentRound?.fetchedPages, 0),
      advancedToFinalize: clampCount(currentRound?.advancedToFinalize, 0),
      heldForExpansion: clampCount(currentRound?.heldForExpansion, 0),
      dropped: clampCount(currentRound?.dropped, 0)
    },
    frontierState: {
      remainingUnfetchedSearchResults: clampCount(frontierState?.remainingUnfetchedSearchResults, 0),
      heldHubsReadyForExpansion: clampCount(frontierState?.heldHubsReadyForExpansion, 0),
      selectedExpansionChildrenAvailable: clampCount(frontierState?.selectedExpansionChildrenAvailable, 0),
      schoolSpecificPressure: clampRatio(frontierState?.schoolSpecificPressure, 0),
      broadOpportunityPressure: clampRatio(frontierState?.broadOpportunityPressure, 0)
    },
    remainingBudget: {
      searchRounds: clampCount(remainingBudget?.searchRounds, 0),
      queries: clampCount(remainingBudget?.queries, 0),
      pages: clampCount(remainingBudget?.pages, 0),
      depth: clampCount(remainingBudget?.depth, 0),
      replans: clampCount(remainingBudget?.replans, 0)
    }
  };
}

function buildPrompt(input = {}) {
  const compact = compactInput(input);
  return [
    "You are deciding what the scholarship search loop should do next.",
    "Return JSON only matching the provided schema.",
    "",
    "Your job:",
    "- Choose exactly one action:",
    "  - continue",
    "  - replan",
    "  - stop",
    "- Choose exactly one nextStep:",
    "  - fetch_remaining_frontier",
    "  - expand_held_hubs",
    "  - widen_queries",
    "  - stop_now",
    "- Provide one short rationale grounded only in the supplied run summary.",
    "- Provide suggestedDirections only when action is replan; otherwise use an empty array.",
    "",
    "Important rules:",
    "- Use only the supplied summary data. Do not invent facts.",
    "- Treat the early target of accepted candidates as a strong goal, not an absolute guarantee.",
    "- Prefer expand_held_hubs when selected expansion children are already available and budget supports it.",
    "- Prefer fetch_remaining_frontier when the remaining frontier still looks worthwhile.",
    "- Prefer widen_queries when the accepted count is below target and the remaining opportunity set is too narrow, weak, or too school-specific.",
    "- Respect schoolSpecificPressure as a caution signal against repeatedly investing in institution-locked opportunities.",
    "- If action is stop, nextStep must be stop_now.",
    "- If action is replan, nextStep must be widen_queries.",
    "- Keep rationale concise and specific.",
    "",
    `Run summary:\n${JSON.stringify(compact, null, 2)}`
  ].join("\n");
}

function buildSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      action: {
        type: "string",
        enum: ["continue", "replan", "stop"]
      },
      nextStep: {
        type: "string",
        enum: ["fetch_remaining_frontier", "expand_held_hubs", "widen_queries", "stop_now"]
      },
      rationale: { type: "string" },
      suggestedDirections: {
        type: "array",
        items: { type: "string" }
      }
    },
    required: ["action", "nextStep", "rationale", "suggestedDirections"]
  };
}

function validateAgentOutput(output = {}) {
  const action = cleanText(output?.action || "");
  const nextStep = cleanText(output?.nextStep || "");
  const rationale = truncateText(output?.rationale || "", MAX_RATIONALE_LENGTH);
  const suggestedDirections = Array.isArray(output?.suggestedDirections)
    ? output.suggestedDirections.map((item) => truncateText(item, MAX_DIRECTION_LENGTH)).filter(Boolean).slice(0, 5)
    : [];

  if (!["continue", "replan", "stop"].includes(action)) {
    throw new Error(`Invalid assess_search_progress action: ${action || "<empty>"}`);
  }
  if (!["fetch_remaining_frontier", "expand_held_hubs", "widen_queries", "stop_now"].includes(nextStep)) {
    throw new Error(`Invalid assess_search_progress nextStep: ${nextStep || "<empty>"}`);
  }
  if (!rationale) {
    throw new Error("Missing rationale for assess_search_progress");
  }
  if (action === "stop" && nextStep !== "stop_now") {
    throw new Error("Stop action must use nextStep stop_now");
  }
  if (action === "replan" && nextStep !== "widen_queries") {
    throw new Error("Replan action must use nextStep widen_queries");
  }
  if (action === "continue" && !["fetch_remaining_frontier", "expand_held_hubs"].includes(nextStep)) {
    throw new Error("Continue action must use fetch_remaining_frontier or expand_held_hubs");
  }
  if (action !== "replan" && suggestedDirections.length > 0) {
    throw new Error("suggestedDirections must be empty unless action is replan");
  }

  return {
    action,
    nextStep,
    rationale,
    suggestedDirections
  };
}

function runCodexExec({
  prompt,
  schemaPath,
  outputPath,
  cwd,
  timeoutMs = DEFAULT_ASSESS_PROGRESS_TIMEOUT_MS,
  model = DEFAULT_ASSESS_PROGRESS_AI_MODEL
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
      reject(new Error(`assess_search_progress agent timed out after ${Math.round(timeoutMs / 1000)}s`));
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

export async function assessSearchProgressAgent({
  runSummary = {},
  currentRound = {},
  frontierState = {},
  remainingBudget = {},
  timeoutMs = DEFAULT_ASSESS_PROGRESS_TIMEOUT_MS,
  model = String(process.env.ASSESS_SEARCH_PROGRESS_AI_MODEL || DEFAULT_ASSESS_PROGRESS_AI_MODEL).trim(),
  execImpl = runCodexExec
} = {}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "assess-search-progress-agent-"));
  try {
    const schemaPath = path.join(tempDir, "schema.json");
    const outputPath = path.join(tempDir, "output.json");
    await fs.writeFile(schemaPath, `${JSON.stringify(buildSchema(), null, 2)}\n`, "utf8");

    await execImpl({
      prompt: buildPrompt({ runSummary, currentRound, frontierState, remainingBudget }),
      schemaPath,
      outputPath,
      cwd: process.cwd(),
      timeoutMs,
      model
    });

    const raw = await fs.readFile(outputPath, "utf8");
    const parsed = JSON.parse(raw);
    const decision = validateAgentOutput(parsed);

    return {
      ...decision,
      metadata: {
        mode: "agentic",
        model
      }
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export async function assessSearchProgressWithFallback({
  runSummary = {},
  currentRound = {},
  frontierState = {},
  remainingBudget = {},
  timeoutMs = DEFAULT_ASSESS_PROGRESS_TIMEOUT_MS,
  model = String(process.env.ASSESS_SEARCH_PROGRESS_AI_MODEL || DEFAULT_ASSESS_PROGRESS_AI_MODEL).trim(),
  execImpl = runCodexExec
} = {}) {
  try {
    return await assessSearchProgressAgent({
      runSummary,
      currentRound,
      frontierState,
      remainingBudget,
      timeoutMs,
      model,
      execImpl
    });
  } catch (error) {
    return {
      ...assessSearchProgress({
        runSummary,
        currentRound,
        frontierState,
        remainingBudget
      }),
      metadata: {
        mode: "deterministic_fallback",
        fallbackReason: error?.message || String(error || "unknown assess_search_progress error")
      }
    };
  }
}
