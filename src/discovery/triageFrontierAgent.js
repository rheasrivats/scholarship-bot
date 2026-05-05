import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { triageFrontier } from "./triageFrontier.js";

const DEFAULT_TRIAGE_FRONTIER_AI_MODEL = "gpt-5.3-codex-spark";
const DEFAULT_TRIAGE_TIMEOUT_MS = 45000;
const MAX_RATIONALE_LENGTH = 240;

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function truncateText(value, maxChars) {
  const text = cleanText(value);
  const limit = Math.max(1, Number(maxChars) || 0);
  if (!text || !limit || text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 3)).trim()}...`;
}

function compactPageBundle(page = {}, index = 0) {
  const childLinks = Array.isArray(page.childLinks) ? page.childLinks.slice(0, 5) : [];
  return {
    pageId: `page_${index + 1}`,
    canonicalUrl: cleanText(page.canonicalUrl || page.requestedUrl || ""),
    title: cleanText(page.title || ""),
    sourceDomain: cleanText(page.sourceDomain || ""),
    blockers: page.blockers || {},
    fitSignals: page.fitSignals || {},
    pageSignals: page.pageSignals || {},
    evidenceSnippets: page.evidenceSnippets || {},
    childLinks
  };
}

function buildTriagePrompt({ pageBundles = [], remainingBudget = {} } = {}) {
  const compactBundles = pageBundles.map((page, index) => compactPageBundle(page, index));
  return [
    "You are triaging fetched scholarship pages inside a scholarship search system.",
    "Return JSON only matching the provided schema.",
    "",
    "Your job:",
    "- For each fetched page, choose exactly one action:",
    "  - advance_to_finalize",
    "  - hold_for_expansion",
    "  - drop",
    "- Use the provided pageId exactly as written when returning each decision.",
    "- Provide one short rationale grounded only in the provided evidence.",
    "",
    "Important rules:",
    "- Use only the supplied page bundle data. Do not invent facts.",
    "- Treat blocker signals as strong evidence.",
    "- Treat closed or expired pages as drop unless the supplied data clearly contradicts that blocker.",
    "- Treat explicit student-stage mismatch as a drop, including when child links exist.",
    "- Treat Pell Grant, FAFSA, financial-aid explainer, and similar aid-information pages as drop rather than scholarship candidates.",
    "- Treat specificSchoolSignal as a caution signal, not an automatic drop.",
    "- Treat aggregatorSummarySignal as evidence that the page is a directory or mirror, not the original scholarship source.",
    "- Most aggregator summary pages should not advance to finalization.",
    "- Exception: a trusted aggregator detail page may advance_to_finalize when it looks like a single named scholarship page and has strong concrete evidence such as title, deadline, amount, stage cue, apply path, and verification/review language, with no blocker signals.",
    "- If originalSourceLinkSignal is true while directScholarshipSignal is false, prefer fetching the original source before finalization.",
    "- Prefer hold_for_expansion when a page is not a final scholarship itself but has clearly useful scholarship-oriented child links and remaining budget makes expansion realistic.",
    "- Prefer advance_to_finalize only when the page looks like a real scholarship page with enough concrete evidence to justify deterministic finalization now.",
    "- Every input page must receive exactly one decision.",
    "- Keep rationales concise and specific.",
    "",
    `Remaining budget:\n${JSON.stringify({
      pages: Number(remainingBudget?.pages || 0),
      depth: Number(remainingBudget?.depth || 0)
    }, null, 2)}`,
    `Fetched page bundles:\n${JSON.stringify(compactBundles, null, 2)}`
  ].join("\n");
}

function buildSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      decisions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            pageId: { type: "string" },
            action: {
              type: "string",
              enum: ["advance_to_finalize", "hold_for_expansion", "drop"]
            },
            rationale: { type: "string" }
          },
          required: ["pageId", "action", "rationale"]
        }
      }
    },
    required: ["decisions"]
  };
}

function buildQueue(decisions = []) {
  const queue = {
    advanceToFinalize: [],
    holdForExpansion: [],
    dropped: []
  };
  for (const decision of decisions) {
    if (decision.action === "advance_to_finalize") queue.advanceToFinalize.push(decision.url);
    else if (decision.action === "hold_for_expansion") queue.holdForExpansion.push(decision.url);
    else if (decision.action === "drop") queue.dropped.push(decision.url);
  }
  return queue;
}

function validateAgentDecisions(decisions = [], pageBundles = []) {
  const inputPages = new Map();
  pageBundles.forEach((page, index) => {
    const pageId = `page_${index + 1}`;
    const url = cleanText(page?.canonicalUrl || page?.requestedUrl || "");
    if (!url) return;
    inputPages.set(pageId, { page, url });
  });

  if (inputPages.size === 0) {
    throw new Error("No valid input pages available for triage validation");
  }

  const normalizedDecisions = Array.isArray(decisions) ? decisions : [];
  if (normalizedDecisions.length !== inputPages.size) {
    throw new Error(`Expected ${inputPages.size} decisions but received ${normalizedDecisions.length}`);
  }

  const seenPageIds = new Set();
  const validated = normalizedDecisions.map((decision) => {
    const pageId = cleanText(decision?.pageId || "");
    const action = cleanText(decision?.action || "");
    const rationale = truncateText(decision?.rationale || "", MAX_RATIONALE_LENGTH);
    if (!inputPages.has(pageId)) {
      throw new Error(`Decision referenced unknown pageId: ${pageId || "<empty>"}`);
    }
    if (seenPageIds.has(pageId)) {
      throw new Error(`Duplicate decision for pageId: ${pageId}`);
    }
    if (!["advance_to_finalize", "hold_for_expansion", "drop"].includes(action)) {
      throw new Error(`Invalid triage action: ${action || "<empty>"}`);
    }
    if (!rationale) {
      throw new Error(`Missing rationale for pageId: ${pageId}`);
    }
    seenPageIds.add(pageId);
    return { url: inputPages.get(pageId).url, action, rationale };
  });

  for (const pageId of inputPages.keys()) {
    if (!seenPageIds.has(pageId)) {
      throw new Error(`Missing decision for pageId: ${pageId}`);
    }
  }

  return validated;
}

function applyAgentGuardrails(decisions = [], pageBundles = [], remainingBudget = {}) {
  const pageByUrl = new Map();
  pageBundles.forEach((page) => {
    const url = cleanText(page?.canonicalUrl || page?.requestedUrl || "");
    if (url) pageByUrl.set(url, page);
  });

  return decisions.map((decision) => {
    const page = pageByUrl.get(decision.url);
    const pageSignals = page?.pageSignals || {};
    const isAggregatorMirrorPage = Boolean(
      pageSignals.aggregatorSummarySignal
      || (pageSignals.originalSourceLinkSignal && !pageSignals.directScholarshipSignal)
    );

    if (!page || decision.action !== "advance_to_finalize" || !isAggregatorMirrorPage) {
      return decision;
    }

    const deterministicDecision = triageFrontier({
      pageBundles: [page],
      remainingBudget
    }).decisions[0];

    return {
      ...decision,
      action: deterministicDecision.action,
      rationale: deterministicDecision.rationale
    };
  });
}

function runCodexExec({
  prompt,
  schemaPath,
  outputPath,
  cwd,
  timeoutMs = DEFAULT_TRIAGE_TIMEOUT_MS,
  model = DEFAULT_TRIAGE_FRONTIER_AI_MODEL
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
      reject(new Error(`triage_frontier agent timed out after ${Math.round(timeoutMs / 1000)}s`));
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

export async function triageFrontierAgent({
  pageBundles = [],
  remainingBudget = {},
  timeoutMs = DEFAULT_TRIAGE_TIMEOUT_MS,
  model = String(process.env.TRIAGE_FRONTIER_AI_MODEL || DEFAULT_TRIAGE_FRONTIER_AI_MODEL).trim(),
  execImpl = runCodexExec
} = {}) {
  const bundles = Array.isArray(pageBundles) ? pageBundles : [];
  if (bundles.length === 0) {
    throw new Error("pageBundles must be a non-empty array");
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "triage-frontier-agent-"));
  try {
    const schemaPath = path.join(tempDir, "schema.json");
    const outputPath = path.join(tempDir, "output.json");
    await fs.writeFile(schemaPath, `${JSON.stringify(buildSchema(), null, 2)}\n`, "utf8");

    await execImpl({
      prompt: buildTriagePrompt({ pageBundles: bundles, remainingBudget }),
      schemaPath,
      outputPath,
      cwd: process.cwd(),
      timeoutMs,
      model
    });

    const raw = await fs.readFile(outputPath, "utf8");
    const parsed = JSON.parse(raw);
    const decisions = applyAgentGuardrails(
      validateAgentDecisions(parsed?.decisions, bundles),
      bundles,
      remainingBudget
    );
    return {
      decisions,
      queue: buildQueue(decisions),
      notes: [],
      metadata: {
        mode: "agentic",
        model
      }
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export async function triageFrontierWithFallback({
  pageBundles = [],
  remainingBudget = {},
  timeoutMs = DEFAULT_TRIAGE_TIMEOUT_MS,
  model = String(process.env.TRIAGE_FRONTIER_AI_MODEL || DEFAULT_TRIAGE_FRONTIER_AI_MODEL).trim(),
  execImpl = runCodexExec
} = {}) {
  try {
    return await triageFrontierAgent({
      pageBundles,
      remainingBudget,
      timeoutMs,
      model,
      execImpl
    });
  } catch (error) {
    const fallback = triageFrontier({ pageBundles, remainingBudget });
    return {
      ...fallback,
      metadata: {
        mode: "deterministic_fallback",
        fallbackReason: error?.message || String(error || "unknown triage error")
      }
    };
  }
}
