import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { runNoAccountMvp } from "../pipeline/runNoAccountMvp.js";
import { getScholarshipsDataFilePath, loadScholarships, replaceScholarships } from "../data/scholarshipStore.js";
import { generateFormMappingWithPlaywrightFromUrl } from "../autofill/playwrightFormMapper.js";
import { generateFormMappingWithAgentFromUrl } from "../autofill/agentFormMapper.js";
import { generateEssayDraftWithAgent } from "../autofill/essayDraftAgent.js";
import {
  candidateToScholarshipRecord,
  getCandidatesDataFilePath,
  importCandidates,
  loadCandidates,
  reviewCandidate
} from "../data/candidateStore.js";
import {
  startGuidedSubmission,
  advanceGuidedSubmission,
  refillGuidedSubmission,
  resumeGuidedSubmissionAfterAccount,
  upsertGuidedSubmissionPayload,
  stopGuidedSubmission
} from "../submission/guidedSubmitter.js";

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";

    req.on("data", (chunk) => {
      data += chunk;
    });

    req.on("end", () => {
      if (!data) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(data));
      } catch (error) {
        reject(new Error("Invalid JSON body"));
      }
    });

    req.on("error", reject);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload, null, 2));
}

function tailText(value, maxLines = 80) {
  const lines = String(value || "").split("\n");
  return lines.slice(-maxLines).join("\n");
}

function runProcess(command, args, { cwd, env = {}, timeoutMs = 600000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        ...env
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Process timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/") {
    try {
      const page = await fs.readFile(path.resolve(process.cwd(), "src/web/index.html"), "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(page);
    } catch (error) {
      sendJson(res, 500, { error: `Unable to load UI: ${error.message}` });
    }
    return;
  }

  if (req.method === "GET" && req.url === "/admin") {
    try {
      const page = await fs.readFile(path.resolve(process.cwd(), "src/web/index.html"), "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(page);
    } catch (error) {
      sendJson(res, 500, { error: `Unable to load UI: ${error.message}` });
    }
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && req.url === "/scholarships") {
    sendJson(res, 200, {
      scholarships: await loadScholarships({ forceReload: true }),
      sourceFile: getScholarshipsDataFilePath()
    });
    return;
  }

  if (req.method === "GET" && req.url === "/admin/scholarships") {
    sendJson(res, 200, {
      scholarships: await loadScholarships({ forceReload: true }),
      sourceFile: getScholarshipsDataFilePath()
    });
    return;
  }

  if (req.method === "GET" && req.url === "/admin/candidates") {
    sendJson(res, 200, {
      candidates: await loadCandidates({ forceReload: true }),
      sourceFile: getCandidatesDataFilePath()
    });
    return;
  }

  if (req.method === "POST" && req.url === "/run-no-account-mvp") {
    try {
      const body = await parseBody(req);
      const sessionId = body.sessionId || `session-${Date.now()}`;
      const documents = body.documents || [];

      if (!Array.isArray(documents) || documents.length === 0) {
        sendJson(res, 400, { error: "documents must be a non-empty array" });
        return;
      }

      const result = await runNoAccountMvp({
        sessionId,
        documents,
        scholarships: await loadScholarships(),
        maxDrafts: typeof body.maxDrafts === "number" ? body.maxDrafts : 5,
        overrides: body.overrides || {},
        enableAiEnrichment: body.enableAiEnrichment === true,
        aiTimeoutMs: typeof body.aiTimeoutMs === "number" ? body.aiTimeoutMs : 45000
      });

      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }

    return;
  }

  if (req.method === "POST" && req.url === "/run-no-account-mvp-upload") {
    try {
      const body = await parseBody(req);
      const sessionId = body.sessionId || `session-${Date.now()}`;
      const documents = body.documents || [];

      if (!Array.isArray(documents) || documents.length === 0) {
        sendJson(res, 400, { error: "documents must be a non-empty array" });
        return;
      }

      const normalizedDocuments = documents.map((doc, index) => {
        if (!doc || !doc.fileName || !doc.contentBase64) {
          throw new Error(`Document at index ${index} must include fileName and contentBase64`);
        }

        return {
          documentId: doc.documentId || `doc-${index + 1}`,
          fileName: doc.fileName,
          fileBuffer: Buffer.from(doc.contentBase64, "base64")
        };
      });

      const result = await runNoAccountMvp({
        sessionId,
        documents: normalizedDocuments,
        scholarships: await loadScholarships(),
        maxDrafts: typeof body.maxDrafts === "number" ? body.maxDrafts : 5,
        overrides: body.overrides || {},
        enableAiEnrichment: body.enableAiEnrichment !== false,
        aiTimeoutMs: typeof body.aiTimeoutMs === "number" ? body.aiTimeoutMs : 45000
      });

      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }

    return;
  }

  if (req.method === "POST" && req.url === "/admin/scholarships/replace") {
    try {
      const body = await parseBody(req);
      const scholarships = body.scholarships;
      const replaced = await replaceScholarships(scholarships);
      sendJson(res, 200, {
        message: `Replaced scholarships dataset with ${replaced.length} records`,
        sourceFile: getScholarshipsDataFilePath()
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/admin/scholarships/generate-form-mapping") {
    try {
      const body = await parseBody(req);
      const scholarshipId = String(body.scholarshipId || "").trim();
      if (!scholarshipId) {
        sendJson(res, 400, { error: "scholarshipId is required" });
        return;
      }

      const scholarships = await loadScholarships({ forceReload: true });
      const scholarship = scholarships.find((item) => item.id === scholarshipId);
      if (!scholarship) {
        sendJson(res, 404, { error: `Scholarship not found: ${scholarshipId}` });
        return;
      }

      if (!scholarship.sourceUrl) {
        sendJson(res, 400, { error: `Scholarship '${scholarshipId}' has no sourceUrl to map from.` });
        return;
      }

      let mapped = null;
      let mappingMode = "playwright";
      let fallbackReason = "";
      try {
        mapped = await generateFormMappingWithPlaywrightFromUrl(scholarship.sourceUrl, {
          maxSteps: typeof body.maxSteps === "number" ? body.maxSteps : 4,
          navigationTimeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : 20000
        });
      } catch (playwrightError) {
        mappingMode = "agent";
        fallbackReason = `playwright: ${playwrightError?.message || String(playwrightError)}`;
        mapped = await generateFormMappingWithAgentFromUrl(scholarship.sourceUrl, {
          fetchTimeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : 20000,
          codexTimeoutMs: typeof body.codexTimeoutMs === "number" ? body.codexTimeoutMs : 180000
        });
      }

      const genericIdPattern = /^input[_-]?\d+(\.\d+)?$/i;
      const genericCount = (mapped.formFields || []).filter((field) => {
        const label = String(field.displayLabel || field.fieldName || "").trim();
        return genericIdPattern.test(label);
      }).length;
      const totalFields = Math.max((mapped.formFields || []).length, 1);
      const genericRatio = genericCount / totalFields;
      if (mappingMode !== "playwright" && genericRatio >= 0.7) {
        throw new Error(
          `Mapping quality too low (${genericCount}/${totalFields} generic field labels). `
          + `Playwright likely failed and agent output is too ambiguous. `
          + `Restart API and retry, or map this scholarship manually. `
          + `Fallback details: ${fallbackReason || "none"}`
        );
      }

      const updated = scholarships.map((item) => (
        item.id === scholarshipId
          ? {
            ...item,
            formFields: mapped.formFields,
            formMappingMeta: {
              mode: mappingMode,
              sourceUrl: mapped.sourceUrl,
              updatedAt: new Date().toISOString(),
              fallbackReason
            },
            notes: [
              item.notes || "",
              `Form mapping generated ${new Date().toISOString()} from ${mapped.sourceUrl} (mode: ${mappingMode}${fallbackReason ? `; fallback=${fallbackReason}` : ""})`
            ].filter(Boolean).join(" | ")
          }
          : item
      ));

      await replaceScholarships(updated);
      sendJson(res, 200, {
        message: `Generated ${mapped.discoveredCount} form field mappings for ${scholarshipId} (${mappingMode})`,
        scholarshipId,
        discoveredCount: mapped.discoveredCount,
        formFields: mapped.formFields,
        sourceUrl: mapped.sourceUrl,
        mappingMode,
        fallbackReason,
        sourceFile: getScholarshipsDataFilePath()
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/admin/essay-draft") {
    try {
      const body = await parseBody(req);
      const prompt = String(body.prompt || "").trim();
      if (!prompt) {
        sendJson(res, 400, { error: "prompt is required" });
        return;
      }

      const result = await generateEssayDraftWithAgent({
        prompt,
        studentProfile: body.studentProfile || {},
        scholarshipName: body.scholarshipName || "",
        timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : 120000
      });

      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/admin/submission/start") {
    try {
      const body = await parseBody(req);
      const result = await startGuidedSubmission({
        sourceUrl: body.sourceUrl,
        payload: body.payload || {}
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/admin/submission/next") {
    try {
      const body = await parseBody(req);
      const result = await advanceGuidedSubmission({
        sessionId: body.sessionId
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/admin/submission/refill") {
    try {
      const body = await parseBody(req);
      const result = await refillGuidedSubmission({
        sessionId: body.sessionId
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/admin/submission/account-ready") {
    try {
      const body = await parseBody(req);
      const result = await resumeGuidedSubmissionAfterAccount({
        sessionId: body.sessionId
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/admin/submission/upsert-payload") {
    try {
      const body = await parseBody(req);
      const result = await upsertGuidedSubmissionPayload({
        sessionId: body.sessionId,
        updates: body.updates || {},
        refill: body.refill !== false
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/admin/submission/stop") {
    try {
      const body = await parseBody(req);
      const result = await stopGuidedSubmission({
        sessionId: body.sessionId
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/admin/candidates/import") {
    try {
      const body = await parseBody(req);
      const imported = await importCandidates(body.candidates, await loadScholarships(), {
        replacePending: body.replacePending === true
      });
      sendJson(res, 200, {
        message: `Imported ${imported.length} candidate scholarships`,
        imported,
        sourceFile: getCandidatesDataFilePath()
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/admin/candidates/review") {
    try {
      const body = await parseBody(req);
      const reviewed = await reviewCandidate({
        id: body.id,
        decision: body.decision,
        reviewer: body.reviewer || "",
        notes: body.notes || "",
        tierOverride: body.tierOverride || ""
      });

      let approvedScholarship = null;
      if (reviewed.status === "approved") {
        const existing = await loadScholarships({ forceReload: true });
        const asScholarship = candidateToScholarshipRecord(reviewed);
        const remaining = existing.filter((scholarship) => scholarship.id !== reviewed.id);
        approvedScholarship = asScholarship;
        await replaceScholarships([...remaining, asScholarship]);
      }

      sendJson(res, 200, {
        reviewed,
        approvedScholarship,
        candidatesFile: getCandidatesDataFilePath(),
        vettedScholarshipsFile: getScholarshipsDataFilePath()
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/admin/agent-discovery") {
    let tempDir = "";
    try {
      const body = await parseBody(req);
      const documents = body.documents || [];
      if (!Array.isArray(documents) || documents.length === 0) {
        sendJson(res, 400, { error: "documents must be a non-empty array" });
        return;
      }

      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-discovery-"));
      const docPaths = [];
      for (let i = 0; i < documents.length; i += 1) {
        const doc = documents[i];
        if (!doc || !doc.fileName || !doc.contentBase64) {
          throw new Error(`Document at index ${i} must include fileName and contentBase64`);
        }
        const safeName = String(doc.fileName).replace(/[^a-zA-Z0-9._-]/g, "_");
        const filePath = path.join(tempDir, `${i + 1}-${safeName}`);
        await fs.writeFile(filePath, Buffer.from(doc.contentBase64, "base64"));
        docPaths.push(filePath);
      }

      const outputPath = path.join(tempDir, "workflow-output.json");
      const pythonBin = path.resolve(process.cwd(), ".venv311/bin/python");
      const scriptPath = path.resolve(process.cwd(), "agent_orchestration/run_workflow.py");
      const apiBase = body.apiBase || `http://localhost:${port}`;

      const args = [
        scriptPath,
        "--agent-runtime",
        "codex-cli",
        "--interaction-runtime",
        "auto",
        "--api-base",
        apiBase,
        "--discovery-only",
        "--discovery-max-results",
        String(typeof body.discoveryMaxResults === "number" ? body.discoveryMaxResults : 8),
        "--discovery-query-budget",
        String(typeof body.discoveryQueryBudget === "number" ? body.discoveryQueryBudget : 6),
        "--out",
        outputPath
      ];

      if (typeof body.studentAge === "number") {
        args.push("--student-age", String(body.studentAge));
      }

      const domains = Array.isArray(body.discoveryDomains) ? body.discoveryDomains : [];
      for (const domain of domains) {
        if (domain) {
          args.push("--discovery-domain", String(domain));
        }
      }

      for (const docPath of docPaths) {
        args.push("--doc", docPath);
      }

      const proc = await runProcess(pythonBin, args, {
        cwd: process.cwd(),
        timeoutMs: typeof body.runTimeoutMs === "number" ? body.runTimeoutMs : 10 * 60 * 1000,
        env: {
          CODEX_CLI_TIMEOUT_SEC: String(typeof body.codexTimeoutSec === "number" ? body.codexTimeoutSec : 240),
          CODEX_CLI_ENABLE_SEARCH: "1",
          CODEX_CLI_VERBOSE: "1"
        }
      });

      if (proc.code !== 0) {
        sendJson(res, 500, {
          error: "Agent discovery process failed",
          exitCode: proc.code,
          stdoutTail: tailText(proc.stdout),
          stderrTail: tailText(proc.stderr)
        });
        return;
      }

      let outputPayload = {};
      try {
        const rawOut = await fs.readFile(outputPath, "utf8");
        outputPayload = JSON.parse(rawOut);
      } catch {
        outputPayload = {};
      }

      sendJson(res, 200, {
        message: "Agent discovery completed",
        summary: outputPayload.summary || null,
        state: outputPayload.state || null,
        stdoutTail: tailText(proc.stdout),
        stderrTail: tailText(proc.stderr)
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    } finally {
      if (tempDir) {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    }
    return;
  }

  sendJson(res, 404, { error: "Not found" });
});

const port = Number(process.env.PORT || 3000);
server.listen(port, () => {
  process.stdout.write(`Scholarship bot API listening on http://localhost:${port}\n`);
});
