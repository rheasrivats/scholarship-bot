const DEFAULT_MAX_LEADS_PER_PAGE = 5;
const DEFAULT_MAX_TOTAL_LEADS = 15;
const MAX_REJECTED_CHILDREN_PER_PAGE = 8;

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

function titleFromSlug(url = "") {
  try {
    const parsed = new URL(url);
    const lastSegment = parsed.pathname.split("/").filter(Boolean).pop() || "";
    return cleanText(
      decodeURIComponent(lastSegment)
        .replace(/\.(html?|php|aspx?)$/i, "")
        .replace(/[-_]+/g, " ")
        .replace(/\b\w/g, (char) => char.toUpperCase())
    );
  } catch {
    return "";
  }
}

function getLeadName(child = {}, page = {}) {
  const anchor = normalizeAnchorText(child);
  if (anchor && !/\b(apply|apply online|apply today|learn more|read more|click here|website|official website)\b/i.test(anchor)) {
    return anchor;
  }
  const slugTitle = titleFromSlug(getChildUrl(child));
  if (slugTitle) return slugTitle;
  return cleanText(page?.title || "");
}

function isGenericAdviceOrSearchChild(child = {}) {
  const combined = `${normalizeAnchorText(child)} ${getChildUrl(child)}`.toLowerCase();
  return /\b(essay|essays|application process|how to apply|find a scholarship|find scholarships|scholarship search|search tool|finder|directory|category|tag|submission form|submit a scholarship|scholarship applications?|types of scholarships|scholarship rules?|rules|guidelines?|what is|guide|resources?|blog|article|national scholarship month|success stories|winner|winners|book a demo|verify your scholarship|scholarship providers?|for scholarship providers)\b/.test(combined);
}

function isNavigationalOrPortalChild(child = {}) {
  const combined = `${normalizeAnchorText(child)} ${getChildUrl(child)}`.toLowerCase();
  return /\b(donate|donation|mentor|mentorship|internship|research program|program administration|about|contact|privacy|policy|terms|login|log in|sign in|sign-in|portal|return to application|make a gift|give now|cart|volunteer|get involved|committee)\b/.test(combined);
}

function isReferralOrTrackingChild(child = {}) {
  const combined = `${getChildUrl(child)} ${normalizeAnchorText(child)}`.toLowerCase();
  return /\b(referral|refer\.|affiliate|adcampaign|adnetwork|utm_source|utm_medium|utm_campaign|clickid|coupon|promo|giveaway)\b/.test(combined);
}

function isStageMismatchChild(child = {}, studentStage = "") {
  if (!/\b(starting_college|incoming|freshman|high school senior|12th)\b/i.test(cleanText(studentStage))) {
    return false;
  }
  const combined = `${normalizeAnchorText(child)} ${getChildUrl(child)}`.toLowerCase();
  if (/\bhigh school seniors?\b/.test(combined)) return false;
  return /\b(graduate students?|graduate program|sophomores?|juniors?|seniors?|upperclassmen|4[- ]?year baccalaureate)\b/.test(combined);
}

function getDomainParts(domain = "") {
  return cleanText(domain).toLowerCase().split(".").filter(Boolean);
}

function getBaseDomain(domain = "") {
  const parts = getDomainParts(domain);
  if (parts.length <= 2) return parts.join(".");
  return parts.slice(-2).join(".");
}

function isSameOrganizationDomain(left = "", right = "") {
  const leftBase = getBaseDomain(left);
  const rightBase = getBaseDomain(right);
  return Boolean(leftBase && rightBase && leftBase === rightBase);
}

function isApplicationOnlyChild(child = {}) {
  const anchor = normalizeAnchorText(child);
  const url = getChildUrl(child);
  return /\b(apply|apply online|apply today|application)\b/i.test(anchor)
    && !/\b(scholarship|award|grant|fellowship)\b/i.test(`${anchor} ${url}`);
}

function isScholarshipLikeChild(child = {}) {
  const combined = `${normalizeAnchorText(child)} ${getChildUrl(child)}`.toLowerCase();
  return Boolean(
    child?.detailPathLikely
    || /\b(scholarship|award|grant|fellowship)\b/.test(combined)
  );
}

function isOfficialSourceLikely(child = {}, page = {}) {
  const pageSignals = page?.pageSignals || {};
  const sourceDomain = cleanText(page?.sourceDomain || "").toLowerCase();
  const childDomain = cleanText(child?.sourceDomain || "").toLowerCase();
  if (isReferralOrTrackingChild(child)) {
    return false;
  }
  if (pageSignals.aggregatorSummarySignal && childDomain && !isSameOrganizationDomain(childDomain, sourceDomain) && !isGenericAdviceOrSearchChild(child)) {
    return true;
  }
  if (!child?.sameDomain && !isSameOrganizationDomain(childDomain, sourceDomain) && /\b(official|source|sponsor|apply|application|website)\b/i.test(normalizeAnchorText(child))) {
    return true;
  }
  return false;
}

function inferSourceType(page = {}) {
  const pageSignals = page?.pageSignals || {};
  if (pageSignals.aggregatorSummarySignal) return "aggregator_hub";
  if (pageSignals.hubSignal || pageSignals.listSignal) return "scholarship_hub";
  if (pageSignals.directScholarshipSignal) return "mixed_candidate_page";
  return "lead_source";
}

function scoreLeadChild(child = {}, page = {}, studentStage = "") {
  const url = getChildUrl(child);
  const officialSource = isOfficialSourceLikely(child, page);
  let score = 0;
  const rejectionReasons = [];

  if (!url) {
    return { score: -100, rejected: true, reason: "Missing child URL." };
  }
  if (isNavigationalOrPortalChild(child)) {
    return {
      score: -100,
      rejected: true,
      reason: "Navigational, portal, donation, or unrelated program link."
    };
  }
  if (isGenericAdviceOrSearchChild(child)) {
    return {
      score: -100,
      rejected: true,
      reason: "Generic advice, search, provider, or directory page rather than a named scholarship lead."
    };
  }
  if (isReferralOrTrackingChild(child)) {
    return {
      score: -100,
      rejected: true,
      reason: "Referral, affiliate, provider, or tracking link rather than a stable scholarship lead."
    };
  }
  if (isStageMismatchChild(child, studentStage)) {
    return {
      score: -100,
      rejected: true,
      reason: "Child link appears targeted to later college or graduate students rather than incoming college freshmen."
    };
  }
  if (child?.seenRecently) {
    rejectionReasons.push("Already seen recently.");
    score -= 4;
  }

  if (officialSource) score += 7;
  if (isScholarshipLikeChild(child)) score += child?.detailPathLikely ? 5 : 3;
  if (child?.sameDomain) score += page?.pageSignals?.aggregatorSummarySignal ? -1 : 1;
  if (/\.edu$/i.test(cleanText(child?.sourceDomain || ""))) score += 0.25;
  if (isApplicationOnlyChild(child) && !officialSource) {
    rejectionReasons.push("Application-only link without scholarship identity.");
    score -= 3;
  }

  if (score < 2) {
    return {
      score,
      rejected: true,
      reason: rejectionReasons[0] || "Child does not look like a named scholarship lead."
    };
  }

  return {
    score,
    rejected: false,
    reason: officialSource
      ? "Looks like an official-source or application path worth verifying."
      : "Looks like a named scholarship lead worth verifying."
  };
}

function buildLead(child = {}, page = {}, scoreResult = {}) {
  const pageSignals = page?.pageSignals || {};
  const fitSignals = page?.fitSignals || {};
  const officialSource = isOfficialSourceLikely(child, page);
  const aggregatorDerived = Boolean(pageSignals.aggregatorSummarySignal || pageSignals.indirectContentSignal);
  const sourceFitSignalsMayNotApply = Boolean(aggregatorDerived);
  const schoolSpecificLikely = Boolean(fitSignals.specificSchoolSignal || child?.sameDomain && /\.edu$/i.test(cleanText(child?.sourceDomain || "")));
  return {
    leadName: getLeadName(child, page),
    leadUrl: getChildUrl(child),
    sourceUrl: getPageUrl(page),
    leadType: officialSource ? "official_source" : "scholarship_detail",
    verificationPriority: scoreResult.score >= 7 ? "high" : scoreResult.score >= 4 ? "medium" : "low",
    needsSourceVerification: Boolean(aggregatorDerived && !officialSource),
    needsEligibilityVerification: true,
    isOfficialSourceLikely: officialSource,
    fitSignals: {
      stageLikely: Boolean(!sourceFitSignalsMayNotApply && fitSignals.stageMatchSignal),
      majorLikely: Boolean(!sourceFitSignalsMayNotApply && fitSignals.majorMatchSignal),
      ethnicityLikely: Boolean(!sourceFitSignalsMayNotApply && fitSignals.ethnicityMatchSignal),
      stateLikely: Boolean(!sourceFitSignalsMayNotApply && fitSignals.stateMatchSignal),
      schoolSpecificLikely,
      evidenceSource: sourceFitSignalsMayNotApply ? "aggregator_page_context_only" : "source_page_context"
    },
    riskSignals: {
      staleLikely: Boolean(page?.blockers?.pastCycleSignal || page?.blockers?.closedSignal),
      genericAdviceLikely: isGenericAdviceOrSearchChild(child),
      applicationPortalLikely: isApplicationOnlyChild(child) && !officialSource,
      mixedPageLikely: Boolean(pageSignals.directScholarshipSignal && (pageSignals.hubSignal || pageSignals.listSignal)),
      sourceFitSignalsMayNotApply
    },
    rationale: scoreResult.reason
  };
}

function buildRejectedChild(child = {}, scoreResult = {}) {
  return {
    url: getChildUrl(child),
    reason: scoreResult.reason || "Child link is weaker than selected lead paths."
  };
}

export function extractCandidateLeadsFromHubs({
  pageBundles = [],
  profile = {},
  studentStage = "",
  remainingBudget = {},
  maxLeadsPerPage = DEFAULT_MAX_LEADS_PER_PAGE,
  maxTotalLeads = DEFAULT_MAX_TOTAL_LEADS
} = {}) {
  const pages = Array.isArray(pageBundles) ? pageBundles : [];
  if (pages.length === 0) {
    throw new Error("pageBundles must be a non-empty array");
  }

  const pageLeadCap = Math.max(1, clampCount(maxLeadsPerPage, DEFAULT_MAX_LEADS_PER_PAGE));
  const budgetCap = clampCount(remainingBudget?.pages, DEFAULT_MAX_TOTAL_LEADS) || DEFAULT_MAX_TOTAL_LEADS;
  const totalLeadCap = Math.max(1, Math.min(clampCount(maxTotalLeads, DEFAULT_MAX_TOTAL_LEADS) || DEFAULT_MAX_TOTAL_LEADS, budgetCap));
  const leadGroups = [];
  const notes = [];
  let remainingTotalLeadSlots = totalLeadCap;

  for (const page of pages) {
    const sourceUrl = getPageUrl(page);
    if (!sourceUrl || remainingTotalLeadSlots <= 0) break;
    const childLinks = Array.isArray(page?.childLinks) ? page.childLinks : [];
    const blockers = page?.blockers || {};
    const pageSignals = page?.pageSignals || {};
    const rejectedChildren = [];
    const scoredLeads = [];

    if (blockers.accessBlockedSignal || ((blockers.closedSignal || blockers.pastCycleSignal) && childLinks.length === 0)) {
      leadGroups.push({
        sourceUrl,
        sourceType: inferSourceType(page),
        leads: [],
        rejectedChildren: [],
        rationale: blockers.accessBlockedSignal
          ? "Source page has access-blocker signals, so leads were not extracted."
          : "Source page has stale or closed signals and no child links to verify separately."
      });
      continue;
    }

    for (const child of childLinks) {
      const scoreResult = scoreLeadChild(child, page, studentStage);
      if (scoreResult.rejected) {
        if (rejectedChildren.length < MAX_REJECTED_CHILDREN_PER_PAGE) {
          rejectedChildren.push(buildRejectedChild(child, scoreResult));
        }
        continue;
      }
      scoredLeads.push({
        child,
        score: scoreResult.score,
        scoreResult
      });
    }

    const leads = scoredLeads
      .sort((left, right) => right.score - left.score)
      .slice(0, Math.min(pageLeadCap, remainingTotalLeadSlots))
      .map((item) => buildLead(item.child, page, item.scoreResult));

    remainingTotalLeadSlots -= leads.length;
    if (scoredLeads.length > leads.length) {
      notes.push(`leads_clamped_for_source=${sourceUrl}`);
    }

    leadGroups.push({
      sourceUrl,
      sourceType: inferSourceType(page),
      leads,
      rejectedChildren,
      rationale: leads.length > 0
        ? blockers.closedSignal || blockers.pastCycleSignal
          ? "Extracted named scholarship leads despite source-level stale or closed signals because child links may be distinct opportunities."
          : "Extracted named scholarship leads worth verifying from this source page."
        : pageSignals.originalSourceLinkSignal
          ? "Source page signaled original-source links, but no child link looked like a named scholarship lead."
          : "No child links looked like named scholarship leads worth verifying."
    });
  }

  const selectedLeadUrls = leadGroups.flatMap((group) => group.leads.map((lead) => lead.leadUrl));
  if (selectedLeadUrls.length >= totalLeadCap) {
    notes.push(`total_leads_clamped=${totalLeadCap}`);
  }

  return {
    leadGroups,
    selectedLeadUrls,
    notes,
    metadata: {
      mode: "deterministic",
      pageBundleCount: pages.length,
      selectedLeadCount: selectedLeadUrls.length,
      maxLeadsPerPage: pageLeadCap,
      maxTotalLeads: totalLeadCap,
      studentStage: cleanText(studentStage),
      profileSignals: {
        intendedMajor: cleanText(profile?.personalInfo?.intendedMajor || ""),
        ethnicity: cleanText(profile?.personalInfo?.ethnicity || ""),
        state: cleanText(profile?.personalInfo?.state || "")
      }
    }
  };
}
