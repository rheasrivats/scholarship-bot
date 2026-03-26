import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function stripTags(value) {
  return String(value || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function parseAttributes(raw = "") {
  const attrs = {};
  const attrRegex = /([a-zA-Z_:][a-zA-Z0-9_:.:-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let match = attrRegex.exec(raw);
  while (match) {
    const key = String(match[1] || "").toLowerCase();
    const value = match[3] ?? match[4] ?? match[5] ?? "";
    attrs[key] = value;
    match = attrRegex.exec(raw);
  }
  return attrs;
}

function extractApplicationLinks(html, baseUrl) {
  const ranked = [];
  const linkRegex = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match = linkRegex.exec(html);
  while (match) {
    const attrs = parseAttributes(match[1]);
    const href = String(attrs.href || "").trim();
    if (!href || href.startsWith("#") || href.toLowerCase().startsWith("javascript:")) {
      match = linkRegex.exec(html);
      continue;
    }

    let absoluteUrl;
    try {
      absoluteUrl = new URL(href, baseUrl).toString();
    } catch {
      match = linkRegex.exec(html);
      continue;
    }

    const text = stripTags(match[2]).toLowerCase();
    const descriptor = `${text} ${String(attrs.title || "").toLowerCase()} ${href.toLowerCase()}`;
    let score = 0;
    if (/(apply|application|start application|apply now|begin)/.test(descriptor)) score += 4;
    if (/(form|portal|login|register)/.test(descriptor)) score += 1;
    if (/mailto:/.test(href.toLowerCase())) score -= 3;
    ranked.push({ absoluteUrl, score });
    match = linkRegex.exec(html);
  }

  const unique = new Map();
  for (const item of ranked) {
    if (!unique.has(item.absoluteUrl) || unique.get(item.absoluteUrl).score < item.score) {
      unique.set(item.absoluteUrl, item);
    }
  }

  return Array.from(unique.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
    .map((item) => item.absoluteUrl);
}

function runCodexExec({ prompt, schemaPath, outputPath, cwd, timeoutMs = 180000 }) {
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

    const proc = spawn(cmd[0], cmd.slice(1), {
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`codex exec timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    proc.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`codex exec failed (exit ${code})\n${stderr || stdout}`));
        return;
      }
      resolve({ stdout, stderr });
    });

    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

async function fetchHtml(url, timeoutMs = 15000) {
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "user-agent": "ScholarshipBot/0.1 (+agent-form-mapper)",
        accept: "text/html,application/xhtml+xml"
      },
      signal: controller?.signal
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.text();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function summarizeHtml(html, limit = 18000) {
  const text = stripTags(html);
  return text.slice(0, limit);
}

function summarizeRawHtml(html, limit = 24000) {
  return String(html || "").slice(0, limit);
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "manual_field";
}

function looksLikeUploadField(text) {
  return /(upload|attach|attachment|choose file|drop files|transcript|resume|cv)/i.test(String(text || ""));
}

function looksLikeEssayField(text) {
  return /(essay|personal statement|short answer|long answer|minimum\s+\d+\s+words|response)/i.test(String(text || ""));
}

function isLikelyEssayPrompt(text) {
  const value = String(text || "").trim();
  if (!value || value.length < 25 || value.length > 500) return false;
  if (/^personal statement( response)?$/i.test(value)) return false;
  if (/^essay( response)?$/i.test(value)) return false;
  if (/\?/.test(value)) return true;
  return looksLikeEssayField(value);
}

function deriveEssayPrompt(values) {
  const candidates = Array.isArray(values) ? values : [];
  for (const candidate of candidates) {
    if (isLikelyEssayPrompt(candidate)) {
      return String(candidate).trim();
    }
  }
  return undefined;
}

function extractEssayPromptFromCorpus(corpus) {
  const lines = String(corpus || "")
    .split("\n")
    .map((line) => stripTags(line).trim())
    .filter(Boolean);

  return deriveEssayPrompt(lines) || "";
}

function augmentFromClues(existingFields, pages) {
  const fields = [...existingFields];
  const seenNames = new Set(fields.map((f) => String(f.fieldName || "").toLowerCase()));
  const corpus = pages.map((p) => `${p.text || ""}\n${p.htmlSnippet || ""}`).join("\n").toLowerCase();

  const clues = [
    { label: "Street Address", pattern: /(street address|address line 1)/, sourcePath: "personalInfo.addressLine1", fieldName: "street_address" },
    { label: "Address Line 2", pattern: /(apt|suite|unit|building|address line 2)/, sourcePath: "personalInfo.addressLine2", fieldName: "address_line_2" },
    { label: "City", pattern: /\bcity\b/, sourcePath: "personalInfo.city", fieldName: "city" },
    { label: "State/Province/Region", pattern: /(state|province|region)/, sourcePath: "personalInfo.state", fieldName: "state_region" },
    { label: "Postal Code", pattern: /(postal code|zip code|zipcode)/, sourcePath: "personalInfo.postalCode", fieldName: "postal_code" },
    { label: "Country", pattern: /\bcountry\b/, sourcePath: "personalInfo.country", fieldName: "country" },
    { label: "School Name", pattern: /(school name|high school)/, sourcePath: "academics.schoolName", fieldName: "school_name" },
    { label: "Grade Level", pattern: /(grade level|current grade)/, sourcePath: "academics.gradeLevel", fieldName: "grade_level" },
    { label: "Transcript Upload", pattern: /(upload transcript|transcript upload|transcript)/, sourcePath: "__manual__.transcript_upload", fieldName: "transcript_upload", fieldType: "file" },
    { label: "Personal Essay Upload", pattern: /(upload personal essay|personal essay upload)/, sourcePath: "__manual__.personal_essay_upload", fieldName: "personal_essay_upload", fieldType: "file" },
    { label: "Personal Statement", pattern: /(personal statement|minimum 500 words|essay response|short answer)/, sourcePath: "essays.0.content", fieldName: "personal_statement", fieldType: "textarea" }
  ];

  const essayPromptFromCorpus = extractEssayPromptFromCorpus(corpus);

  for (const clue of clues) {
    if (!clue.pattern.test(corpus)) continue;
    const key = String(clue.fieldName || "").toLowerCase();
    if (seenNames.has(key)) continue;
    seenNames.add(key);
    fields.push({
      fieldName: clue.fieldName || slugify(clue.label),
      displayLabel: clue.sourcePath === "essays.0.content" && essayPromptFromCorpus ? essayPromptFromCorpus : clue.label,
      sourcePath: clue.sourcePath,
      fieldType: clue.fieldType || undefined,
      essayPrompt: clue.sourcePath === "essays.0.content" && essayPromptFromCorpus ? essayPromptFromCorpus : undefined,
      mappingReason: "Added from multi-step form clue detection"
    });
  }

  if (essayPromptFromCorpus) {
    for (const field of fields) {
      if (!String(field.sourcePath || "").startsWith("essays.")) {
        continue;
      }
      if (!field.essayPrompt) {
        field.essayPrompt = essayPromptFromCorpus;
      }
    }
  }

  return fields;
}

function normalizeMappedFields(raw) {
  if (!Array.isArray(raw)) return [];
  const clean = [];
  const seen = new Set();
  for (const row of raw) {
    const fieldName = String(row?.fieldName || "").trim();
    const rawSourcePath = String(row?.sourcePath || "").trim();
    if (!fieldName || !rawSourcePath) continue;
    const displayLabel = String(row?.displayLabel || "").trim();
    const combinedText = `${fieldName} ${displayLabel}`;
    const normalizedSourcePath = looksLikeUploadField(combinedText)
      ? `__manual__.${slugify(fieldName)}`
      : rawSourcePath;

    const key = `${fieldName.toLowerCase()}::${normalizedSourcePath.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const mappingReason = String(row?.reason || row?.mappingReason || "").trim();
    const sourceIsEssay = normalizedSourcePath.startsWith("essays.");
    const fieldType = String(
      row?.fieldType
      || (looksLikeUploadField(combinedText) ? "file" : "")
      || (sourceIsEssay ? "textarea" : "")
      || "text"
    ).trim();
    if (
      /^eligibility[_\s-]*confirmation$/i.test(fieldName)
      || /^eligibility[_\s-]*confirmation$/i.test(displayLabel)
    ) {
      continue;
    }
    const essayPrompt = sourceIsEssay
      ? deriveEssayPrompt([row?.essayPrompt, displayLabel, fieldName])
      : undefined;
    clean.push({
      fieldName,
      sourcePath: normalizedSourcePath,
      displayLabel: displayLabel || undefined,
      fieldType,
      essayPrompt,
      acceptedFileTypes: row?.acceptedFileTypes ? String(row.acceptedFileTypes).trim() : undefined,
      mappingReason: mappingReason || undefined
    });
  }
  return clean.slice(0, 80);
}

export async function generateFormMappingWithAgentFromUrl(url, {
  fetchTimeoutMs = 15000,
  codexTimeoutMs = 180000
} = {}) {
  const sourceUrl = String(url || "").trim();
  if (!sourceUrl) {
    throw new Error("Scholarship sourceUrl is required for agent form mapping.");
  }
  const parsed = new URL(sourceUrl);

  const primaryHtml = await fetchHtml(parsed.toString(), fetchTimeoutMs);
  const linkCandidates = extractApplicationLinks(primaryHtml, parsed.toString());

  const pages = [{ url: parsed.toString(), text: summarizeHtml(primaryHtml) }];
  for (const candidateUrl of linkCandidates) {
    try {
      const html = await fetchHtml(candidateUrl, fetchTimeoutMs);
      pages.push({ url: candidateUrl, text: summarizeHtml(html), htmlSnippet: summarizeRawHtml(html) });
    } catch {
      // best effort only
    }
  }
  pages[0].htmlSnippet = summarizeRawHtml(primaryHtml);

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      selectedUrl: { type: "string" },
      formFields: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            fieldName: { type: "string" },
            displayLabel: { type: "string" },
            sourcePath: { type: "string" },
            reason: { type: "string" }
          },
          required: ["fieldName", "displayLabel", "sourcePath", "reason"]
        }
      }
    },
    required: ["selectedUrl", "formFields"]
  };

  const prompt = [
    "You are mapping scholarship application form fields to a student profile schema.",
    "Return JSON only matching the schema.",
    "",
    "Rules:",
    "- Map safe known fields to profile paths:",
    "  personalInfo.fullName, personalInfo.email, personalInfo.phone, personalInfo.intendedMajor, personalInfo.ethnicity, personalInfo.dateOfBirth, academics.gpa, essays.0.content",
    "  personalInfo.addressLine1, personalInfo.addressLine2, personalInfo.city, personalInfo.state, personalInfo.postalCode, personalInfo.country, academics.schoolName, academics.gradeLevel",
    "- If field is sensitive (ssn, passport, bank, credit card, cvv), use __manual__.<slug>.",
    "- If field cannot be reliably mapped, use __manual__.<slug>.",
    "- Include ALL visible applicant-entered fields across ALL steps when identifiable, including address, school info, dropdowns, and upload fields.",
    "- Include file upload controls as manual fields, e.g., transcript_upload and personal_essay_upload.",
    "- displayLabel must be human-readable and specific (e.g., 'Applicant First Name', 'Date of Birth', 'Personal Statement').",
    "- Do not use generic labels like input_1, input_2 as displayLabel.",
    "- Prefer the URL that contains the actual application form controls.",
    "",
    `Candidate pages (most likely first):\n${JSON.stringify(pages, null, 2)}`
  ].join("\n");

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-form-mapper-"));
  try {
    const schemaPath = path.join(tempDir, "schema.json");
    const outputPath = path.join(tempDir, "output.json");
    await fs.writeFile(schemaPath, `${JSON.stringify(schema, null, 2)}\n`, "utf8");

    await runCodexExec({
      prompt,
      schemaPath,
      outputPath,
      cwd: process.cwd(),
      timeoutMs: codexTimeoutMs
    });

    const raw = await fs.readFile(outputPath, "utf8");
    const parsedOutput = JSON.parse(raw);
    const formFields = augmentFromClues(normalizeMappedFields(parsedOutput.formFields), pages);
    if (formFields.length === 0) {
      throw new Error("Agent returned no mappable form fields.");
    }
    return {
      sourceUrl: String(parsedOutput.selectedUrl || pages[0]?.url || sourceUrl),
      formFields,
      discoveredCount: formFields.length
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}
