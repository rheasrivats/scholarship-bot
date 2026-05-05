import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { decideHubExpansion } from "./decideHubExpansion.js";

const DEFAULT_DECIDE_HUB_EXPANSION_AI_MODEL = "gpt-5.3-codex-spark";
const DEFAULT_DECIDE_HUB_EXPANSION_TIMEOUT_MS = 45000;
const MAX_REASON_LENGTH = 220;
const MAX_DEBUG_REJECTED_CHILDREN = 5;

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function clampCount(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return Math.max(0, Math.floor(fallback));
  return Math.max(0, Math.floor(numeric));
}

function truncateText(value, maxChars) {
  const text = cleanText(value);
  const limit = Math.max(1, Number(maxChars) || 0);
  if (!text || text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 3)).trim()}...`;
}

function getPageUrl(page = {}) {
  return cleanText(page?.canonicalUrl || page?.requestedUrl || page?.url || "");
}

function compactHubPageBundle(hubPageBundle = {}) {
  const childLinks = Array.isArray(hubPageBundle?.childLinks) ? hubPageBundle.childLinks.slice(0, 10) : [];
  return {
    hubUrl: getPageUrl(hubPageBundle),
    title: cleanText(hubPageBundle?.title || ""),
    sourceDomain: cleanText(hubPageBundle?.sourceDomain || ""),
    blockers: hubPageBundle?.blockers || {},
    fitSignals: hubPageBundle?.fitSignals || {},
    pageSignals: hubPageBundle?.pageSignals || {},
    evidenceSnippets: hubPageBundle?.evidenceSnippets || {},
    childLinks: childLinks.map((child, index) => ({
      childId: `child_${index + 1}`,
      url: cleanText(child?.url || ""),
      anchorText: cleanText(child?.anchorText || ""),
      sourceDomain: cleanText(child?.sourceDomain || ""),
      sameDomain: Boolean(child?.sameDomain),
      detailPathLikely: Boolean(child?.detailPathLikely),
      seenRecently: Boolean(child?.seenRecently)
    }))
  };
}

function buildExpansionPrompt({
  hubPageBundle = {},
  remainingBudget = {},
  maxChildrenToSelect = 4
} = {}) {
  const compact = compactHubPageBundle(hubPageBundle);
  return [
    "You are deciding whether to expand a fetched scholarship hub page.",
    "Return JSON only matching the provided schema.",
    "",
    "Your job:",
    "- Decide whether this hub should be expanded now.",
    "- If expansion is warranted, choose the best child links to fetch next.",
    "- Use the provided childId values exactly as written when returning selections or rejections.",
    "- Give one short hub-level rationale grounded only in the supplied evidence.",
    "- Give one short reason for each selected or rejected child you return.",
    "",
    "Important rules:",
    "- Use only the supplied hub page bundle data. Do not invent facts.",
    "- Treat blocker signals as strong evidence against expansion.",
    "- Treat specificSchoolSignal as a caution signal, not an automatic block.",
    "- If aggregatorSummarySignal and originalSourceLinkSignal are true, prefer offsite original-source/application/provider links over same-domain aggregator detail pages.",
    "- For aggregator summaries, avoid same-domain directory/detail children unless no plausible offsite original-source child is available.",
    "- Prefer a small, high-signal subset over selecting every child link.",
    "- Avoid obvious navigational or unrelated links such as donations, generic portals, login pages, or unrelated programs unless the provided evidence strongly suggests they are the only real scholarship path.",
    "- If remaining page or depth budget is too low, prefer not expanding.",
    "- If expand is false, selectedChildren must be empty.",
    "",
    `Remaining budget:\n${JSON.stringify({
      pages: clampCount(remainingBudget?.pages, 0),
      depth: clampCount(remainingBudget?.depth, 0)
    }, null, 2)}`,
    `Max children to select: ${clampCount(maxChildrenToSelect, 4) || 4}`,
    `Hub page bundle:\n${JSON.stringify(compact, null, 2)}`
  ].join("\n");
}

function buildSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      expand: { type: "boolean" },
      selectedChildren: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            childId: { type: "string" },
            reason: { type: "string" }
          },
          required: ["childId", "reason"]
        }
      },
      rejectedChildren: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            childId: { type: "string" },
            reason: { type: "string" }
          },
          required: ["childId", "reason"]
        }
      },
      rationale: { type: "string" },
      notes: {
        type: "array",
        items: { type: "string" }
      }
    },
    required: ["expand", "selectedChildren", "rejectedChildren", "rationale", "notes"]
  };
}

function validateAgentOutput({
  output = {},
  hubPageBundle = {},
  remainingBudget = {},
  maxChildrenToSelect = 4
} = {}) {
  const childLinks = Array.isArray(hubPageBundle?.childLinks) ? hubPageBundle.childLinks : [];
  const childMap = new Map();
  childLinks.forEach((child, index) => {
    const childId = `child_${index + 1}`;
    const url = cleanText(child?.url || "");
    if (!url) return;
    childMap.set(childId, { child, url });
  });

  const allowedCount = Math.max(
    0,
    Math.min(
      clampCount(maxChildrenToSelect, 4) || 4,
      clampCount(remainingBudget?.pages, 0)
    )
  );

  const expand = Boolean(output?.expand);
  const rationale = truncateText(output?.rationale || "", MAX_REASON_LENGTH);
  if (!rationale) {
    throw new Error("Missing rationale for decide_hub_expansion");
  }

  const selectedInput = Array.isArray(output?.selectedChildren) ? output.selectedChildren : [];
  const rejectedInput = Array.isArray(output?.rejectedChildren) ? output.rejectedChildren : [];
  const notes = Array.isArray(output?.notes)
    ? output.notes.map((note) => truncateText(note, 160)).filter(Boolean)
    : [];

  const seenIds = new Set();
  const selectedChildren = selectedInput.map((item) => {
    const childId = cleanText(item?.childId || "");
    const reason = truncateText(item?.reason || "", MAX_REASON_LENGTH);
    if (!childMap.has(childId)) {
      throw new Error(`Selected unknown childId: ${childId || "<empty>"}`);
    }
    if (seenIds.has(childId)) {
      throw new Error(`Duplicate childId in agent output: ${childId}`);
    }
    if (!reason) {
      throw new Error(`Missing reason for selected childId: ${childId}`);
    }
    seenIds.add(childId);
    return {
      url: childMap.get(childId).url,
      reason
    };
  });

  const rejectedChildren = [];
  for (const item of rejectedInput) {
    const childId = cleanText(item?.childId || "");
    const reason = truncateText(item?.reason || "", MAX_REASON_LENGTH);
    if (!childMap.has(childId)) {
      throw new Error(`Rejected unknown childId: ${childId || "<empty>"}`);
    }
    if (seenIds.has(childId)) {
      continue;
    }
    if (!reason) {
      throw new Error(`Missing reason for rejected childId: ${childId}`);
    }
    seenIds.add(childId);
    rejectedChildren.push({
      url: childMap.get(childId).url,
      reason
    });
  }

  const clampedSelected = selectedChildren.slice(0, allowedCount);
  if (selectedChildren.length > clampedSelected.length) {
    notes.push(`selection_clamped_to_budget=${clampedSelected.length}`);
  }

  if (!expand && clampedSelected.length > 0) {
    throw new Error("Agent selected child links while expand=false");
  }
  if (expand && clampedSelected.length === 0) {
    throw new Error("Agent set expand=true without selecting any child links");
  }

  return {
    expand,
    selectedChildren: clampedSelected,
    rejectedChildren: rejectedChildren.slice(0, MAX_DEBUG_REJECTED_CHILDREN),
    selectedChildUrls: clampedSelected.map((child) => child.url),
    rationale,
    notes
  };
}

function isOriginalSourceChild(child = {}, pageSignals = {}) {
  if (!pageSignals.aggregatorSummarySignal || !pageSignals.originalSourceLinkSignal) return false;
  if (child?.sameDomain) return false;
  const combined = `${cleanText(child?.anchorText || "")} ${cleanText(child?.url || "")}`.toLowerCase();
  return /\b(apply|application|official|source|provider|sponsor|website|scholarship|scholarships|award|grant|fellowship)\b/.test(combined);
}

function applyAgentGuardrails({
  decision = {},
  hubPageBundle = {},
  remainingBudget = {},
  maxChildrenToSelect = 4
} = {}) {
  const pageSignals = hubPageBundle?.pageSignals || {};
  const childLinks = Array.isArray(hubPageBundle?.childLinks) ? hubPageBundle.childLinks : [];
  const selectedUrls = new Set(Array.isArray(decision.selectedChildUrls) ? decision.selectedChildUrls : []);
  const originalSourceUrls = childLinks
    .filter((child) => isOriginalSourceChild(child, pageSignals))
    .map((child) => cleanText(child?.url || ""))
    .filter(Boolean);

  if (!pageSignals.aggregatorSummarySignal || !pageSignals.originalSourceLinkSignal || originalSourceUrls.length === 0) {
    return decision;
  }

  const selectedOriginalSource = originalSourceUrls.some((url) => selectedUrls.has(url));
  const selectedNonOriginal = Array.from(selectedUrls).some((url) => !originalSourceUrls.includes(url));
  if (selectedOriginalSource && !selectedNonOriginal) {
    return decision;
  }

  return {
    ...decideHubExpansion({
      hubPageBundle,
      remainingBudget,
      maxChildrenToSelect
    }),
    notes: [
      ...(Array.isArray(decision.notes) ? decision.notes : []),
      "agent_selection_overridden_to_prefer_original_source_links"
    ]
  };
}

function runCodexExec({
  prompt,
  schemaPath,
  outputPath,
  cwd,
  timeoutMs = DEFAULT_DECIDE_HUB_EXPANSION_TIMEOUT_MS,
  model = DEFAULT_DECIDE_HUB_EXPANSION_AI_MODEL
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
      reject(new Error(`decide_hub_expansion agent timed out after ${Math.round(timeoutMs / 1000)}s`));
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

export async function decideHubExpansionAgent({
  hubPageBundle = {},
  remainingBudget = {},
  maxChildrenToSelect = 4,
  timeoutMs = DEFAULT_DECIDE_HUB_EXPANSION_TIMEOUT_MS,
  model = String(process.env.DECIDE_HUB_EXPANSION_AI_MODEL || DEFAULT_DECIDE_HUB_EXPANSION_AI_MODEL).trim(),
  execImpl = runCodexExec
} = {}) {
  const hubUrl = getPageUrl(hubPageBundle);
  if (!hubUrl) {
    throw new Error("hubPageBundle must include a canonicalUrl, requestedUrl, or url");
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "decide-hub-expansion-agent-"));
  try {
    const schemaPath = path.join(tempDir, "schema.json");
    const outputPath = path.join(tempDir, "output.json");
    await fs.writeFile(schemaPath, `${JSON.stringify(buildSchema(), null, 2)}\n`, "utf8");

    await execImpl({
      prompt: buildExpansionPrompt({ hubPageBundle, remainingBudget, maxChildrenToSelect }),
      schemaPath,
      outputPath,
      cwd: process.cwd(),
      timeoutMs,
      model
    });

    const raw = await fs.readFile(outputPath, "utf8");
    const parsed = JSON.parse(raw);
    const decision = applyAgentGuardrails({
      decision: validateAgentOutput({
        output: parsed,
        hubPageBundle,
        remainingBudget,
        maxChildrenToSelect
      }),
      hubPageBundle,
      remainingBudget,
      maxChildrenToSelect
    });

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

export async function decideHubExpansionWithFallback({
  hubPageBundle = {},
  remainingBudget = {},
  maxChildrenToSelect = 4,
  timeoutMs = DEFAULT_DECIDE_HUB_EXPANSION_TIMEOUT_MS,
  model = String(process.env.DECIDE_HUB_EXPANSION_AI_MODEL || DEFAULT_DECIDE_HUB_EXPANSION_AI_MODEL).trim(),
  execImpl = runCodexExec
} = {}) {
  try {
    return await decideHubExpansionAgent({
      hubPageBundle,
      remainingBudget,
      maxChildrenToSelect,
      timeoutMs,
      model,
      execImpl
    });
  } catch (error) {
    return {
      ...decideHubExpansion({
        hubPageBundle,
        remainingBudget,
        maxChildrenToSelect
      }),
      metadata: {
        mode: "deterministic_fallback",
        fallbackReason: error?.message || String(error)
      }
    };
  }
}
