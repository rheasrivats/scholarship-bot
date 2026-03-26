import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function countWords(text) {
  return String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function parseEssayWordConstraints(prompt) {
  const value = String(prompt || "");
  const lower = value.toLowerCase();

  let minWords = null;
  let maxWords = null;

  const rangeA = lower.match(/\b(\d{2,4})\s*[-–]\s*(\d{2,4})\s*words?\b/);
  if (rangeA) {
    const a = Number(rangeA[1]);
    const b = Number(rangeA[2]);
    minWords = Math.min(a, b);
    maxWords = Math.max(a, b);
  }

  const rangeB = lower.match(/\bbetween\s+(\d{2,4})\s+and\s+(\d{2,4})\s+words?\b/);
  if (rangeB) {
    const a = Number(rangeB[1]);
    const b = Number(rangeB[2]);
    minWords = Math.min(a, b);
    maxWords = Math.max(a, b);
  }

  const minA = lower.match(/\bminimum\s+(\d{2,4})\s+words?\b/);
  const minB = lower.match(/\bat\s+least\s+(\d{2,4})\s+words?\b/);
  if (minA) minWords = Number(minA[1]);
  if (minB) minWords = Number(minB[1]);

  const maxA = lower.match(/\bmaximum\s+(\d{2,4})\s+words?\b/);
  const maxB = lower.match(/\bmax(?:imum)?\s*[:\-]?\s*(\d{2,4})\s+words?\b/);
  const maxC = lower.match(/\bup\s+to\s+(\d{2,4})\s+words?\b/);
  if (maxA) maxWords = Number(maxA[1]);
  if (maxB) maxWords = Number(maxB[1]);
  if (maxC) maxWords = Number(maxC[1]);

  if (Number.isFinite(minWords) && Number.isFinite(maxWords) && minWords > maxWords) {
    const t = minWords;
    minWords = maxWords;
    maxWords = t;
  }

  return {
    minWords: Number.isFinite(minWords) ? minWords : null,
    maxWords: Number.isFinite(maxWords) ? maxWords : null
  };
}

function chooseTargetWords({ minWords, maxWords }) {
  if (Number.isFinite(minWords) && Number.isFinite(maxWords)) {
    return Math.round((minWords + maxWords) / 2);
  }
  if (Number.isFinite(minWords)) {
    return Math.min(minWords + 40, minWords + 120);
  }
  if (Number.isFinite(maxWords)) {
    return Math.max(120, maxWords - 30);
  }
  return 320;
}

function compactProfile(profile = {}) {
  const p = profile || {};
  return {
    personalInfo: {
      fullName: p.personalInfo?.fullName || null,
      intendedMajor: p.personalInfo?.intendedMajor || null,
      ethnicity: p.personalInfo?.ethnicity || null,
      city: p.personalInfo?.city || null,
      state: p.personalInfo?.state || null
    },
    academics: {
      schoolName: p.academics?.schoolName || null,
      gradeLevel: p.academics?.gradeLevel || null,
      gpa: p.academics?.gpa || null
    },
    activities: Array.isArray(p.activities) ? p.activities.slice(0, 12) : [],
    awards: Array.isArray(p.awards) ? p.awards.slice(0, 12) : [],
    essays: Array.isArray(p.essays)
      ? p.essays.slice(0, 3).map((essay) => ({
          prompt: essay.prompt || null,
          contentPreview: String(essay.content || "").slice(0, 1200)
        }))
      : []
  };
}

function runCodexExec({ prompt, schemaPath, outputPath, cwd, timeoutMs = 120000 }) {
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
      reject(new Error(`Essay draft timed out after ${Math.round(timeoutMs / 1000)}s`));
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

export async function generateEssayDraftWithAgent({
  prompt,
  studentProfile,
  scholarshipName,
  timeoutMs = 120000
} = {}) {
  const essayPrompt = String(prompt || "").trim();
  if (!essayPrompt) {
    throw new Error("Essay prompt is required");
  }

  const constraints = parseEssayWordConstraints(essayPrompt);
  const targetWords = chooseTargetWords(constraints);
  const profile = compactProfile(studentProfile);

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "essay-draft-agent-"));
  try {
    const schemaPath = path.join(tempDir, "schema.json");
    const outputPath = path.join(tempDir, "output.json");
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        essay: { type: "string" }
      },
      required: ["essay"]
    };
    await fs.writeFile(schemaPath, `${JSON.stringify(schema, null, 2)}\n`, "utf8");

    const promptText = [
      "You are drafting a scholarship essay response.",
      "Return JSON only matching schema.",
      "",
      "Requirements:",
      "- Write in first person and keep the tone authentic, specific, and grounded.",
      "- Use only facts supported by the provided profile context.",
      "- Do not invent achievements, demographics, diagnoses, or experiences.",
      `- Target approximately ${targetWords} words.`,
      constraints.minWords ? `- Must be at least ${constraints.minWords} words.` : "",
      constraints.maxWords ? `- Must be at most ${constraints.maxWords} words.` : "",
      "",
      `Scholarship: ${String(scholarshipName || "Scholarship application").trim()}`,
      `Essay prompt:\n${essayPrompt}`,
      "",
      `Student profile context:\n${JSON.stringify(profile, null, 2)}`
    ].filter(Boolean).join("\n");

    await runCodexExec({
      prompt: promptText,
      schemaPath,
      outputPath,
      cwd: process.cwd(),
      timeoutMs
    });

    const raw = await fs.readFile(outputPath, "utf8");
    const parsed = JSON.parse(raw);
    const essay = String(parsed?.essay || "").trim();
    if (!essay) {
      throw new Error("Agent returned empty essay");
    }

    const words = countWords(essay);
    if (constraints.minWords && words < constraints.minWords) {
      throw new Error(`Draft is too short (${words} words; minimum is ${constraints.minWords})`);
    }
    if (constraints.maxWords && words > constraints.maxWords) {
      throw new Error(`Draft is too long (${words} words; maximum is ${constraints.maxWords})`);
    }

    return {
      essay,
      wordCount: words,
      minWords: constraints.minWords,
      maxWords: constraints.maxWords,
      targetWords
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export const __testables = {
  parseEssayWordConstraints,
  chooseTargetWords,
  countWords
};

