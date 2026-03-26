import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const TARGET_FIELDS = [
  "personalInfo.addressLine1",
  "personalInfo.addressLine2",
  "personalInfo.city",
  "personalInfo.state",
  "personalInfo.postalCode",
  "personalInfo.country",
  "academics.schoolName",
  "academics.gradeLevel",
  "academics.gpa"
];

function getByPath(obj, fieldPath) {
  const [root, child] = String(fieldPath || "").split(".");
  return obj?.[root]?.[child];
}

function setByPath(obj, fieldPath, value) {
  const [root, child] = String(fieldPath || "").split(".");
  if (!root || !child) return;
  if (!obj[root] || typeof obj[root] !== "object") {
    obj[root] = {};
  }
  obj[root][child] = value;
}

function getMissingOrLowConfidenceFields(profile, threshold = 0.85) {
  return TARGET_FIELDS.filter((fieldPath) => {
    const value = getByPath(profile, fieldPath);
    const confidence = Number(profile?.extractionConfidence?.[fieldPath] ?? 0);
    return !value || confidence < threshold;
  });
}

function compactText(raw, limit = 18000) {
  const text = String(raw || "").trim();
  if (!text) return "";
  if (text.length <= limit) return text;
  const head = text.slice(0, Math.floor(limit * 0.65));
  const tail = text.slice(-Math.floor(limit * 0.35));
  return `${head}\n...\n${tail}`;
}

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
      reject(new Error(`AI enrichment timed out after ${Math.round(timeoutMs / 1000)}s`));
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

export async function enrichProfileWithAi({ mergedProfile, documents, timeoutMs = 45000 } = {}) {
  const missingFields = getMissingOrLowConfidenceFields(mergedProfile);
  if (missingFields.length === 0) {
    return {
      profile: mergedProfile,
      metadata: { mode: "skipped", reason: "No missing/low-confidence target fields" }
    };
  }

  try {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "profile-ai-enrich-"));
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
                fieldPath: { type: "string", enum: TARGET_FIELDS },
                value: { type: "string" },
                confidence: { type: "number", minimum: 0, maximum: 1 },
                evidence: { type: "string" }
              },
              required: ["fieldPath", "value", "confidence", "evidence"]
            }
          }
        },
        required: ["updates"]
      };
      await fs.writeFile(schemaPath, `${JSON.stringify(schema, null, 2)}\n`, "utf8");

      const docs = (documents || []).map((doc, index) => ({
        documentId: doc.documentId || `doc-${index + 1}`,
        fileName: doc.fileName || doc.filePath || `document-${index + 1}`,
        text: compactText(doc.rawText || "")
      }));

      const prompt = [
        "You are enriching a student profile from application documents.",
        "Return JSON only matching the schema.",
        "",
        "Rules:",
        "- Only provide updates when clearly supported by document text.",
        "- Do not invent values.",
        "- If not sure, omit update.",
        "- Keep values concise and normalized (e.g. CA, 94117).",
        "",
        `Missing/low-confidence fields: ${missingFields.join(", ")}`,
        `Current profile snapshot:\n${JSON.stringify(mergedProfile, null, 2)}`,
        `Document text excerpts:\n${JSON.stringify(docs, null, 2)}`
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

      const enriched = JSON.parse(JSON.stringify(mergedProfile));
      let appliedCount = 0;
      for (const update of updates) {
        const fieldPath = String(update?.fieldPath || "");
        const value = String(update?.value || "").trim();
        const confidence = Number(update?.confidence ?? 0);
        if (!TARGET_FIELDS.includes(fieldPath) || !value) continue;
        if (!Number.isFinite(confidence) || confidence < 0.55) continue;

        const existing = getByPath(enriched, fieldPath);
        const existingConfidence = Number(enriched.extractionConfidence?.[fieldPath] ?? 0);
        if (existing && existingConfidence >= confidence) {
          continue;
        }

        setByPath(enriched, fieldPath, value);
        enriched.extractionConfidence[fieldPath] = confidence;
        enriched.fieldProvenance[fieldPath] = "ai_enrichment";
        appliedCount += 1;
      }

      return {
        profile: enriched,
        metadata: {
          mode: "ai_enrichment",
          requestedFields: missingFields,
          updatesSuggested: updates.length,
          updatesApplied: appliedCount
        }
      };
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  } catch (error) {
    return {
      profile: mergedProfile,
      metadata: {
        mode: "failed",
        reason: error?.message || String(error)
      }
    };
  }
}
