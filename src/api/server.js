import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { loadLocalEnv } from "../config/loadEnv.js";
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
  markCandidateSubmitted,
  reviewCandidate
} from "../data/candidateStore.js";
import {
  importCandidatesToSupabase,
  loadCandidatesFromSupabase,
  markCandidateSubmittedInSupabase,
  reviewCandidateInSupabase
} from "../data/candidateStoreSupabase.js";
import {
  startGuidedSubmission,
  advanceGuidedSubmission,
  refillGuidedSubmission,
  resumeGuidedSubmissionAfterAccount,
  upsertGuidedSubmissionPayload,
  stopGuidedSubmission
} from "../submission/guidedSubmitter.js";
import {
  getSupabaseAdminClient,
  getSupabaseConfig,
  getSupabasePublicClient,
  getSupabaseStatus
} from "../integrations/supabaseClient.js";
import { discoverScholarshipCandidates } from "../discovery/discoveryService.js";
import { processSessionDocuments } from "../pipeline/processSessionDocuments.js";

loadLocalEnv();

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

const DISCOVERY_LOG_FILE_PATH = path.resolve(process.cwd(), "data/discovery-runs.log.jsonl");

function getDiscoveryLogFilePath() {
  return DISCOVERY_LOG_FILE_PATH;
}

function determineNoNewCandidatesReason({
  discoveredByAgent,
  importedCount,
  pendingCount,
  fetchedPages = 0,
  historySkippedPages = 0
}) {
  if (importedCount === null && discoveredByAgent === null) {
    return "unknown_no_import_signal";
  }
  if ((importedCount || 0) > 0) {
    return "";
  }
  if ((discoveredByAgent || 0) === 0 && (fetchedPages || 0) === 0 && (historySkippedPages || 0) > 0) {
    return "all_search_results_skipped_by_recent_history";
  }
  if ((discoveredByAgent || 0) === 0) {
    return "agent_returned_zero_candidates";
  }
  if ((discoveredByAgent || 0) > 0 && (importedCount || 0) === 0) {
    return "all_discovered_candidates_skipped_or_deduped";
  }
  if ((pendingCount || 0) === 0) {
    return "no_pending_candidates_after_import";
  }
  return "unknown_no_new_candidates";
}

const DEFAULT_DISCOVERY_QUERY_BUDGET = 12;

async function appendDiscoveryRunLog(entry) {
  const line = `${JSON.stringify(entry)}\n`;
  await fs.mkdir(path.dirname(DISCOVERY_LOG_FILE_PATH), { recursive: true });
  await fs.appendFile(DISCOVERY_LOG_FILE_PATH, line, "utf8");
}

async function readDiscoveryRunLogs(limit = 30) {
  try {
    const raw = await fs.readFile(DISCOVERY_LOG_FILE_PATH, "utf8");
    const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
    const parsed = [];
    for (let index = lines.length - 1; index >= 0 && parsed.length < limit; index -= 1) {
      try {
        parsed.push(JSON.parse(lines[index]));
      } catch {
        // Skip malformed lines.
      }
    }
    return parsed;
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function normalizeUploadedDocuments(documents = []) {
  if (!Array.isArray(documents) || documents.length === 0) {
    throw new Error("documents must be a non-empty array");
  }

  return documents.map((doc, index) => {
    if (!doc || !doc.fileName || !doc.contentBase64) {
      throw new Error(`Document at index ${index} must include fileName and contentBase64`);
    }

    return {
      documentId: doc.documentId || `doc-${index + 1}`,
      fileName: doc.fileName,
      fileBuffer: Buffer.from(doc.contentBase64, "base64")
    };
  });
}

let runtimeDevUserId = String(process.env.SUPABASE_DEV_USER_ID || "").trim();

function parseBearerToken(req) {
  const raw = String(req.headers.authorization || "").trim();
  if (!raw) {
    return "";
  }

  const match = raw.match(/^Bearer\s+(.+)$/i);
  return String(match?.[1] || "").trim();
}

async function resolveUserContext(req) {
  const token = parseBearerToken(req);
  const headerUserId = String(req.headers["x-user-id"] || "").trim();
  const envUserId = String(process.env.SUPABASE_DEV_USER_ID || "").trim();
  const fallbackUserId = runtimeDevUserId || envUserId || "";

  if (token) {
    const adminClient = getSupabaseAdminClient();
    if (adminClient) {
      const { data, error } = await adminClient.auth.getUser(token);
      if (!error && data?.user?.id) {
        return {
          userId: data.user.id,
          email: data.user.email || "",
          source: "bearer-token",
          tokenProvided: true,
          tokenValid: true,
          tokenError: ""
        };
      }
      return {
        userId: "",
        email: "",
        source: "invalid-token",
        tokenProvided: true,
        tokenValid: false,
        tokenError: error?.message || "Token verification failed"
      };
    }

    return {
      userId: "",
      email: "",
      source: "invalid-token",
      tokenProvided: true,
      tokenValid: false,
      tokenError: "Supabase admin client unavailable for token verification"
    };
  }

  if (headerUserId) {
    return {
      userId: headerUserId,
      email: "",
      source: "x-user-id",
      tokenProvided: false,
      tokenValid: false,
      tokenError: ""
    };
  }

  if (fallbackUserId) {
    return {
      userId: fallbackUserId,
      email: "",
      source: "dev-fallback",
      tokenProvided: false,
      tokenValid: false,
      tokenError: ""
    };
  }

  return {
    userId: "",
    email: "",
    source: "none",
    tokenProvided: false,
    tokenValid: false,
    tokenError: ""
  };
}

async function shouldUseSupabaseCandidateStore(req) {
  const config = getSupabaseConfig();
  const user = await resolveUserContext(req);
  return {
    enabled: Boolean(config.configured && user.userId),
    userId: user.userId,
    user
  };
}

async function findSupabaseUserByEmail(adminClient, email) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!normalizedEmail) {
    return null;
  }

  let page = 1;
  const perPage = 200;
  while (page <= 20) {
    const { data, error } = await adminClient.auth.admin.listUsers({ page, perPage });
    if (error) {
      throw new Error(`Unable to list users: ${error.message}`);
    }

    const users = Array.isArray(data?.users) ? data.users : [];
    const match = users.find((user) => String(user.email || "").toLowerCase() === normalizedEmail);
    if (match) {
      return match;
    }

    if (users.length < perPage) {
      break;
    }
    page += 1;
  }

  return null;
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

  if (req.method === "POST" && req.url === "/auth/signup") {
    try {
      const body = await parseBody(req);
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      if (!email || !password) {
        sendJson(res, 400, { error: "email and password are required" });
        return;
      }

      const publicClient = getSupabasePublicClient();
      if (!publicClient) {
        sendJson(res, 400, { error: "Supabase publishable key is not configured" });
        return;
      }

      const { data, error } = await publicClient.auth.signUp({ email, password });
      if (error) {
        sendJson(res, 400, { error: error.message });
        return;
      }

      sendJson(res, 200, {
        message: "Signup request submitted",
        userId: data?.user?.id || null,
        email: data?.user?.email || email,
        emailConfirmationRequired: !data?.session,
        accessToken: data?.session?.access_token || null,
        refreshToken: data?.session?.refresh_token || null,
        expiresIn: data?.session?.expires_in || null
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/auth/signin") {
    try {
      const body = await parseBody(req);
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      if (!email || !password) {
        sendJson(res, 400, { error: "email and password are required" });
        return;
      }

      const publicClient = getSupabasePublicClient();
      if (!publicClient) {
        sendJson(res, 400, { error: "Supabase publishable key is not configured" });
        return;
      }

      const { data, error } = await publicClient.auth.signInWithPassword({ email, password });
      if (error) {
        sendJson(res, 400, { error: error.message });
        return;
      }

      sendJson(res, 200, {
        message: "Signed in",
        userId: data?.user?.id || null,
        email: data?.user?.email || email,
        accessToken: data?.session?.access_token || null,
        refreshToken: data?.session?.refresh_token || null,
        expiresIn: data?.session?.expires_in || null
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "GET" && req.url === "/auth/me") {
    const token = parseBearerToken(req);
    if (!token) {
      sendJson(res, 401, { error: "Missing bearer token" });
      return;
    }

    const adminClient = getSupabaseAdminClient();
    if (!adminClient) {
      sendJson(res, 400, { error: "Supabase admin client not configured" });
      return;
    }

    const { data, error } = await adminClient.auth.getUser(token);
    if (error || !data?.user?.id) {
      sendJson(res, 401, { error: error?.message || "Invalid token" });
      return;
    }

    sendJson(res, 200, {
      user: {
        id: data.user.id,
        email: data.user.email || null
      }
    });
    return;
  }

  if (req.method === "POST" && req.url === "/admin/dev/auth/bootstrap") {
    try {
      const body = await parseBody(req);
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "").trim() || "DevPassword123!";
      if (!email) {
        sendJson(res, 400, { error: "email is required" });
        return;
      }

      const adminClient = getSupabaseAdminClient();
      if (!adminClient) {
        sendJson(res, 400, { error: "Supabase admin key is not configured" });
        return;
      }

      let user = await findSupabaseUserByEmail(adminClient, email);
      let created = false;
      if (!user) {
        const { data, error } = await adminClient.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
          user_metadata: {
            scholarshipBotDevBootstrap: true
          }
        });

        if (error) {
          sendJson(res, 400, { error: error.message });
          return;
        }

        user = data?.user || null;
        created = true;
      }

      if (!user?.id) {
        sendJson(res, 500, { error: "Unable to create or resolve dev user" });
        return;
      }

      runtimeDevUserId = String(user.id);

      const publicClient = getSupabasePublicClient();
      let accessToken = null;
      let refreshToken = null;
      let signInError = "";
      if (publicClient) {
        const signIn = await publicClient.auth.signInWithPassword({
          email,
          password
        });
        if (signIn.error) {
          signInError = signIn.error.message || "Unable to sign in with provided password";
        } else {
          accessToken = signIn.data?.session?.access_token || null;
          refreshToken = signIn.data?.session?.refresh_token || null;
        }
      }

      sendJson(res, 200, {
        message: created ? "Created new dev user" : "Using existing dev user",
        userId: user.id,
        email: user.email || email,
        created,
        accessToken,
        refreshToken,
        signInError: signInError || null,
        activeUserSource: "runtime-dev"
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    const supabase = await getSupabaseStatus();
    sendJson(res, 200, {
      ok: true,
      supabase: {
        configured: supabase.configured,
        connected: supabase.connected,
        reason: supabase.reason
      }
    });
    return;
  }

  if (req.method === "GET" && req.url === "/admin/supabase/status") {
    const supabase = await getSupabaseStatus();
    const user = await resolveUserContext(req);
    sendJson(res, 200, {
      supabase: {
        ...supabase,
        candidateStoreMode: supabase.configured && user.userId ? "supabase" : "local-fallback",
        activeUserId: user.userId || null,
        activeUserSource: user.source,
        tokenProvided: user.tokenProvided,
        tokenValid: user.tokenValid,
        tokenError: user.tokenError || null
      }
    });
    return;
  }

  if (req.method === "GET" && req.url.startsWith("/admin/logs/discovery")) {
    try {
      const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const requestedLimit = Number(requestUrl.searchParams.get("limit") || 30);
      const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : 30, 1), 200);
      const logs = await readDiscoveryRunLogs(limit);
      sendJson(res, 200, {
        logs,
        sourceFile: getDiscoveryLogFilePath(),
        count: logs.length
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
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
    const supabaseRoute = await shouldUseSupabaseCandidateStore(req);
    if (supabaseRoute.enabled) {
      try {
        const candidates = await loadCandidatesFromSupabase(supabaseRoute.userId);
        sendJson(res, 200, {
          candidates,
          sourceFile: `supabase:user_scholarships (user_id=${supabaseRoute.userId})`
        });
        return;
      } catch (error) {
        sendJson(res, 200, {
          candidates: await loadCandidates({ forceReload: true }),
          sourceFile: `${getCandidatesDataFilePath()} (fallback: ${error.message})`
        });
        return;
      }
    }

    sendJson(res, 200, {
      candidates: await loadCandidates({ forceReload: true }),
      sourceFile: getCandidatesDataFilePath()
    });
    return;
  }

  if (req.method === "POST" && req.url === "/run-no-account-mvp") {
    try {
      const body = await parseBody(req);
      const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const documents = body.documents || [];

      if (!Array.isArray(documents) || documents.length === 0) {
        sendJson(res, 400, { error: "documents must be a non-empty array" });
        return;
      }

      const result = await runNoAccountMvp({
        sessionId,
        documents,
        scholarships: await loadScholarships(),
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
      const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const normalizedDocuments = normalizeUploadedDocuments(body.documents || []);

      const result = await runNoAccountMvp({
        sessionId,
        documents: normalizedDocuments,
        scholarships: await loadScholarships(),
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

  if (req.method === "POST" && req.url === "/admin/profile-from-upload") {
    try {
      const body = await parseBody(req);
      const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const normalizedDocuments = normalizeUploadedDocuments(body.documents || []);
      const result = await processSessionDocuments({
        sessionId,
        documents: normalizedDocuments,
        enableAiEnrichment: body.enableAiEnrichment !== false,
        aiTimeoutMs: typeof body.aiTimeoutMs === "number" ? body.aiTimeoutMs : 45000
      });

      sendJson(res, 200, {
        sessionId: result.sessionId,
        mergedProfile: result.mergedProfile,
        aiEnrichment: result.aiEnrichment,
        documentCount: Array.isArray(result.documents) ? result.documents.length : normalizedDocuments.length
      });
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
      const supabaseRoute = await shouldUseSupabaseCandidateStore(req);
      if (supabaseRoute.enabled) {
        const imported = await importCandidatesToSupabase(
          supabaseRoute.userId,
          body.candidates,
          await loadScholarships(),
          { replacePending: body.replacePending === true }
        );
        sendJson(res, 200, {
          message: `Imported ${imported.length} candidate scholarships`,
          imported,
          sourceFile: `supabase:user_scholarships (user_id=${supabaseRoute.userId})`
        });
        return;
      }

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
      const supabaseRoute = await shouldUseSupabaseCandidateStore(req);
      const reviewed = supabaseRoute.enabled
        ? await reviewCandidateInSupabase({
          userId: supabaseRoute.userId,
          scholarshipId: String(body.id || ""),
          decision: body.decision,
          reviewer: body.reviewer || "",
          notes: body.notes || "",
          tierOverride: body.tierOverride || ""
        })
        : await reviewCandidate({
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
        candidatesFile: supabaseRoute.enabled
          ? `supabase:user_scholarships (user_id=${supabaseRoute.userId})`
          : getCandidatesDataFilePath(),
        vettedScholarshipsFile: getScholarshipsDataFilePath()
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/admin/candidates/mark-submitted") {
    try {
      const body = await parseBody(req);
      const supabaseRoute = await shouldUseSupabaseCandidateStore(req);
      const updated = supabaseRoute.enabled
        ? await markCandidateSubmittedInSupabase({
          userId: supabaseRoute.userId,
          scholarshipId: String(body.id || ""),
          reviewer: body.reviewer || "",
          notes: body.notes || ""
        })
        : await markCandidateSubmitted({
          id: String(body.id || ""),
          reviewer: body.reviewer || "",
          notes: body.notes || ""
        });

      sendJson(res, 200, {
        candidate: updated,
        candidatesFile: supabaseRoute.enabled
          ? `supabase:user_scholarships (user_id=${supabaseRoute.userId})`
          : getCandidatesDataFilePath()
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/admin/agent-discovery") {
    const runId = `discovery-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let baseLogContext = {
      runId,
      timestamp: new Date().toISOString(),
      mode: "unknown",
      userStore: "unknown",
      userId: null,
      userSource: "none",
      request: {
        studentStage: "",
        discoveryMaxResults: 8,
        discoveryQueryBudget: DEFAULT_DISCOVERY_QUERY_BUDGET,
        discoveryDomains: []
      }
    };
    try {
      const body = await parseBody(req);
      const useCached = body.useCached !== false;
      const supabaseRoute = await shouldUseSupabaseCandidateStore(req);
      baseLogContext = {
        runId,
        timestamp: new Date().toISOString(),
        mode: useCached ? "cached" : "fresh",
        userStore: supabaseRoute.enabled ? "supabase" : "local-fallback",
        userId: supabaseRoute.userId || null,
        userSource: supabaseRoute.user?.source || "none",
        request: {
          studentStage: String(body.studentStage || ""),
          discoveryMaxResults: typeof body.discoveryMaxResults === "number" ? body.discoveryMaxResults : 8,
          discoveryQueryBudget: typeof body.discoveryQueryBudget === "number" ? body.discoveryQueryBudget : DEFAULT_DISCOVERY_QUERY_BUDGET,
          discoveryDomains: Array.isArray(body.discoveryDomains) ? body.discoveryDomains.filter(Boolean) : [],
          manualRerun: body.manualRerun === true
        }
      };

      if (useCached) {
        const cachedCandidates = supabaseRoute.enabled
          ? await loadCandidatesFromSupabase(supabaseRoute.userId)
          : await loadCandidates({ forceReload: true });
        const pending = cachedCandidates.filter((c) => c.status === "pending");
        const approved = cachedCandidates.filter((c) => c.status === "approved");
        await appendDiscoveryRunLog({
          ...baseLogContext,
          status: "ok",
          reason: "cached_mode_reused_existing_queue",
          counts: {
            discoveredByAgent: null,
            importedCount: null,
            pendingCount: pending.length,
            approvedCount: approved.length
          }
        });
        sendJson(res, 200, {
          message: "Agent discovery reused cached candidates (no new search run)",
          summary: {
            featureId: "cached-discovery",
            student: {
              name: null,
              major: null,
              ethnicity: null,
              state: null,
              stage: body.studentStage || null,
              age: null
            },
            counts: {
              discoveredCandidates: pending.length,
              shortlistedCandidates: 0,
              approvedIds: approved.length,
              autofillPlans: 0
            },
            discoveryOnly: true,
            approvedIds: approved.map((c) => c.id),
            shortlistPreview: pending.slice(0, 10).map((c) => ({
              id: c.id,
              name: c.name,
              awardAmount: c.awardAmount,
              deadline: c.deadline,
              sourceDomain: c.sourceDomain
            }))
          },
          state: null,
          stdoutTail: supabaseRoute.enabled
            ? `Cached mode: returned existing candidate queue from supabase for user ${supabaseRoute.userId}`
            : "Cached mode: returned existing candidate queue from data/scholarships.candidates.json",
          stderrTail: ""
        });
        return;
      }

      let normalizedDocuments = [];
      try {
        normalizedDocuments = normalizeUploadedDocuments(body.documents || []);
      } catch (error) {
        await appendDiscoveryRunLog({
          ...baseLogContext,
          status: "error",
          reason: "missing_documents",
          error: error.message || "documents must be a non-empty array"
        });
        sendJson(res, 400, { error: error.message || "documents must be a non-empty array" });
        return;
      }

      const studentStage = String(body.studentStage || "").trim();
      const discoveryMaxResults = typeof body.discoveryMaxResults === "number" ? body.discoveryMaxResults : 8;
      const discoveryQueryBudget = typeof body.discoveryQueryBudget === "number" ? body.discoveryQueryBudget : DEFAULT_DISCOVERY_QUERY_BUDGET;
      const discoveryDomains = Array.isArray(body.discoveryDomains) ? body.discoveryDomains.filter(Boolean) : [];
      const sessionId = `feature-discovery-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      let existingCandidatesForFeedback = [];
      try {
        existingCandidatesForFeedback = supabaseRoute.enabled
          ? await loadCandidatesFromSupabase(supabaseRoute.userId)
          : await loadCandidates({ forceReload: true });
      } catch {
        existingCandidatesForFeedback = [];
      }

      const discovery = await discoverScholarshipCandidates({
        sessionId,
        documents: normalizedDocuments,
        existingCandidates: existingCandidatesForFeedback,
        studentStage,
        discoveryMaxResults,
        discoveryQueryBudget,
        discoveryDomains,
        manualRerun: body.manualRerun === true,
        searchTimeoutMs: typeof body.searchTimeoutMs === "number" ? body.searchTimeoutMs : 10000,
        pageTimeoutMs: typeof body.pageTimeoutMs === "number" ? body.pageTimeoutMs : 12000,
        pageRetries: typeof body.pageRetries === "number" ? body.pageRetries : 1,
        aiTimeoutMs: typeof body.codexTimeoutSec === "number" ? body.codexTimeoutSec * 1000 : 45000
      });

      const discoveredCandidates = discovery.candidates.map((item) => item.candidate);
      const imported = supabaseRoute.enabled
        ? await importCandidatesToSupabase(
          supabaseRoute.userId,
          discoveredCandidates,
          await loadScholarships(),
          { replacePending: true }
        )
        : await importCandidates(discoveredCandidates, await loadScholarships(), {
          replacePending: true
        });

      let queueCandidates = [];
      try {
        queueCandidates = supabaseRoute.enabled
          ? await loadCandidatesFromSupabase(supabaseRoute.userId)
          : await loadCandidates({ forceReload: true });
      } catch {
        queueCandidates = [];
      }
      const pendingCount = queueCandidates.filter((c) => c.status === "pending").length;
      const approvedCount = queueCandidates.filter((c) => c.status === "approved").length;
      const discoveredByAgent = discoveredCandidates.length;
      const importedCount = imported.length;
      const noNewCandidatesReason = determineNoNewCandidatesReason({
        discoveredByAgent,
        importedCount,
        pendingCount,
        fetchedPages: discovery.diagnostics.fetchedPages,
        historySkippedPages: discovery.diagnostics.historySkippedPages
      });
      const personal = discovery.mergedProfile?.personalInfo || {};
      const summary = {
        featureId: sessionId,
        student: {
          name: personal.fullName || null,
          major: personal.intendedMajor || null,
          ethnicity: personal.ethnicity || null,
          state: personal.state || null,
          stage: studentStage || null,
          age: personal.age || null
        },
        counts: {
          discoveredCandidates: discoveredByAgent,
          importedCandidates: importedCount,
          shortlistedCandidates: 0,
          approvedIds: approvedCount,
          autofillPlans: 0,
          fetchedPages: discovery.diagnostics.fetchedPages,
          searchResults: discovery.diagnostics.searchResults
        },
        discoveryOnly: true,
        approvedIds: queueCandidates.filter((c) => c.status === "approved").map((c) => c.id),
        discoveryErrors: discovery.errors,
        shortlistPreview: discovery.candidates.slice(0, 10).map((item) => ({
          id: item.candidate.sourceUrl || `${item.candidate.name}-${item.candidate.sourceDomain}`,
          name: item.candidate.name,
          awardAmount: item.candidate.awardAmount,
          deadline: item.candidate.deadline,
          sourceDomain: item.candidate.sourceDomain
        }))
      };
      const stdoutTail = tailText([
        `Session: ${sessionId}`,
        `Queries: ${discovery.queries.join(" | ")}`,
        ...discovery.logs
      ].join("\n"), 200);
      const stderrTail = tailText(discovery.errors.join("\n"));

      await appendDiscoveryRunLog({
        ...baseLogContext,
        status: "ok",
        reason: noNewCandidatesReason || "imported_new_candidates",
        counts: {
          discoveredByAgent,
          importedCount,
          pendingCount,
          approvedCount
        },
        workflowSummary: summary,
        stdoutTail,
        stderrTail
      });

      sendJson(res, 200, {
        message: "Deterministic discovery completed",
        summary,
        state: null,
        stdoutTail,
        stderrTail
      });
    } catch (error) {
      await appendDiscoveryRunLog({
        ...baseLogContext,
        status: "error",
        reason: "request_validation_or_runtime_error",
        error: error.message || String(error)
      });
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  sendJson(res, 404, { error: "Not found" });
});

const port = Number(process.env.PORT || 3000);
server.listen(port, () => {
  process.stdout.write(`Scholarship bot API listening on http://localhost:${port}\n`);
  getSupabaseStatus()
    .then((status) => {
      const line = status.configured
        ? `[supabase] configured=${status.configured} connected=${status.connected} (${status.reason})\n`
        : "[supabase] not configured (set SUPABASE_URL + SUPABASE_SECRET_KEY/SUPABASE_SERVICE_ROLE_KEY)\n";
      process.stdout.write(line);
    })
    .catch(() => {
      process.stdout.write("[supabase] status check failed during startup\n");
    });
});
