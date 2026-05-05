import { normalizeDiscoveryUrl } from "./discoveryHistoryStore.js";

const DEFAULT_COLD_HUB_QUEUE_CAP = 2;
const DEFAULT_HOT_HUB_PROMOTION_CAP = 2;

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function uniqueStrings(values = []) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const cleaned = cleanText(value);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(cleaned);
  }
  return output;
}

function verificationPriorityScore(value = "") {
  if (value === "high") return 3;
  if (value === "medium") return 2;
  if (value === "low") return 1;
  return 0;
}

function lineageScore(value) {
  return Number(value) || 0;
}

function toExpansionItem(lead = {}, { sourceType = "", sourceUrl = "", enqueuedRound = 1 } = {}) {
  return {
    url: cleanText(lead?.leadUrl || ""),
    parentHubUrl: cleanText(sourceUrl),
    sourceType: cleanText(sourceType),
    verificationPriority: cleanText(lead?.verificationPriority || ""),
    isOfficialSourceLikely: Boolean(lead?.isOfficialSourceLikely),
    needsSourceVerification: Boolean(lead?.needsSourceVerification),
    enqueuedRound: Number(enqueuedRound) || 1
  };
}

function expansionItemPriority(item = {}, hotHubScores = new Map()) {
  const parentHubUrl = cleanText(item?.parentHubUrl || "");
  const hotScore = lineageScore(hotHubScores.get(parentHubUrl));
  let score = hotScore * 10;
  score += verificationPriorityScore(item?.verificationPriority);
  if (item?.isOfficialSourceLikely) score += 2;
  if (item?.needsSourceVerification) score += 0.5;
  return score;
}

function sortExpansionItems(items = [], hotHubScores = new Map()) {
  return [...items].sort((left, right) => (
    expansionItemPriority(right, hotHubScores) - expansionItemPriority(left, hotHubScores)
    || (Number(left.enqueuedRound || 0) - Number(right.enqueuedRound || 0))
    || cleanText(left.url).localeCompare(cleanText(right.url))
  ));
}

export function stageHubLeadExtraction({
  leadExtraction = {},
  expansionQueue = [],
  hubLeadBacklog = new Map(),
  alreadyFetched = new Set(),
  enqueuedRound = 1,
  coldHubQueueCap = DEFAULT_COLD_HUB_QUEUE_CAP
} = {}) {
  const queueCap = Math.max(1, Math.floor(Number(coldHubQueueCap) || DEFAULT_COLD_HUB_QUEUE_CAP));
  const queue = Array.isArray(expansionQueue) ? [...expansionQueue] : [];
  const fetched = alreadyFetched instanceof Set ? alreadyFetched : new Set();
  const queuedUrls = new Set(queue.map((item) => normalizeDiscoveryUrl(item?.url || "")).filter(Boolean));

  const groups = Array.isArray(leadExtraction?.leadGroups) ? leadExtraction.leadGroups : [];
  const added = [];
  const backlogged = [];

  for (const group of groups) {
    const sourceUrl = cleanText(group?.sourceUrl || "");
    if (!sourceUrl) continue;
    const leads = Array.isArray(group?.leads) ? group.leads : [];
    const viable = leads
      .map((lead) => toExpansionItem(lead, {
        sourceType: group?.sourceType,
        sourceUrl,
        enqueuedRound
      }))
      .filter((item) => {
        const normalized = normalizeDiscoveryUrl(item.url);
        return Boolean(normalized && !fetched.has(normalized));
      });

    if (viable.length === 0) continue;
    const immediate = [];
    const reserve = [];
    for (const item of viable) {
      const normalized = normalizeDiscoveryUrl(item.url);
      if (!normalized || queuedUrls.has(normalized)) continue;
      if (immediate.length < queueCap) {
        immediate.push(item);
        queuedUrls.add(normalized);
      } else {
        reserve.push(item);
      }
    }

    queue.push(...immediate);
    added.push(...immediate.map((item) => item.url));

    if (reserve.length > 0) {
      const existing = Array.isArray(hubLeadBacklog.get(sourceUrl)) ? hubLeadBacklog.get(sourceUrl) : [];
      const existingUrls = new Set(existing.map((item) => normalizeDiscoveryUrl(item?.url || "")).filter(Boolean));
      const merged = [...existing];
      for (const item of reserve) {
        const normalized = normalizeDiscoveryUrl(item.url);
        if (!normalized || existingUrls.has(normalized) || queuedUrls.has(normalized)) continue;
        existingUrls.add(normalized);
        merged.push(item);
        backlogged.push(item.url);
      }
      hubLeadBacklog.set(sourceUrl, merged);
    }
  }

  return {
    expansionQueue: queue,
    addedUrls: uniqueStrings(added),
    backloggedUrls: uniqueStrings(backlogged)
  };
}

export function recordHubLineageOutcomes({
  fetchedUrls = [],
  pageBundles = [],
  triageQueue = {},
  leadOrigins = new Map(),
  hotHubScores = new Map()
} = {}) {
  const advanced = new Set((triageQueue?.advanceToFinalize || []).map((url) => normalizeDiscoveryUrl(url)).filter(Boolean));
  const held = new Set((triageQueue?.holdForExpansion || []).map((url) => normalizeDiscoveryUrl(url)).filter(Boolean));
  const updated = [];
  const pages = Array.isArray(pageBundles) ? pageBundles : [];
  const pagesToInspect = pages.length > 0
    ? pages.map((page) => ({
        requestedUrl: cleanText(page?.requestedUrl || ""),
        canonicalUrl: cleanText(page?.canonicalUrl || page?.requestedUrl || "")
      }))
    : fetchedUrls.map((url) => ({
        requestedUrl: cleanText(url),
        canonicalUrl: cleanText(url)
      }));

  for (const page of pagesToInspect) {
    const requestedNormalized = normalizeDiscoveryUrl(page?.requestedUrl || "");
    const canonicalNormalized = normalizeDiscoveryUrl(page?.canonicalUrl || "");
    const normalized = canonicalNormalized || requestedNormalized;
    if (!normalized) continue;
    const parentHubUrl = cleanText(
      leadOrigins.get(canonicalNormalized)
      || leadOrigins.get(requestedNormalized)
      || ""
    );
    if (!parentHubUrl) continue;

    let delta = 0;
    if (advanced.has(canonicalNormalized) || advanced.has(requestedNormalized)) delta = 2;
    else if (held.has(canonicalNormalized) || held.has(requestedNormalized)) delta = 1;
    if (delta <= 0) continue;

    hotHubScores.set(parentHubUrl, lineageScore(hotHubScores.get(parentHubUrl)) + delta);
    updated.push({
      parentHubUrl,
      delta,
      url: cleanText(page?.canonicalUrl || page?.requestedUrl || "")
    });
  }

  return updated;
}

export function promoteHotHubReserveLeads({
  expansionQueue = [],
  hubLeadBacklog = new Map(),
  alreadyFetched = new Set(),
  hotHubScores = new Map(),
  maxPromotionsPerHub = DEFAULT_HOT_HUB_PROMOTION_CAP
} = {}) {
  const queue = Array.isArray(expansionQueue) ? [...expansionQueue] : [];
  const fetched = alreadyFetched instanceof Set ? alreadyFetched : new Set();
  const queuedUrls = new Set(queue.map((item) => normalizeDiscoveryUrl(item?.url || "")).filter(Boolean));
  const promotionCap = Math.max(1, Math.floor(Number(maxPromotionsPerHub) || DEFAULT_HOT_HUB_PROMOTION_CAP));
  const promoted = [];

  const hotHubs = [...hotHubScores.entries()]
    .filter(([, score]) => lineageScore(score) > 0)
    .sort((left, right) => lineageScore(right[1]) - lineageScore(left[1]));

  for (const [parentHubUrl] of hotHubs) {
    const reserve = Array.isArray(hubLeadBacklog.get(parentHubUrl)) ? [...hubLeadBacklog.get(parentHubUrl)] : [];
    if (reserve.length === 0) continue;

    const remaining = [];
    let promotedCount = 0;
    for (const item of reserve) {
      const normalized = normalizeDiscoveryUrl(item?.url || "");
      if (!normalized || fetched.has(normalized) || queuedUrls.has(normalized)) continue;
      if (promotedCount < promotionCap) {
        queue.push(item);
        queuedUrls.add(normalized);
        promoted.push(item.url);
        promotedCount += 1;
      } else {
        remaining.push(item);
      }
    }

    if (remaining.length > 0) hubLeadBacklog.set(parentHubUrl, remaining);
    else hubLeadBacklog.delete(parentHubUrl);
  }

  return {
    expansionQueue: queue,
    promotedUrls: uniqueStrings(promoted)
  };
}

export function selectExpansionBatch({
  expansionQueue = [],
  hotHubScores = new Map(),
  fetchLimit = 6
} = {}) {
  const limit = Math.max(1, Math.floor(Number(fetchLimit) || 1));
  const sorted = sortExpansionItems(expansionQueue, hotHubScores);
  return {
    selectedItems: sorted.slice(0, limit),
    remainingItems: sorted.slice(limit)
  };
}
