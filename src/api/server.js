import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { loadLocalEnv } from "../config/loadEnv.js";
import { runNoAccountMvp } from "../pipeline/runNoAccountMvp.js";
import { generateFormMappingWithPlaywrightFromUrl } from "../autofill/playwrightFormMapper.js";
import { generateFormMappingWithAgentFromUrl } from "../autofill/agentFormMapper.js";
import { generateEssayDraftWithAgent } from "../autofill/essayDraftAgent.js";
import {
  candidateToScholarshipRecord,
  getCandidatesDataFilePath,
  importCandidates,
  loadCandidates,
  markCandidateSubmitted,
  reviewCandidate,
  updateCandidateById
} from "../data/candidateStore.js";
import {
  importCandidatesToSupabase,
  loadCandidatesFromSupabase,
  markCandidateAsUserSuggestedInSupabase,
  refreshCandidateMetadataInSupabase,
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

function candidatesToCanonicalScholarships(candidates = []) {
  const rows = Array.isArray(candidates) ? candidates : [];
  const seen = new Set();
  const output = [];
  for (const candidate of rows) {
    if (!candidate || candidate.status === "rejected") continue;
    const asScholarship = candidateToScholarshipRecord(candidate);
    const keys = [
      String(asScholarship.id || "").toLowerCase(),
      String(asScholarship.sourceUrl || "").toLowerCase(),
      `${String(asScholarship.name || "").toLowerCase()}::${String(asScholarship.sourceDomain || "").toLowerCase()}`
    ].filter(Boolean);
    if (keys.some((key) => seen.has(key))) continue;
    keys.forEach((key) => seen.add(key));
    output.push(asScholarship);
  }
  return output;
}

function stripHtmlTags(value) {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function toTitleCase(value) {
  return String(value || "")
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ")
    .trim();
}

function extractMetaTags(html = "") {
  const tags = [];
  const re = /<meta\b[^>]*>/gi;
  let match = re.exec(String(html || ""));
  while (match) {
    tags.push(String(match[0] || ""));
    match = re.exec(String(html || ""));
  }
  return tags;
}

function extractMetaAttr(tag, attrName) {
  const name = String(attrName || "").toLowerCase();
  const re = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const match = String(tag || "").match(re);
  return String(match?.[2] ?? match?.[3] ?? match?.[4] ?? "").trim();
}

function parseHtmlTitle(html = "") {
  const tags = extractMetaTags(html);
  for (const tag of tags) {
    const property = extractMetaAttr(tag, "property").toLowerCase();
    const name = extractMetaAttr(tag, "name").toLowerCase();
    const content = extractMetaAttr(tag, "content");
    if (!content) continue;
    if (property === "og:title" || property === "twitter:title" || name === "title" || name === "og:title" || name === "twitter:title") {
      return stripHtmlTags(content);
    }
  }

  const titleTag = String(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").trim();
  if (titleTag) return stripHtmlTags(titleTag);

  const h1 = String(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || "").trim();
  if (h1) return stripHtmlTags(h1);

  return "";
}

function parseDeadlineFromText(text = "") {
  const value = String(text || "");
  if (!value) return "";

  const withKeyword = value.match(
    /\b(?:deadline|apply by|applications? due|due date|submission deadline)\b[^A-Za-z0-9]{0,20}([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{4}-\d{2}-\d{2})/i
  );
  if (withKeyword?.[1]) {
    return String(withKeyword[1]).trim();
  }

  const generic = value.match(/\b([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{4}-\d{2}-\d{2})\b/);
  return String(generic?.[1] || "").trim();
}

function parseAwardAmountFromText(text = "") {
  const value = String(text || "");
  if (!value) return 0;

  const keywordFirst = value.match(/\b(?:award|scholarship|amount|prize|winner(?:s)?)\b[\s\S]{0,60}?\$\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{3,7})/i);
  const candidate = keywordFirst?.[1]
    || value.match(/\$\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,7})/)?.[1]
    || "";
  const numeric = Number(String(candidate || "").replace(/,/g, ""));
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  if (numeric > 1000000) return 0;
  return Math.round(numeric);
}

async function fetchScholarshipMetadata(sourceUrl, timeoutMs = 12000) {
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetch(sourceUrl, {
      method: "GET",
      headers: {
        "user-agent": "ScholarshipBot/0.1 (+candidate-suggest)",
        accept: "text/html,application/xhtml+xml"
      },
      signal: controller?.signal
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const html = await response.text();
    const title = parseHtmlTitle(html);
    const text = stripHtmlTags(html).slice(0, 120000);
    const deadline = parseDeadlineFromText(text);
    const awardAmount = parseAwardAmountFromText(text);
    return {
      title,
      deadline,
      awardAmount
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function deriveNameFromUrlPath(sourceUrl) {
  let parsed;
  try {
    parsed = new URL(String(sourceUrl || ""));
  } catch {
    return "";
  }
  const pieces = String(parsed.pathname || "")
    .split("/")
    .map((part) => decodeURIComponent(part))
    .map((part) => part.replace(/\.[a-z0-9]+$/i, "").trim())
    .filter(Boolean);
  const last = String(pieces[pieces.length - 1] || "").trim();
  if (!last) return "";
  const cleaned = last
    .replace(/[-_+]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  return toTitleCase(cleaned);
}

function normalizeSuggestedScholarship(body = {}) {
  const sourceUrlRaw = String(body.sourceUrl || body.url || "").trim();
  if (!sourceUrlRaw) {
    throw new Error("sourceUrl is required");
  }

  let parsed;
  try {
    parsed = new URL(sourceUrlRaw);
  } catch {
    throw new Error("sourceUrl must be a valid absolute URL");
  }

  if (!/^https?:$/i.test(parsed.protocol)) {
    throw new Error("sourceUrl must start with http:// or https://");
  }

  const sourceDomain = String(parsed.hostname || "")
    .trim()
    .toLowerCase()
    .replace(/^www\./, "");
  if (!sourceDomain) {
    throw new Error("Unable to infer sourceDomain from sourceUrl");
  }

  const preferredName = String(body.name || "").trim();
  const pathName = deriveNameFromUrlPath(parsed.toString());
  const domainName = `${sourceDomain.replace(/\.[a-z]{2,}$/i, "").replace(/[.\-_]+/g, " ").trim()} scholarship`
    .replace(/\s+/g, " ")
    .trim();
  const fallbackName = pathName || toTitleCase(domainName);
  const name = preferredName || fallbackName || `Scholarship from ${sourceDomain}`;

  const requiresAccount = body.requiresAccount === true;
  const awardAmountRaw = Number(body.awardAmount || 0);
  const awardAmount = Number.isFinite(awardAmountRaw) && awardAmountRaw > 0 ? awardAmountRaw : 0;
  const deadline = String(body.deadline || "").trim();
  const notes = String(body.notes || "").trim();

  return {
    name,
    userProvidedName: Boolean(preferredName),
    userSuggested: true,
    sourceDomain,
    sourceUrl: parsed.toString(),
    sourceName: sourceDomain,
    requiresAccount,
    awardAmount,
    deadline,
    estimatedEffortMinutes: 30,
    eligibility: {
      minGpa: null,
      allowedMajors: [],
      allowedEthnicities: []
    },
    inferredRequirements: {
      requiredMajors: [],
      requiredEthnicities: [],
      requiredStates: [],
      minAge: null,
      maxAge: null,
      requirementStatements: []
    },
    essayPrompts: [],
    formFields: [],
    notes
  };
}

async function enrichSuggestedScholarshipMetadata(candidate, { timeoutMs = 12000, silent = true } = {}) {
  const base = candidate && typeof candidate === "object" ? { ...candidate } : null;
  if (!base?.sourceUrl) return base;
  try {
    const metadata = await fetchScholarshipMetadata(base.sourceUrl, timeoutMs);
    if (metadata.title && !base.userProvidedName) {
      base.name = metadata.title;
    }
    if (!base.deadline && metadata.deadline) {
      base.deadline = metadata.deadline;
    }
    if (!Number(base.awardAmount) && Number(metadata.awardAmount || 0) > 0) {
      base.awardAmount = Number(metadata.awardAmount);
    }
    return base;
  } catch (error) {
    if (!silent) {
      throw error;
    }
    return base;
  }
}

function isLikelyDomainDerivedTitle(name = "", sourceDomain = "") {
  const normalizedName = String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const normalizedDomain = String(sourceDomain || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!normalizedName || !normalizedDomain) return false;
  return normalizedName.startsWith(normalizedDomain) && normalizedName.endsWith("scholarship");
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

function buildDiscoveryResponseMessage(reason, counts = {}) {
  const discovered = Number(counts.discoveredByAgent || 0);
  const imported = Number(counts.importedCount || 0);

  if (!reason) {
    return `Discovery completed. Added ${imported} new scholarship${imported === 1 ? "" : "s"}.`;
  }
  if (reason === "all_discovered_candidates_skipped_or_deduped") {
    return `Discovery found ${discovered} scholarship${discovered === 1 ? "" : "s"}, but they were already in your saved reviewed history.`;
  }
  if (reason === "all_search_results_skipped_by_recent_history") {
    return "Discovery searched again, but the frontier was dominated by very recent URLs from prior runs.";
  }
  if (reason === "agent_returned_zero_candidates") {
    return "Discovery searched the web but did not find any new scholarship candidates that survived filtering.";
  }
  if (reason === "no_pending_candidates_after_import") {
    return "Discovery completed, but there are no pending scholarships left after import.";
  }
  return "Deterministic discovery completed.";
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

async function getCanonicalScholarshipsForRequest(req, { forceReload = true } = {}) {
  const supabaseRoute = await shouldUseSupabaseCandidateStore(req);
  if (supabaseRoute.enabled) {
    const candidates = await loadCandidatesFromSupabase(supabaseRoute.userId);
    return {
      scholarships: candidatesToCanonicalScholarships(candidates),
      sourceFile: `supabase:user_scholarships (user_id=${supabaseRoute.userId})`,
      supabaseRoute
    };
  }

  const candidates = await loadCandidates({ forceReload });
  return {
    scholarships: candidatesToCanonicalScholarships(candidates),
    sourceFile: getCandidatesDataFilePath(),
    supabaseRoute
  };
}

async function persistScholarshipFormMappingForRequest(req, scholarship, mapped, { mappingMode = "playwright", fallbackReason = "" } = {}) {
  const supabaseRoute = await shouldUseSupabaseCandidateStore(req);
  const nowIso = new Date().toISOString();
  const formMappingMeta = {
    mode: mappingMode,
    sourceUrl: mapped.sourceUrl,
    updatedAt: nowIso,
    fallbackReason
  };

  if (supabaseRoute.enabled) {
    const client = getSupabaseAdminClient();
    if (!client) {
      throw new Error("Supabase is not configured");
    }
    const scholarshipId = String(scholarship.id || "").trim();
    if (!scholarshipId) {
      throw new Error("Scholarship id is required for Supabase mapping updates");
    }

    const { data: existingRows, error: existingError } = await client
      .from("scholarships")
      .select("id, metadata")
      .eq("id", scholarshipId)
      .limit(1);
    if (existingError) {
      throw new Error(`Supabase scholarship read failed: ${existingError.message}`);
    }
    const existing = Array.isArray(existingRows) ? existingRows[0] : null;
    if (!existing?.id) {
      throw new Error(`Supabase scholarship not found for id: ${scholarshipId}`);
    }
    const metadata = existing.metadata && typeof existing.metadata === "object" ? existing.metadata : {};
    const mergedMetadata = {
      ...metadata,
      formFields: Array.isArray(mapped.formFields) ? mapped.formFields : [],
      formMappingMeta,
      notes: [
        String(metadata.notes || "").trim(),
        `Form mapping generated ${nowIso} from ${mapped.sourceUrl} (mode: ${mappingMode}${fallbackReason ? `; fallback=${fallbackReason}` : ""})`
      ].filter(Boolean).join(" | ")
    };
    const { error: updateError } = await client
      .from("scholarships")
      .update({ metadata: mergedMetadata })
      .eq("id", scholarshipId);
    if (updateError) {
      throw new Error(`Supabase scholarship update failed: ${updateError.message}`);
    }
    return { sourceFile: `supabase:scholarships (id=${scholarshipId})` };
  }

  const scholarshipId = String(scholarship.id || "").trim();
  const updated = await updateCandidateById({
    id: scholarshipId,
    updates: {
      formFields: Array.isArray(mapped.formFields) ? mapped.formFields : [],
      formMappingMeta,
      reviewNotes: [
        String(scholarship.reviewNotes || "").trim(),
        `Form mapping generated ${nowIso} from ${mapped.sourceUrl} (mode: ${mappingMode}${fallbackReason ? `; fallback=${fallbackReason}` : ""})`
      ].filter(Boolean).join(" | ")
    }
  });
  return { sourceFile: `${getCandidatesDataFilePath()} (updated candidate ${updated.id})` };
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
    const canonical = await getCanonicalScholarshipsForRequest(req, { forceReload: true });
    sendJson(res, 200, {
      scholarships: canonical.scholarships,
      sourceFile: canonical.sourceFile
    });
    return;
  }

  if (req.method === "GET" && req.url === "/admin/scholarships") {
    const canonical = await getCanonicalScholarshipsForRequest(req, { forceReload: true });
    sendJson(res, 200, {
      scholarships: canonical.scholarships,
      sourceFile: canonical.sourceFile
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

  if (req.method === "POST" && req.url === "/candidates/suggest") {
    try {
      const user = await resolveUserContext(req);
      if (!user.userId) {
        sendJson(res, 401, { error: "Sign in is required to suggest a scholarship URL." });
        return;
      }

      const body = await parseBody(req);
      const normalizedCandidate = normalizeSuggestedScholarship(body);
      const candidate = await enrichSuggestedScholarshipMetadata(normalizedCandidate, {
        timeoutMs: Number(body.fetchTimeoutMs || 12000)
      });
      const canonical = await getCanonicalScholarshipsForRequest(req, { forceReload: true });
      const existingScholarships = canonical.scholarships;
      const candidateUrl = String(candidate.sourceUrl || "").toLowerCase();
      const existingVetted = existingScholarships.find((scholarship) => {
        const scholarshipUrl = String(scholarship.sourceUrl || "").toLowerCase();
        return scholarshipUrl && candidateUrl && scholarshipUrl === candidateUrl;
      });
      if (existingVetted) {
        const supabaseRoute = await shouldUseSupabaseCandidateStore(req);
        let reprioritized = null;
        try {
          if (supabaseRoute.enabled) {
            reprioritized = await markCandidateAsUserSuggestedInSupabase({
              userId: supabaseRoute.userId,
              scholarshipId: String(existingVetted.id || "")
            });
          } else {
            reprioritized = await updateCandidateById({
              id: String(existingVetted.id || ""),
              updates: { userSuggested: true }
            });
          }
        } catch {
          reprioritized = null;
        }
        sendJson(res, 200, {
          status: "already_in_catalog",
          message: reprioritized
            ? "That scholarship is already in your saved scholarship catalog. It has been prioritized in your queue."
            : "That scholarship is already in your saved scholarship catalog, so it will not be duplicated in candidate queue.",
          existingScholarship: {
            id: existingVetted.id,
            name: existingVetted.name,
            sourceUrl: existingVetted.sourceUrl || "",
            sourceDomain: existingVetted.sourceDomain || ""
          },
          reprioritized
        });
        return;
      }
      const supabaseRoute = await shouldUseSupabaseCandidateStore(req);

      if (supabaseRoute.enabled) {
        const imported = await importCandidatesToSupabase(
          supabaseRoute.userId,
          [candidate],
          existingScholarships,
          { replacePending: false }
        );
        sendJson(res, 200, {
          status: imported.length ? "imported" : "already_in_queue",
          message: imported.length
            ? "Suggestion saved to your candidate queue."
            : "Suggestion already exists in your queue or vetted list.",
          imported,
          sourceFile: `supabase:user_scholarships (user_id=${supabaseRoute.userId})`
        });
        return;
      }

      const imported = await importCandidates([candidate], existingScholarships, {
        replacePending: false
      });
      sendJson(res, 200, {
        status: imported.length ? "imported" : "already_in_queue",
        message: imported.length
          ? "Suggestion saved to the local fallback queue."
          : "Suggestion already exists in the queue or vetted list.",
        imported,
        sourceFile: getCandidatesDataFilePath()
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/run-no-account-mvp") {
    try {
      const body = await parseBody(req);
      const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const documents = body.documents || [];
      const canonical = await getCanonicalScholarshipsForRequest(req, { forceReload: true });

      if (!Array.isArray(documents) || documents.length === 0) {
        sendJson(res, 400, { error: "documents must be a non-empty array" });
        return;
      }

      const result = await runNoAccountMvp({
        sessionId,
        documents,
        scholarships: canonical.scholarships,
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
      const canonical = await getCanonicalScholarshipsForRequest(req, { forceReload: true });

      const result = await runNoAccountMvp({
        sessionId,
        documents: normalizedDocuments,
        scholarships: canonical.scholarships,
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
    sendJson(res, 410, {
      error: "Deprecated: scholarship catalog is derived from per-user candidate state, not data/scholarships.vetted.json."
    });
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

      const canonical = await getCanonicalScholarshipsForRequest(req, { forceReload: true });
      const scholarship = canonical.scholarships.find((item) => item.id === scholarshipId);
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

      const persisted = await persistScholarshipFormMappingForRequest(req, scholarship, mapped, {
        mappingMode,
        fallbackReason
      });
      sendJson(res, 200, {
        message: `Generated ${mapped.discoveredCount} form field mappings for ${scholarshipId} (${mappingMode})`,
        scholarshipId,
        discoveredCount: mapped.discoveredCount,
        formFields: mapped.formFields,
        sourceUrl: mapped.sourceUrl,
        mappingMode,
        fallbackReason,
        sourceFile: persisted.sourceFile
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
        payload: body.payload || {},
        studentProfile: body.studentProfile || {}
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
      const canonical = await getCanonicalScholarshipsForRequest(req, { forceReload: true });
      const supabaseRoute = await shouldUseSupabaseCandidateStore(req);
      if (supabaseRoute.enabled) {
        const imported = await importCandidatesToSupabase(
          supabaseRoute.userId,
          body.candidates,
          canonical.scholarships,
          { replacePending: body.replacePending === true }
        );
        sendJson(res, 200, {
          message: `Imported ${imported.length} candidate scholarships`,
          imported,
          sourceFile: `supabase:user_scholarships (user_id=${supabaseRoute.userId})`
        });
        return;
      }

      const imported = await importCandidates(body.candidates, canonical.scholarships, {
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

      const approvedScholarship = reviewed.status === "approved"
        ? candidateToScholarshipRecord(reviewed)
        : null;

      sendJson(res, 200, {
        reviewed,
        approvedScholarship,
        candidatesFile: supabaseRoute.enabled
          ? `supabase:user_scholarships (user_id=${supabaseRoute.userId})`
          : getCandidatesDataFilePath(),
        canonicalSource: supabaseRoute.enabled
          ? `supabase:user_scholarships (user_id=${supabaseRoute.userId})`
          : getCandidatesDataFilePath()
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/admin/candidates/refresh-metadata") {
    try {
      const body = await parseBody(req);
      const candidateId = String(body.id || "").trim();
      if (!candidateId) {
        throw new Error("id is required");
      }

      const fetchTimeoutMs = Number(body.fetchTimeoutMs || 12000);
      const timeoutMs = Number.isFinite(fetchTimeoutMs) && fetchTimeoutMs > 0
        ? Math.min(fetchTimeoutMs, 30000)
        : 12000;

      const supabaseRoute = await shouldUseSupabaseCandidateStore(req);
      const candidates = supabaseRoute.enabled
        ? await loadCandidatesFromSupabase(supabaseRoute.userId)
        : await loadCandidates({ forceReload: true });
      const current = candidates.find((candidate) => String(candidate.id || "") === candidateId);
      if (!current) {
        throw new Error(`Candidate not found: ${candidateId}`);
      }
      if (!current.sourceUrl) {
        throw new Error("Candidate is missing sourceUrl and cannot be refreshed");
      }

      const enriched = await enrichSuggestedScholarshipMetadata({
        ...current,
        userProvidedName: false
      }, { timeoutMs, silent: false });

      const pathDerivedName = deriveNameFromUrlPath(current.sourceUrl || "");
      if (
        pathDerivedName
        && isLikelyDomainDerivedTitle(enriched.name, current.sourceDomain)
        && pathDerivedName.toLowerCase() !== String(enriched.name || "").toLowerCase()
      ) {
        enriched.name = pathDerivedName;
      }

      const updated = supabaseRoute.enabled
        ? await refreshCandidateMetadataInSupabase({
          userId: supabaseRoute.userId,
          scholarshipId: candidateId,
          name: enriched.name,
          deadline: enriched.deadline,
          awardAmount: enriched.awardAmount
        })
        : await updateCandidateById({
          id: candidateId,
          updates: {
            name: enriched.name,
            deadline: enriched.deadline,
            awardAmount: Number(enriched.awardAmount || 0)
          }
        });

      const changedFields = [];
      if (String(updated.name || "") !== String(current.name || "")) changedFields.push("name");
      if (String(updated.deadline || "") !== String(current.deadline || "")) changedFields.push("deadline");
      if (Number(updated.awardAmount || 0) !== Number(current.awardAmount || 0)) changedFields.push("awardAmount");

      sendJson(res, 200, {
        candidate: updated,
        changedFields,
        message: changedFields.length
          ? `Updated ${changedFields.join(", ")} from source page.`
          : "No new metadata found on source page.",
        candidatesFile: supabaseRoute.enabled
          ? `supabase:user_scholarships (user_id=${supabaseRoute.userId})`
          : getCandidatesDataFilePath()
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
        freshStart: body.freshStart === true,
        searchTimeoutMs: typeof body.searchTimeoutMs === "number" ? body.searchTimeoutMs : 10000,
        pageTimeoutMs: typeof body.pageTimeoutMs === "number" ? body.pageTimeoutMs : 12000,
        pageRetries: typeof body.pageRetries === "number" ? body.pageRetries : 1,
        aiTimeoutMs: typeof body.codexTimeoutSec === "number" ? body.codexTimeoutSec * 1000 : 45000
      });

      const discoveredCandidates = discovery.candidates.map((item) => item.candidate);
      const canonical = await getCanonicalScholarshipsForRequest(req, { forceReload: true });
      const imported = supabaseRoute.enabled
        ? await importCandidatesToSupabase(
          supabaseRoute.userId,
          discoveredCandidates,
          canonical.scholarships,
          { replacePending: true }
        )
        : await importCandidates(discoveredCandidates, canonical.scholarships, {
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

      const responseMessage = buildDiscoveryResponseMessage(noNewCandidatesReason, {
        discoveredByAgent,
        importedCount,
        pendingCount
      });

      sendJson(res, 200, {
        message: responseMessage,
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
