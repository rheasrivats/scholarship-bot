import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function runCodexExec({ prompt, schemaPath, outputPath, cwd, timeoutMs = 45000 }) {
  return new Promise((resolve, reject) => {
    const cmd = [
      "codex",
      "--search",
      "exec",
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
      reject(new Error(`Discovery AI assist timed out after ${Math.round(timeoutMs / 1000)}s`));
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

function mergeUniqueStrings(values) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(normalized);
  }
  return output;
}

function mergeCandidateWithUpdate(item, update) {
  const current = item.candidate;
  return {
    ...item,
    candidate: {
      ...current,
      eligibility: {
        minGpa: update.eligibility?.minGpa ?? current.eligibility.minGpa,
        allowedMajors: mergeUniqueStrings([
          ...current.eligibility.allowedMajors,
          ...(update.eligibility?.allowedMajors || [])
        ]),
        allowedEthnicities: mergeUniqueStrings([
          ...current.eligibility.allowedEthnicities,
          ...(update.eligibility?.allowedEthnicities || [])
        ])
      },
      inferredRequirements: {
        requiredMajors: mergeUniqueStrings([
          ...current.inferredRequirements.requiredMajors,
          ...(update.inferredRequirements?.requiredMajors || [])
        ]),
        requiredEthnicities: mergeUniqueStrings([
          ...current.inferredRequirements.requiredEthnicities,
          ...(update.inferredRequirements?.requiredEthnicities || [])
        ]),
        requiredStates: mergeUniqueStrings([
          ...current.inferredRequirements.requiredStates,
          ...(update.inferredRequirements?.requiredStates || [])
        ]),
        minAge: update.inferredRequirements?.minAge ?? current.inferredRequirements.minAge,
        maxAge: update.inferredRequirements?.maxAge ?? current.inferredRequirements.maxAge,
        requirementStatements: mergeUniqueStrings([
          ...current.inferredRequirements.requirementStatements,
          ...(update.inferredRequirements?.requirementStatements || [])
        ])
      }
    }
  };
}

function compactText(value, limit = 6000) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  if (text.length <= limit) {
    return text;
  }
  const head = text.slice(0, Math.floor(limit * 0.7));
  const tail = text.slice(-Math.floor(limit * 0.3));
  return `${head}\n...\n${tail}`;
}

export async function refineDiscoveryCandidatesWithAi({
  profile,
  candidates,
  timeoutMs = 45000
} = {}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "discovery-ai-assist-"));
  try {
    const schemaPath = path.join(tempDir, "schema.json");
    const outputPath = path.join(tempDir, "output.json");
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        updates: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              sourceUrl: { type: "string" },
              eligibility: {
                type: "object",
                additionalProperties: false,
                properties: {
                  minGpa: { anyOf: [{ type: "number" }, { type: "null" }] },
                  allowedMajors: { type: "array", items: { type: "string" } },
                  allowedEthnicities: { type: "array", items: { type: "string" } }
                },
                required: ["minGpa", "allowedMajors", "allowedEthnicities"]
              },
              inferredRequirements: {
                type: "object",
                additionalProperties: false,
                properties: {
                  requiredMajors: { type: "array", items: { type: "string" } },
                  requiredEthnicities: { type: "array", items: { type: "string" } },
                  requiredStates: { type: "array", items: { type: "string" } },
                  minAge: { anyOf: [{ type: "integer" }, { type: "null" }] },
                  maxAge: { anyOf: [{ type: "integer" }, { type: "null" }] },
                  requirementStatements: { type: "array", items: { type: "string" } }
                },
                required: ["requiredMajors", "requiredEthnicities", "requiredStates", "minAge", "maxAge", "requirementStatements"]
              }
            },
            required: ["sourceUrl", "eligibility", "inferredRequirements"]
          }
        }
      },
      required: ["updates"]
    };
    await fs.writeFile(schemaPath, `${JSON.stringify(schema, null, 2)}\n`, "utf8");

    const prompt = [
      "You are refining deterministic scholarship extraction output.",
      "Return JSON only matching the schema.",
      "",
      "Rules:",
      "- Use only the provided candidate data and requirement statements.",
      "- Do not invent deadlines, awards, or eligibility.",
      "- Only clarify majors, ethnicities, states, GPA, and age bounds when supported by the text.",
      "- If a field is uncertain, leave it unchanged by returning empty arrays or null values.",
      "",
      `Student profile:\n${JSON.stringify(profile || {}, null, 2)}`,
      `Candidate snapshots:\n${JSON.stringify(candidates, null, 2)}`
    ].join("\n");

    await runCodexExec({
      prompt,
      schemaPath,
      outputPath,
      cwd: process.cwd(),
      timeoutMs
    });

    const raw = await fs.readFile(outputPath, "utf8");
    const parsed = JSON.parse(raw);
    const updates = Array.isArray(parsed?.updates) ? parsed.updates : [];
    const updatesByUrl = new Map(updates.map((update) => [String(update.sourceUrl || ""), update]));

    const updatedCandidates = candidates.map((item) => {
      const update = updatesByUrl.get(String(item.candidate?.sourceUrl || ""));
      return update ? mergeCandidateWithUpdate(item, update) : item;
    });

    return {
      updatedCandidates,
      metadata: {
        mode: "ai_refined",
        requestedCandidates: candidates.length,
        updatesReturned: updates.length
      }
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export async function classifyDiscoveryPagesWithAi({
  profile,
  pages,
  timeoutMs = 45000
} = {}) {
  const pageList = Array.isArray(pages) ? pages : [];
  if (pageList.length === 0) {
    return {
      decisions: [],
      metadata: {
        mode: "skipped",
        reason: "no_pages"
      }
    };
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "discovery-ai-page-classify-"));
  try {
    const schemaPath = path.join(tempDir, "schema.json");
    const outputPath = path.join(tempDir, "output.json");
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        decisions: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              sourceUrl: { type: "string" },
              classification: {
                type: "string",
                enum: ["direct_scholarship", "scholarship_list_page", "not_scholarship_page"]
              },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              rationale: { type: "string" }
            },
            required: ["sourceUrl", "classification", "confidence", "rationale"]
          }
        }
      },
      required: ["decisions"]
    };
    await fs.writeFile(schemaPath, `${JSON.stringify(schema, null, 2)}\n`, "utf8");

    const compactPages = pageList.map((page) => ({
      sourceUrl: String(page.sourceUrl || ""),
      title: String(page.title || ""),
      pathname: String(page.pathname || ""),
      preliminaryDecision: String(page.preliminaryDecision || ""),
      preliminarySkipReason: String(page.preliminarySkipReason || ""),
      extractedCandidate: page.extractedCandidate || null,
      childUrls: Array.isArray(page.childUrls) ? page.childUrls.slice(0, 8) : [],
      textExcerpt: compactText(page.textExcerpt || "", 5000)
    }));

    const prompt = [
      "You are reviewing deterministic scholarship discovery page classifications.",
      "Return JSON only matching the schema.",
      "",
      "Classify each page as exactly one of:",
      '- "direct_scholarship": one individual scholarship or award detail page.',
      '- "scholarship_list_page": a roundup, directory, category page, portal homepage, or page that mainly links to many scholarships.',
      '- "not_scholarship_page": unrelated or organizational content that should not be shown as a scholarship result.',
      "",
      "Rules:",
      "- Prefer scholarship_list_page for pages that list many scholarships, category pages, portal homepages, or navigational hubs.",
      "- Only use direct_scholarship when the page is clearly about one specific scholarship opportunity.",
      "- Do not invent facts beyond the provided page excerpt and extracted snapshot.",
      "",
      `Student profile:\n${JSON.stringify(profile || {}, null, 2)}`,
      `Pages to classify:\n${JSON.stringify(compactPages, null, 2)}`
    ].join("\n");

    await runCodexExec({
      prompt,
      schemaPath,
      outputPath,
      cwd: process.cwd(),
      timeoutMs
    });

    const raw = await fs.readFile(outputPath, "utf8");
    const parsed = JSON.parse(raw);
    const decisions = Array.isArray(parsed?.decisions) ? parsed.decisions : [];
    return {
      decisions,
      metadata: {
        mode: "ai_page_classifier",
        requestedPages: pageList.length,
        decisionsReturned: decisions.length
      }
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}
