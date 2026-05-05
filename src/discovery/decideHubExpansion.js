const DEFAULT_MAX_CHILDREN_TO_SELECT = 4;
const MAX_DEBUG_REJECTED_CHILDREN = 5;

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function clampCount(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return Math.max(0, Math.floor(fallback));
  return Math.max(0, Math.floor(numeric));
}

function getPageUrl(page = {}) {
  return cleanText(page?.canonicalUrl || page?.requestedUrl || page?.url || "");
}

function getChildUrl(child = {}) {
  return cleanText(child?.url || "");
}

function normalizeAnchorText(child = {}) {
  return cleanText(child?.anchorText || "");
}

function isNavigationalChild(child = {}) {
  const combined = `${normalizeAnchorText(child)} ${getChildUrl(child)}`.toLowerCase();
  return /\b(donate|donation|mentor|mentorship|internship|research program|program administration|about|contact|privacy|policy|terms|login|log in|sign in|sign-in|portal|return to application|apply now|make a gift|give now)\b/.test(combined);
}

function isScholarshipLikeChild(child = {}) {
  const combined = `${normalizeAnchorText(child)} ${getChildUrl(child)}`.toLowerCase();
  return Boolean(
    child?.detailPathLikely
    || /\b(scholarship|award|grant|fellowship|scholarships)\b/.test(combined)
  );
}

function isOriginalSourceChild(child = {}, pageSignals = {}) {
  if (!pageSignals.aggregatorSummarySignal || !pageSignals.originalSourceLinkSignal) return false;
  if (child?.sameDomain) return false;
  const combined = `${normalizeAnchorText(child)} ${getChildUrl(child)}`.toLowerCase();
  return /\b(apply|application|official|source|provider|sponsor|website|scholarship|scholarships|award|grant|fellowship)\b/.test(combined);
}

function scoreChildLink(child = {}, { pageSignals = {} } = {}) {
  const url = getChildUrl(child);
  const anchorText = normalizeAnchorText(child);
  const originalSourceChild = isOriginalSourceChild(child, pageSignals);
  let score = 0;
  let reason = "Child link is weaker than the selected expansion paths.";

  if (!url) {
    return { score: -10, reason: "Missing child URL." };
  }

  if (!anchorText) {
    score -= 1;
  }

  if (isNavigationalChild(child) && !originalSourceChild) {
    return {
      score: -6,
      reason: "Looks navigational or unrelated to scholarship detail."
    };
  }

  if (child?.seenRecently) {
    return {
      score: -4,
      reason: "Already seen recently, so it is not a good use of fetch budget."
    };
  }

  if (originalSourceChild) {
    score += 6;
    reason = "Looks like an offsite original-source path for an aggregator summary page.";
  }

  if (child?.detailPathLikely) {
    score += 3;
    if (!originalSourceChild) {
      reason = "Looks like a likely scholarship-detail child worth fetching next.";
    }
  }

  if (isScholarshipLikeChild(child)) {
    score += 2;
    reason = child?.detailPathLikely
      ? reason
      : "Anchor text or URL suggests this is a scholarship-oriented child page.";
  }

  if (child?.sameDomain && pageSignals.aggregatorSummarySignal && pageSignals.originalSourceLinkSignal) {
    score -= 3;
    reason = child?.detailPathLikely
      ? "Same-domain aggregator detail page is weaker than fetching an original-source link first."
      : reason;
  } else if (child?.sameDomain) {
    score += 1;
  }

  if (/\.edu$/i.test(cleanText(child?.sourceDomain || ""))) {
    score += 0.5;
  }

  if (/\b(apply|application)\b/i.test(anchorText) && !isScholarshipLikeChild(child) && !originalSourceChild) {
    score -= 2;
    reason = "Looks more like a generic application path than a scholarship detail page.";
  }

  return { score, reason, originalSourceChild };
}

function buildRejectedChildren(candidates = [], selectedUrlSet = new Set()) {
  return candidates
    .filter((candidate) => !selectedUrlSet.has(candidate.url))
    .sort((left, right) => right.score - left.score)
    .slice(0, MAX_DEBUG_REJECTED_CHILDREN)
    .map((candidate) => ({
      url: candidate.url,
      reason: candidate.reason
    }));
}

export function decideHubExpansion({
  hubPageBundle = {},
  remainingBudget = {},
  maxChildrenToSelect = DEFAULT_MAX_CHILDREN_TO_SELECT
} = {}) {
  const hubUrl = getPageUrl(hubPageBundle);
  if (!hubUrl) {
    throw new Error("hubPageBundle must include a canonicalUrl, requestedUrl, or url");
  }

  const childLinks = Array.isArray(hubPageBundle?.childLinks) ? hubPageBundle.childLinks : [];
  const notes = [];
  const blockers = hubPageBundle?.blockers || {};
  const pageSignals = hubPageBundle?.pageSignals || {};
  const pagesRemaining = clampCount(remainingBudget?.pages, 0);
  const depthRemaining = clampCount(remainingBudget?.depth, 0);
  const selectionCap = Math.max(
    0,
    Math.min(
      clampCount(maxChildrenToSelect, DEFAULT_MAX_CHILDREN_TO_SELECT) || DEFAULT_MAX_CHILDREN_TO_SELECT,
      pagesRemaining
    )
  );

  if (blockers.accessBlockedSignal) {
    return {
      expand: false,
      selectedChildren: [],
      rejectedChildren: [],
      selectedChildUrls: [],
      rationale: "Hub page could not be meaningfully accessed, so it should not be expanded.",
      notes
    };
  }

  if (blockers.closedSignal || blockers.pastCycleSignal) {
    return {
      expand: false,
      selectedChildren: [],
      rejectedChildren: [],
      selectedChildUrls: [],
      rationale: "Hub page appears closed or stale, so it is not worth expanding.",
      notes
    };
  }

  if (pagesRemaining <= 0 || depthRemaining <= 0 || selectionCap <= 0) {
    return {
      expand: false,
      selectedChildren: [],
      rejectedChildren: [],
      selectedChildUrls: [],
      rationale: "Remaining budget does not support expanding this hub right now.",
      notes
    };
  }

  if (childLinks.length === 0) {
    return {
      expand: false,
      selectedChildren: [],
      rejectedChildren: [],
      selectedChildUrls: [],
      rationale: "Hub page does not expose any child links worth expanding.",
      notes
    };
  }

  const scoredChildren = childLinks
    .map((child) => {
      const url = getChildUrl(child);
      const { score, reason, originalSourceChild } = scoreChildLink(child, { pageSignals });
      return {
        url,
        score,
        reason,
        originalSourceChild
      };
    })
    .filter((candidate) => candidate.url);

  const hasOriginalSourceCandidates = pageSignals.aggregatorSummarySignal
    && pageSignals.originalSourceLinkSignal
    && scoredChildren.some((candidate) => candidate.originalSourceChild && candidate.score >= 2);
  const viableChildren = scoredChildren.filter((candidate) => (
    candidate.score >= 2
    && (!hasOriginalSourceCandidates || candidate.originalSourceChild)
  ));
  const selectedCandidates = viableChildren
    .sort((left, right) => right.score - left.score)
    .slice(0, selectionCap);

  if (viableChildren.length > selectionCap) {
    notes.push(`selection_clamped_to_budget=${selectionCap}`);
  }
  if (hasOriginalSourceCandidates) {
    notes.push("preferred_original_source_links_for_aggregator_summary");
  }

  if (selectedCandidates.length === 0) {
    return {
      expand: false,
      selectedChildren: [],
      rejectedChildren: buildRejectedChildren(scoredChildren, new Set()),
      selectedChildUrls: [],
      rationale: "Child links do not look strong enough to justify expansion in this round.",
      notes
    };
  }

  if (pageSignals.directScholarshipSignal && !pageSignals.hubSignal && !pageSignals.listSignal) {
    notes.push("parent_page_looks_direct_but_child_links_were_selected");
  }

  const selectedChildren = selectedCandidates.map((candidate) => ({
    url: candidate.url,
    reason: candidate.reason
  }));
  const selectedUrlSet = new Set(selectedChildren.map((child) => child.url));

  return {
    expand: true,
    selectedChildren,
    rejectedChildren: buildRejectedChildren(scoredChildren, selectedUrlSet),
    selectedChildUrls: selectedChildren.map((child) => child.url),
    rationale: hasOriginalSourceCandidates
      ? "Aggregator summary looks worth expanding through original-source child links."
      : "Hub looks worth expanding and contains promising scholarship-detail child links.",
    notes
  };
}
