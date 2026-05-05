function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

const DEFAULT_EXPERIMENT_VARIANT = "trusted_agg_conservative";
const TRUSTED_AGGREGATOR_DOMAINS = new Set([
  "scholarships360.org",
  "accessscholarships.com"
]);

function clampBudget(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
  return Math.max(0, Math.floor(numeric));
}

function hasAnyText(value) {
  return cleanText(value).length > 0;
}

function normalizeText(value) {
  return cleanText(value).toLowerCase();
}

function normalizeVariant(value = "") {
  const normalized = normalizeText(value);
  return normalized || DEFAULT_EXPERIMENT_VARIANT;
}

function pageEvidenceText(page = {}) {
  const evidenceSnippets = page?.evidenceSnippets || {};
  return cleanText([
    page?.title || "",
    page?.canonicalUrl || page?.requestedUrl || "",
    evidenceSnippets.deadlineSnippet || "",
    evidenceSnippets.eligibilitySnippet || "",
    evidenceSnippets.amountSnippet || "",
    evidenceSnippets.stageRestrictionSnippet || ""
  ].join(" "));
}

function getBaseDomain(domain = "") {
  const parts = normalizeText(domain).split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  return parts.slice(-2).join(".");
}

function countPositiveSignals(page = {}) {
  const pageSignals = page?.pageSignals || {};
  let count = 0;
  if (pageSignals.deadlineSignal) count += 1;
  if (pageSignals.awardAmountSignal) count += 1;
  if (pageSignals.eligibilitySignal) count += 1;
  if (pageSignals.applicationSignal) count += 1;
  return count;
}

function hasStageCue(page = {}) {
  const text = pageEvidenceText(page);
  return /\b(high school senior|high school student|incoming|freshman|first year of college|college freshman|grade level)\b/i.test(text);
}

function hasVerificationCue(page = {}) {
  const text = pageEvidenceText(page);
  return /\b(verified by the scholarship providing organization|reviewed by|scholarship review process|reviewed scholarship)\b/i.test(text);
}

function hasBroadRoundupTitle(page = {}) {
  const title = cleanText(page?.title || "");
  return /\b(top|best|\d+)\b/i.test(title) || /\bscholarships\b/i.test(title);
}

function hasSingularScholarshipTitle(page = {}) {
  const title = cleanText(page?.title || "");
  if (!title) return false;
  if (!/\b(scholarship|award|grant|fellowship)\b/i.test(title)) return false;
  if (/\bscholarships\b/i.test(title)) return false;
  return true;
}

function isMultiOpportunityProgramPage(page = {}) {
  const text = pageEvidenceText(page);
  return /\b(comprises \w+ individual scholarship|individual scholarship programs|multiple scholarship programs|scholarship program comprises)\b/i.test(text);
}

function countPromisingChildLinks(page = {}) {
  const pageSignals = page?.pageSignals || {};
  const childLinks = Array.isArray(page?.childLinks) ? page.childLinks : [];
  let count = 0;
  for (const link of childLinks) {
    const anchorText = cleanText(link?.anchorText || "");
    if (!anchorText) continue;
    if (/\b(donate|donation|mentor|mentorship|internship|research program|return to application|login|sign in)\b/i.test(anchorText)) {
      continue;
    }
    if (link?.detailPathLikely) {
      count += 1;
      continue;
    }
    if (pageSignals.aggregatorSummarySignal && !link?.sameDomain && /\b(apply|application|official|source|provider|sponsor|website)\b/i.test(anchorText)) {
      count += 1;
      continue;
    }
    if (/\b(scholarship|award|grant|fellowship)\b/i.test(anchorText)) {
      count += 1;
    }
  }
  return count;
}

function isAggregatorMirrorPage(page = {}) {
  const pageSignals = page?.pageSignals || {};
  return Boolean(
    pageSignals.aggregatorSummarySignal
    || (pageSignals.originalSourceLinkSignal && !pageSignals.directScholarshipSignal)
  );
}

function isFinancialAidExplainerPage(page = {}) {
  const pageSignals = page?.pageSignals || {};
  const text = pageEvidenceText(page).toLowerCase();
  if (!text) return false;

  const aidCue = /\b(pell grant|fafsa|financial aid|federal student aid|student aid|grant eligibility|grant maximum|grant minimum)\b/.test(text);
  const explainerCue = /\b(everything you need to know|how to|what is|eligibility|aid amounts?|award amounts?|deadline|federal)\b/.test(text);
  const scholarshipCue = /\bscholarship\b/.test(text);

  return Boolean(
    aidCue
    && explainerCue
    && !pageSignals.directScholarshipSignal
    && !scholarshipCue
  );
}

function isTrustedAggregatorDomain(page = {}) {
  const domain = getBaseDomain(page?.sourceDomain || "");
  return TRUSTED_AGGREGATOR_DOMAINS.has(domain);
}

function getTrustedAggregatorAdvanceReason(page = {}, experimentVariant = DEFAULT_EXPERIMENT_VARIANT) {
  const variant = normalizeVariant(experimentVariant);
  const blockers = page?.blockers || {};
  const pageSignals = page?.pageSignals || {};

  if (variant === "control") return "";
  if (!isAggregatorMirrorPage(page)) return "";
  if (blockers.accessBlockedSignal || blockers.closedSignal || blockers.pastCycleSignal || blockers.explicitStageMismatchSignal) return "";
  if (isFinancialAidExplainerPage(page)) return "";
  if (pageSignals.hubSignal) return "";
  if (!pageSignals.listSignal) return "";
  if (!hasSingularScholarshipTitle(page)) return "";
  if (hasBroadRoundupTitle(page)) return "";
  if (isMultiOpportunityProgramPage(page)) return "";

  const positiveSignals = countPositiveSignals(page);
  const stageCue = hasStageCue(page);
  const verificationCue = hasVerificationCue(page);
  const trustedDomain = isTrustedAggregatorDomain(page);

  if (variant === "trusted_agg_conservative") {
    if (positiveSignals >= 4 && stageCue && verificationCue) {
      return "Fetched page looks like a trusted aggregator detail page with enough concrete scholarship evidence to send to finalization now.";
    }
    return "";
  }

  if (variant === "trusted_agg_moderate") {
    if ((positiveSignals >= 4 && stageCue) || (positiveSignals >= 3 && stageCue && verificationCue)) {
      return "Fetched page looks like a trusted aggregator detail page with enough concrete scholarship evidence to send to finalization now.";
    }
    return "";
  }

  if (variant === "trusted_agg_strict_domain") {
    if (trustedDomain && positiveSignals >= 4 && stageCue && verificationCue) {
      return "Fetched page looks like a trusted aggregator detail page with enough concrete scholarship evidence to send to finalization now.";
    }
    return "";
  }

  return "";
}

function hasStrongDirectEvidence(page = {}) {
  const pageSignals = page?.pageSignals || {};
  const evidenceSnippets = page?.evidenceSnippets || {};
  const strongSignalCount = countPositiveSignals(page);

  if (isAggregatorMirrorPage(page)) return false;
  if (!pageSignals.directScholarshipSignal) return false;
  if (strongSignalCount >= 2) return true;
  if (strongSignalCount >= 1 && (
    hasAnyText(evidenceSnippets.eligibilitySnippet)
    || hasAnyText(evidenceSnippets.amountSnippet)
    || hasAnyText(evidenceSnippets.deadlineSnippet)
  )) {
    return true;
  }
  return false;
}

function isExpandable(page = {}, remainingBudget = {}) {
  const pageSignals = page?.pageSignals || {};
  const pagesRemaining = clampBudget(remainingBudget?.pages);
  const depthRemaining = clampBudget(remainingBudget?.depth);
  const promisingChildLinks = countPromisingChildLinks(page);
  if (pagesRemaining <= 0 || depthRemaining <= 0) return false;
  if (promisingChildLinks <= 0) return false;
  if (pageSignals.hubSignal || pageSignals.listSignal) return true;
  return promisingChildLinks >= 2;
}

function buildDecision(page, action, rationale) {
  return {
    url: page?.canonicalUrl || page?.requestedUrl || "",
    action,
    rationale: cleanText(rationale)
  };
}

function summarizeQueue(decisions = []) {
  const queue = {
    advanceToFinalize: [],
    holdForExpansion: [],
    dropped: []
  };
  for (const decision of decisions) {
    if (decision.action === "advance_to_finalize") queue.advanceToFinalize.push(decision.url);
    else if (decision.action === "hold_for_expansion") queue.holdForExpansion.push(decision.url);
    else if (decision.action === "drop") queue.dropped.push(decision.url);
  }
  return queue;
}

export function triageFrontier({
  pageBundles = [],
  remainingBudget = {},
  experimentVariant = DEFAULT_EXPERIMENT_VARIANT
} = {}) {
  const bundles = Array.isArray(pageBundles) ? pageBundles : [];
  if (bundles.length === 0) {
    throw new Error("pageBundles must be a non-empty array");
  }

  const decisions = bundles.map((page) => {
    const blockers = page?.blockers || {};
    const fitSignals = page?.fitSignals || {};
    const pageSignals = page?.pageSignals || {};
    const promisingChildLinks = countPromisingChildLinks(page);
    const expandable = isExpandable(page, remainingBudget);
    const strongDirectEvidence = hasStrongDirectEvidence(page);
    const aggregatorMirrorPage = isAggregatorMirrorPage(page);
    const trustedAggregatorAdvanceReason = getTrustedAggregatorAdvanceReason(page, experimentVariant);

    if (blockers.accessBlockedSignal) {
      return buildDecision(page, "drop", "Page could not be meaningfully accessed, so it is not worth more attention in this run.");
    }

    if (blockers.closedSignal) {
      return buildDecision(page, "drop", "Page appears closed or expired, so it should not continue in this run.");
    }

    if (blockers.pastCycleSignal) {
      return buildDecision(page, "drop", "Page appears tied to a past scholarship cycle and is not worth more attention in this run.");
    }

    if (blockers.explicitStageMismatchSignal && pageSignals.directScholarshipSignal) {
      return buildDecision(page, "drop", "Direct scholarship page shows an explicit stage mismatch, so it should not continue in this run.");
    }

    if (blockers.explicitStageMismatchSignal) {
      return buildDecision(page, "drop", "Page shows an explicit student-stage mismatch, so it should not continue in this run.");
    }

    if (isFinancialAidExplainerPage(page)) {
      return buildDecision(page, "drop", "Page is a financial-aid explainer rather than a scholarship candidate page, so it should not continue in this run.");
    }

    if (strongDirectEvidence) {
      return buildDecision(page, "advance_to_finalize", "Fetched page looks like a direct scholarship page with enough concrete evidence to send to finalization now.");
    }

    if (trustedAggregatorAdvanceReason) {
      return buildDecision(page, "advance_to_finalize", trustedAggregatorAdvanceReason);
    }

    if (aggregatorMirrorPage && expandable) {
      return buildDecision(page, "hold_for_expansion", "Fetched page looks like an aggregator summary, so it should expand to the original source before finalization.");
    }

    if (aggregatorMirrorPage) {
      return buildDecision(page, "drop", "Fetched page looks like an aggregator summary but does not expose a useful original-source expansion path.");
    }

    if (expandable) {
      if (fitSignals.specificSchoolSignal && !pageSignals.hubSignal && promisingChildLinks < 2) {
        return buildDecision(page, "drop", "Page is too school-specific and does not expose a strong enough expansion path for this run.");
      }
      return buildDecision(page, "hold_for_expansion", "Fetched page looks more like a gateway than a final scholarship and has useful child links worth exploring.");
    }

    if (pageSignals.indirectContentSignal && promisingChildLinks <= 0) {
      return buildDecision(page, "drop", "Page looks indirect and does not provide a strong enough path to continue.");
    }

    if (fitSignals.specificSchoolSignal && !pageSignals.directScholarshipSignal) {
      return buildDecision(page, "drop", "Page is school-specific and does not look strong enough to continue without a better expansion path.");
    }

    return buildDecision(page, "drop", "Fetched page does not show enough direct evidence or expansion value to continue in this run.");
  });

  return {
    decisions,
    queue: summarizeQueue(decisions),
    notes: normalizeVariant(experimentVariant) !== DEFAULT_EXPERIMENT_VARIANT
      ? [`experiment_variant=${normalizeVariant(experimentVariant)}`]
      : []
  };
}
