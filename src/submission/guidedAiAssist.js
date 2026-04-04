import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const DEFAULT_GUIDED_AI_MODEL = "gpt-5.4-mini";
const DEFAULT_GUIDED_AI_REASONING_EFFORT = "low";

function envFlagEnabled(value, defaultValue = false) {
  if (value === undefined || value === null || value === "") return defaultValue;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function compactJson(value, limit = 12000) {
  const text = JSON.stringify(value, null, 2);
  if (text.length <= limit) return text;
  const head = text.slice(0, Math.floor(limit * 0.7));
  const tail = text.slice(-Math.floor(limit * 0.3));
  return `${head}\n...\n${tail}`;
}

function runCodexExec({ prompt, schemaPath, outputPath, cwd, timeoutMs = 25000 }) {
  return new Promise((resolve, reject) => {
    const model = String(process.env.GUIDED_AI_MODEL || process.env.AUTOFILL_AI_MODEL || DEFAULT_GUIDED_AI_MODEL).trim();
    const reasoningEffort = String(process.env.GUIDED_AI_REASONING_EFFORT || DEFAULT_GUIDED_AI_REASONING_EFFORT).trim();
    const enableSearch = envFlagEnabled(
      process.env.GUIDED_AI_ENABLE_SEARCH,
      envFlagEnabled(process.env.AUTOFILL_AI_ENABLE_SEARCH, false)
    );
    const cmd = ["codex"];
    if (enableSearch) {
      cmd.push("--search");
    }
    cmd.push(
      "exec",
      "-m",
      model,
      "-c",
      `model_reasoning_effort="${reasoningEffort}"`,
      "--skip-git-repo-check",
      "-C",
      cwd,
      "--output-schema",
      schemaPath,
      "--output-last-message",
      outputPath,
      "-"
    );

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

function buildActionSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      actions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            frameUrl: { type: "string" },
            elementIndex: { type: "integer", minimum: 0 },
            interaction: { type: "string", enum: ["type", "select", "combobox", "contenteditable", "click", "skip"] },
            value: { type: "string" },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            reason: { type: "string" }
          },
          required: ["frameUrl", "elementIndex", "interaction", "value", "confidence", "reason"]
        }
      }
    },
    required: ["actions"]
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

export async function planGuidedActionsWithAi({
  pageUrl,
  pageTitle,
  elements,
  payload,
  timeoutMs = 20000
} = {}) {
  if (String(process.env.GUIDED_ENABLE_AI_FIELD_MAPPER || "1") === "0") {
    return {
      actions: [],
      metadata: { mode: "disabled", reason: "GUIDED_ENABLE_AI_FIELD_MAPPER=0" }
    };
  }

  const actionRows = Array.isArray(elements) ? elements.filter(Boolean) : [];
  if (!actionRows.length) {
    return {
      actions: [],
      metadata: { mode: "skipped", reason: "No actionable elements available" }
    };
  }

  const payloadObject = Object.fromEntries(
    Object.entries(payload || {})
      .filter(([key, value]) => value !== null && value !== undefined && String(value).trim())
      .map(([key, value]) => [String(key), String(value)])
  );

  try {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "guided-ai-actions-"));
    try {
      const schemaPath = path.join(tempDir, "schema.json");
      const outputPath = path.join(tempDir, "output.json");
      await fs.writeFile(schemaPath, `${JSON.stringify(buildActionSchema(), null, 2)}\n`, "utf8");

      const prompt = [
        "You are an AI browser interaction planner for scholarship application autofill.",
        "Return JSON only matching the schema.",
        "",
        "Goal:",
        "- Choose safe, high-confidence actions to progress and autofill the current page.",
        "- You may click choice cards/buttons, type text, or choose dropdown/combobox values.",
        "",
        "Hard safety rules:",
        "- NEVER click submit/final submit/complete application/pay/send/sign/finalize actions.",
        "- NEVER fill legal signature, payment, SSN, passport, or credit-card fields.",
        "- If unsure, return interaction=skip for that element.",
        "",
        "Choice-card rules:",
        "- For stage/degree questions, use available profile data (student_stage, grade_level).",
        "- For demographic questions (gender, race/ethnicity), if profile contains a value, prefer that value when matching options exist. Include compact forms like M/F/NB and short race labels (e.g., AA, W, A) in your matching logic.",
        "- If no value exists in profile, prefer 'Prefer not to say' only if that option exists on the page; otherwise return interaction=skip.",
        "",
        "Output rules:",
        "- Return at most 4 actions for this round.",
        "- Use confidence >= 0.75 only when the mapping/choice is clear from text.",
        "- Include a short reason for each action.",
        "",
        `Page URL: ${String(pageUrl || "")}`,
        `Page title: ${String(pageTitle || "")}`,
        `Actionable elements:\n${compactJson(actionRows, 26000)}`,
        `Available payload values:\n${compactJson(payloadObject, 12000)}`
      ].join("\n");

      await runCodexExec({
        prompt,
        schemaPath,
        outputPath,
        cwd: process.cwd(),
        timeoutMs
      });

      const parsed = JSON.parse(await fs.readFile(outputPath, "utf8"));
      const actions = Array.isArray(parsed?.actions) ? parsed.actions : [];
      return {
        actions,
        metadata: {
          mode: "ai_action_planner",
          suggestedActions: actions.length
        }
      };
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  } catch (error) {
    return {
      actions: [],
      metadata: {
        mode: "failed",
        reason: error?.message || String(error)
      }
    };
  }
}
