import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function compactJson(value, limit = 12000) {
  const text = JSON.stringify(value, null, 2);
  if (text.length <= limit) return text;
  const head = text.slice(0, Math.floor(limit * 0.7));
  const tail = text.slice(-Math.floor(limit * 0.3));
  return `${head}\n...\n${tail}`;
}

function runCodexExec({ prompt, schemaPath, outputPath, cwd, timeoutMs = 25000 }) {
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
      reject(new Error(`Guided AI field mapping timed out after ${Math.round(timeoutMs / 1000)}s`));
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

function buildSchema(allowedPayloadKeys) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      mappings: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            frameUrl: { type: "string" },
            fieldIndex: { type: "integer", minimum: 0 },
            fieldLabel: { type: "string" },
            payloadKey: { type: "string", enum: allowedPayloadKeys },
            interaction: { type: "string", enum: ["type", "select", "combobox", "contenteditable", "skip"] },
            value: { type: "string" },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            reason: { type: "string" }
          },
          required: ["frameUrl", "fieldIndex", "fieldLabel", "payloadKey", "interaction", "value", "confidence", "reason"]
        }
      }
    },
    required: ["mappings"]
  };
}

export async function planGuidedFieldMappingsWithAi({
  pageUrl,
  pageTitle,
  fields,
  payload,
  timeoutMs = 25000
} = {}) {
  if (String(process.env.GUIDED_ENABLE_AI_FIELD_MAPPER || "1") === "0") {
    return {
      mappings: [],
      metadata: { mode: "disabled", reason: "GUIDED_ENABLE_AI_FIELD_MAPPER=0" }
    };
  }

  const fieldRows = Array.isArray(fields) ? fields.filter(Boolean) : [];
  const payloadEntries = Object.entries(payload || {})
    .filter(([key, value]) => value !== null && value !== undefined && String(value).trim())
    .map(([key, value]) => [String(key), String(value)]);

  if (!fieldRows.length || !payloadEntries.length) {
    return {
      mappings: [],
      metadata: { mode: "skipped", reason: "No fields or payload values available" }
    };
  }

  const allowedPayloadKeys = payloadEntries.map(([key]) => key);

  try {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "guided-ai-fill-"));
    try {
      const schemaPath = path.join(tempDir, "schema.json");
      const outputPath = path.join(tempDir, "output.json");
      await fs.writeFile(schemaPath, `${JSON.stringify(buildSchema(allowedPayloadKeys), null, 2)}\n`, "utf8");

      const prompt = [
        "You are mapping student profile values to the currently visible fields on a scholarship form.",
        "Return JSON only matching the schema.",
        "",
        "Rules:",
        "- Prefer exact semantic matches between the field and a payload key/value.",
        "- Use interaction=combobox for autocomplete/react-select style controls.",
        "- Use interaction=select for native select dropdowns.",
        "- Use interaction=type for normal text inputs.",
        "- Use interaction=contenteditable only if the field clearly looks rich-text/contenteditable.",
        "- Use interaction=skip when no safe match exists.",
        "- Be conservative. Do not guess payment, legal, signature, or security fields.",
        "- Confidence should be high only when the mapping is clear from the label, placeholder, role, and options.",
        "- If a field asks for address, city, state, zip, school name, GPA, grade level, major, ethnicity, DOB, or contact info, prefer the corresponding profile value if available.",
        "",
        `Page URL: ${String(pageUrl || "")}`,
        `Page title: ${String(pageTitle || "")}`,
        `Visible fields:\n${compactJson(fieldRows, 18000)}`,
        `Available payload values:\n${compactJson(Object.fromEntries(payloadEntries), 8000)}`
      ].join("\n");

      await runCodexExec({
        prompt,
        schemaPath,
        outputPath,
        cwd: process.cwd(),
        timeoutMs
      });

      const parsed = JSON.parse(await fs.readFile(outputPath, "utf8"));
      const mappings = Array.isArray(parsed?.mappings) ? parsed.mappings : [];
      return {
        mappings,
        metadata: {
          mode: "ai_field_mapper",
          suggestedMappings: mappings.length
        }
      };
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  } catch (error) {
    return {
      mappings: [],
      metadata: {
        mode: "failed",
        reason: error?.message || String(error)
      }
    };
  }
}
