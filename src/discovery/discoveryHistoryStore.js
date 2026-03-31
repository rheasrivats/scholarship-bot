import fs from "node:fs/promises";
import path from "node:path";

const ONE_HOUR_MS = 60 * 60 * 1000;
const PAGE_TYPE_TTLS_MS = {
  direct_scholarship: 24 * ONE_HOUR_MS,
  scholarship_list_page: 12 * ONE_HOUR_MS,
  not_scholarship_page: 72 * ONE_HOUR_MS,
  unsupported_content_type: 72 * ONE_HOUR_MS,
  fetch_error: 6 * ONE_HOUR_MS,
  unknown: 24 * ONE_HOUR_MS
};

let cachedHistoryPath = "";
let cachedHistoryMap = null;

function getDiscoveryHistoryFilePath() {
  return path.resolve(process.cwd(), String(process.env.DISCOVERY_URL_HISTORY_PATH || "data/discovery-url-history.json").trim());
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function normalizeDiscoveryUrl(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_cid|mc_eid|ref|source)$/i.test(key)) {
        parsed.searchParams.delete(key);
      }
    }
    const pathname = parsed.pathname.replace(/\/+$/, "");
    parsed.pathname = pathname || "/";
    parsed.hostname = parsed.hostname.toLowerCase();
    return parsed.toString();
  } catch {
    return cleanText(value).toLowerCase();
  }
}

function defaultRecordForUrl(url) {
  const normalizedUrl = normalizeDiscoveryUrl(url);
  let sourceDomain = "";
  try {
    sourceDomain = new URL(normalizedUrl).hostname.replace(/^www\./i, "");
  } catch {
    sourceDomain = "";
  }
  return {
    url: cleanText(url) || normalizedUrl,
    normalizedUrl,
    sourceDomain,
    pageType: "unknown",
    lastSeenAt: "",
    lastFetchedAt: "",
    lastSearchQuery: "",
    lastError: "",
    candidateId: "",
    candidateName: ""
  };
}

async function readHistoryFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    return [];
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function writeHistoryFile(filePath, records) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const sorted = [...records].sort((a, b) => {
    const left = String(a.lastFetchedAt || a.lastSeenAt || "");
    const right = String(b.lastFetchedAt || b.lastSeenAt || "");
    return right.localeCompare(left);
  });
  await fs.writeFile(filePath, `${JSON.stringify(sorted, null, 2)}\n`, "utf8");
}

export async function loadDiscoveryUrlHistory({ forceReload = false } = {}) {
  const filePath = getDiscoveryHistoryFilePath();
  if (!forceReload && cachedHistoryMap && cachedHistoryPath === filePath) {
    return new Map(cachedHistoryMap);
  }

  const rows = await readHistoryFile(filePath);
  const map = new Map();
  for (const row of rows) {
    const normalizedUrl = normalizeDiscoveryUrl(row?.normalizedUrl || row?.url || "");
    if (!normalizedUrl) continue;
    map.set(normalizedUrl, {
      ...defaultRecordForUrl(normalizedUrl),
      ...row,
      normalizedUrl
    });
  }
  cachedHistoryMap = map;
  cachedHistoryPath = filePath;
  return new Map(map);
}

export function shouldSkipUrlByHistory(url, historyMap, now = Date.now()) {
  const normalizedUrl = normalizeDiscoveryUrl(url);
  const record = historyMap?.get(normalizedUrl);
  if (!record?.lastFetchedAt) {
    return { skip: false, record: record || null, normalizedUrl, pageType: "unknown", ageMs: null, ttlMs: null };
  }

  const lastFetchedMs = Date.parse(String(record.lastFetchedAt || ""));
  if (!Number.isFinite(lastFetchedMs)) {
    return { skip: false, record, normalizedUrl, pageType: String(record.pageType || "unknown"), ageMs: null, ttlMs: null };
  }

  const pageType = String(record.pageType || "unknown");
  const ttlMs = PAGE_TYPE_TTLS_MS[pageType] ?? PAGE_TYPE_TTLS_MS.unknown;
  const ageMs = Math.max(0, now - lastFetchedMs);
  return {
    skip: ageMs < ttlMs,
    record,
    normalizedUrl,
    pageType,
    ageMs,
    ttlMs
  };
}

export async function upsertDiscoveryUrlHistory(updates) {
  const filePath = getDiscoveryHistoryFilePath();
  const current = await loadDiscoveryUrlHistory();

  for (const update of updates || []) {
    const normalizedUrl = normalizeDiscoveryUrl(update?.normalizedUrl || update?.url || "");
    if (!normalizedUrl) continue;

    const previous = current.get(normalizedUrl) || defaultRecordForUrl(update?.url || normalizedUrl);
    const next = {
      ...previous,
      normalizedUrl,
      url: cleanText(update?.url || previous.url || normalizedUrl),
      sourceDomain: cleanText(update?.sourceDomain || previous.sourceDomain),
      pageType: cleanText(update?.pageType || previous.pageType || "unknown"),
      lastSeenAt: cleanText(update?.lastSeenAt || previous.lastSeenAt),
      lastFetchedAt: cleanText(update?.lastFetchedAt || previous.lastFetchedAt),
      lastSearchQuery: cleanText(update?.lastSearchQuery || previous.lastSearchQuery),
      lastError: cleanText(update?.lastError || previous.lastError),
      candidateId: cleanText(update?.candidateId || previous.candidateId),
      candidateName: cleanText(update?.candidateName || previous.candidateName)
    };
    current.set(normalizedUrl, next);
  }

  cachedHistoryMap = current;
  cachedHistoryPath = filePath;
  await writeHistoryFile(filePath, [...current.values()]);
}

export const __testables = {
  getDiscoveryHistoryFilePath,
  PAGE_TYPE_TTLS_MS
};
