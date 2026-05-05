import { processSessionDocuments } from "../pipeline/processSessionDocuments.js";
import {
  loadDiscoveryUrlHistory,
  normalizeDiscoveryUrl,
  shouldSkipUrlByHistory,
  upsertDiscoveryUrlHistory
} from "./discoveryHistoryStore.js";

const BRAVE_SEARCH_ENDPOINT = String(process.env.DISCOVERY_SEARCH_ENDPOINT || "https://api.search.brave.com/res/v1/web/search").trim();
const SEARCH_USER_AGENT = "ScholarshipBot/0.1 (+deterministic-discovery)";
const DEFAULT_FETCH_TIMEOUT_MS = 12000;
const DEFAULT_FETCH_RETRIES = 1;
const DEFAULT_SEARCH_CONCURRENCY = 2;
const DEFAULT_PAGE_CONCURRENCY = 4;
const MAX_SEARCH_RESULTS_PER_QUERY = 20;
const MAX_PAGE_HTML_LENGTH = 350000;
const MAX_PAGE_TEXT_LENGTH = 60000;
const MAX_REQUIREMENT_SENTENCES = 8;
const MAX_LIST_CHILDREN_PER_PAGE = 12;
const MAX_EXPANDED_CHILD_URLS = 48;
const MAX_EXPANDED_CHILD_URLS_DEPTH_1 = 16;
const MAX_EXPANDED_CHILD_URLS_DEPTH_2_PLUS = 32;
const MAX_EXPANDED_CHILD_URLS_DEPTH_3_MANUAL = 12;
const MAX_EXPANDED_CHILD_URLS_PER_DOMAIN_PER_DEPTH = 4;
const DEFAULT_MAX_LIST_EXPANSION_DEPTH = 2;
const MAX_HISTORY_REVISIT_PER_PASS = 6;
const MIN_FRESH_START_FRONTIER = 6;
const DEFAULT_DISCOVERY_QUERY_BUDGET = 12;
const SPECIFIC_FIT_RESULTS_PER_QUERY = 10;
const BROAD_FIT_RESULTS_PER_QUERY = 14;
const GENERIC_WIDENING_RESULTS_PER_QUERY = 18;
const MAX_TOP_LEVEL_DIRECT_FETCHES = 18;
const MAX_TOP_LEVEL_PROGRAM_HUB_FETCHES = 6;
const MAX_TOP_LEVEL_LIST_FETCHES = 8;
const MAX_TOP_LEVEL_OTHER_FETCHES = 6;

const MAJOR_RULES = [
  { pattern: /\bmechanical engineering\b/i, values: ["mechanical engineering", "engineering"] },
  { pattern: /\belectrical engineering\b/i, values: ["electrical engineering", "engineering"] },
  { pattern: /\bcivil engineering\b/i, values: ["civil engineering", "engineering"] },
  { pattern: /\bbiomedical engineering\b/i, values: ["biomedical engineering", "engineering"] },
  { pattern: /\bchemical engineering\b/i, values: ["chemical engineering", "engineering"] },
  { pattern: /\baerospace engineering\b/i, values: ["aerospace engineering", "engineering"] },
  { pattern: /\bengineering\b/i, values: ["engineering"] },
  { pattern: /\bcomputer science\b|\bsoftware engineering\b|\binformatics\b/i, values: ["computer science"] },
  { pattern: /\bmathematics\b|\bmath\b/i, values: ["mathematics"] },
  { pattern: /\bphysics\b/i, values: ["physics"] },
  { pattern: /\bchemistry\b/i, values: ["chemistry"] },
  { pattern: /\bbiology\b|\bbiological sciences?\b/i, values: ["biology"] },
  { pattern: /\bnursing\b/i, values: ["nursing"] },
  { pattern: /\bmedicine\b|\bmedical\b|\bpre[- ]?med\b/i, values: ["medicine"] },
  { pattern: /\bbusiness\b|\bentrepreneurship\b/i, values: ["business"] },
  { pattern: /\bfinance\b/i, values: ["finance"] },
  { pattern: /\baccounting\b/i, values: ["accounting"] },
  { pattern: /\beconomics\b/i, values: ["economics"] },
  { pattern: /\beducation\b|\bteaching\b/i, values: ["education"] },
  { pattern: /\bpsychology\b/i, values: ["psychology"] },
  { pattern: /\bjournalism\b|\bcommunications?\b/i, values: ["journalism", "communications"] },
  { pattern: /\barts?\b|\bfine arts?\b|\bvisual arts?\b/i, values: ["arts"] },
  { pattern: /\bstem\b/i, values: ["engineering", "computer science", "mathematics", "physics", "chemistry", "biology"] }
];

const ETHNICITY_RULES = [
  { pattern: /\bhispanic\b|\blatino\b|\blatina\b|\blatinx\b/i, values: ["hispanic", "latino", "latinx"] },
  { pattern: /\bblack\b|\bafrican american\b/i, values: ["black", "african american"] },
  { pattern: /\basian\b|\basian american\b/i, values: ["asian", "asian american"] },
  { pattern: /\bnative american\b|\bindigenous\b|\bamerican indian\b/i, values: ["native american", "indigenous"] },
  { pattern: /\bpacific islander\b|\bnative hawaiian\b/i, values: ["pacific islander", "native hawaiian"] },
  { pattern: /\bmiddle eastern\b|\bmena\b/i, values: ["middle eastern"] }
];

const STATE_ENTRIES = [
  ["AL", "Alabama"],
  ["AK", "Alaska"],
  ["AZ", "Arizona"],
  ["AR", "Arkansas"],
  ["CA", "California"],
  ["CO", "Colorado"],
  ["CT", "Connecticut"],
  ["DE", "Delaware"],
  ["FL", "Florida"],
  ["GA", "Georgia"],
  ["HI", "Hawaii"],
  ["ID", "Idaho"],
  ["IL", "Illinois"],
  ["IN", "Indiana"],
  ["IA", "Iowa"],
  ["KS", "Kansas"],
  ["KY", "Kentucky"],
  ["LA", "Louisiana"],
  ["ME", "Maine"],
  ["MD", "Maryland"],
  ["MA", "Massachusetts"],
  ["MI", "Michigan"],
  ["MN", "Minnesota"],
  ["MS", "Mississippi"],
  ["MO", "Missouri"],
  ["MT", "Montana"],
  ["NE", "Nebraska"],
  ["NV", "Nevada"],
  ["NH", "New Hampshire"],
  ["NJ", "New Jersey"],
  ["NM", "New Mexico"],
  ["NY", "New York"],
  ["NC", "North Carolina"],
  ["ND", "North Dakota"],
  ["OH", "Ohio"],
  ["OK", "Oklahoma"],
  ["OR", "Oregon"],
  ["PA", "Pennsylvania"],
  ["RI", "Rhode Island"],
  ["SC", "South Carolina"],
  ["SD", "South Dakota"],
  ["TN", "Tennessee"],
  ["TX", "Texas"],
  ["UT", "Utah"],
  ["VT", "Vermont"],
  ["VA", "Virginia"],
  ["WA", "Washington"],
  ["WV", "West Virginia"],
  ["WI", "Wisconsin"],
  ["WY", "Wyoming"],
  ["DC", "District of Columbia"]
];

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeText(value) {
  return cleanText(value).toLowerCase();
}

function normalizeSearchPhrase(value) {
  return cleanText(value)
    .replace(/\bB\.?\s*S\.?\b/gi, "")
    .replace(/\bB\.?\s*A\.?\b/gi, "")
    .replace(/\bBachelor(?:'s)?\b/gi, "")
    .replace(/[().,/]/g, " ")
    .replace(/\s+[.-]\s*$/g, "")
    .replace(/\s+[.-]\s+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueStrings(values) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const cleaned = cleanText(value);
    if (!cleaned) {
      continue;
    }
    const key = cleaned.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(cleaned);
  }
  return output;
}

function capitalizeToken(token) {
  return token ? token.charAt(0).toUpperCase() + token.slice(1).toLowerCase() : "";
}

function formatDomainLabel(hostname) {
  const normalized = String(hostname || "").replace(/^www\./i, "");
  const root = normalized.split(".").slice(0, -1).join(" ") || normalized;
  return root
    .split(/[-\s]+/)
    .filter(Boolean)
    .map(capitalizeToken)
    .join(" ");
}

function normalizeStateValue(value) {
  const raw = cleanText(value);
  if (!raw) {
    return "";
  }

  const upper = raw.toUpperCase();
  for (const [abbr, name] of STATE_ENTRIES) {
    if (upper === abbr || normalizeText(raw) === name.toLowerCase()) {
      return abbr;
    }
  }

  return upper.length === 2 ? upper : raw;
}

function getStageSearchTerms(studentStage, gradeLevel) {
  const normalizedStage = normalizeText(studentStage);
  const normalizedGrade = normalizeText(gradeLevel);

  if (normalizedStage === "starting_college") {
    return ["incoming college freshman", "high school senior", "first year college"];
  }
  if (normalizedStage === "in_college") {
    return ["undergraduate", "college student", "university student"];
  }
  if (normalizedStage === "transfering_college") {
    return ["transfer student", "college transfer", "undergraduate transfer"];
  }
  if (normalizedGrade.includes("12")) {
    return ["high school senior", "incoming college freshman"];
  }
  if (normalizedGrade.includes("11")) {
    return ["high school junior scholarship", "high school scholarship"];
  }
  return ["college scholarship", "student scholarship", "undergraduate scholarship"];
}

function allocateDiscoveryQueryBudget(maxQueries = 6, { manualRerun = false, freshStart = false } = {}) {
  const total = Math.max(1, Number(maxQueries) || 1);
  if (total <= 2) {
    return {
      specificFit: Math.min(1, total),
      broadFit: Math.max(0, total - 1),
      genericWidening: 0
    };
  }
  if (total <= 4) {
    return {
      specificFit: 2,
      broadFit: Math.max(1, total - 3),
      genericWidening: 1
    };
  }

  const aggressive = manualRerun || freshStart;
  const specificRatio = aggressive ? 0.42 : 0.5;
  const broadRatio = aggressive ? 0.33 : 0.3;
  let specificFit = Math.max(3, Math.round(total * specificRatio));
  let broadFit = Math.max(2, Math.round(total * broadRatio));
  let genericWidening = Math.max(1, total - specificFit - broadFit);

  while ((specificFit + broadFit + genericWidening) > total) {
    if (specificFit > broadFit && specificFit > 3) {
      specificFit -= 1;
    } else if (broadFit > 2) {
      broadFit -= 1;
    } else if (genericWidening > 1) {
      genericWidening -= 1;
    } else {
      break;
    }
  }

  while ((specificFit + broadFit + genericWidening) < total) {
    if (aggressive && genericWidening <= broadFit) {
      genericWidening += 1;
    } else if (broadFit <= specificFit) {
      broadFit += 1;
    } else {
      specificFit += 1;
    }
  }

  return {
    specificFit,
    broadFit,
    genericWidening
  };
}

function buildDiscoveryQueryFamilies({ profile, studentStage = "", discoveryDomains = [] }) {
  const personal = profile?.personalInfo || {};
  const academics = profile?.academics || {};
  const major = normalizeSearchPhrase(personal.intendedMajor);
  const ethnicity = normalizeSearchPhrase(personal.ethnicity);
  const state = normalizeStateValue(personal.state);
  const gradeLevel = cleanText(academics.gradeLevel);
  const normalizedStage = normalizeText(studentStage);
  const isStartingCollege = normalizedStage === "starting_college" || normalizeText(gradeLevel).includes("12");
  const stageTerms = getStageSearchTerms(studentStage, gradeLevel);
  const majorTerms = uniqueStrings([
    major,
    major ? major.replace(/\b(major|degree)\b/gi, "").trim() : ""
  ]);
  const ethnicityTerms = uniqueStrings([
    ethnicity,
    ethnicity.split(/\s+/)
  ].flat());

  const createFamilyBuilder = () => {
    const values = [];
    const push = (value) => {
      const cleaned = cleanText(value);
      if (!cleaned) {
        return;
      }
      if (values.some((item) => item.toLowerCase() === cleaned.toLowerCase())) {
        return;
      }
      values.push(cleaned);
    };
    return { values, push };
  };

  const specificFitFamily = createFamilyBuilder();
  const broadFitFamily = createFamilyBuilder();
  const genericFamily = createFamilyBuilder();
  const pushSpecific = specificFitFamily.push;
  const pushBroad = broadFitFamily.push;
  const pushGeneric = genericFamily.push;

  // Specific-fit family: strong niche alignment.
  if (majorTerms[0] && stageTerms[0]) pushSpecific(`${majorTerms[0]} scholarship ${stageTerms[0]}`);
  if (majorTerms[0] && state && stageTerms[0]) pushSpecific(`${majorTerms[0]} scholarship ${state} ${stageTerms[0]}`);
  if (ethnicityTerms[0] && majorTerms[0] && stageTerms[0]) pushSpecific(`${ethnicityTerms[0]} ${majorTerms[0]} scholarship ${stageTerms[0]}`);
  if (majorTerms[0]) pushSpecific(`${majorTerms[0]} scholarship incoming freshman`);
  if (majorTerms[0]) pushSpecific(`${majorTerms[0]} scholarship first-year student`);
  if (majorTerms[0] && state) pushSpecific(`${majorTerms[0]} scholarship ${state} incoming freshman`);
  if (ethnicityTerms[0] && majorTerms[0]) pushSpecific(`${ethnicityTerms[0]} ${majorTerms[0]} incoming freshman scholarship`);
  if (majorTerms[0] && stageTerms[2]) pushSpecific(`${majorTerms[0]} scholarship ${stageTerms[2]}`);
  if (ethnicityTerms[0] && stageTerms[2]) pushSpecific(`${ethnicityTerms[0]} scholarship ${stageTerms[2]}`);

  // Broad-fit family: relevant but less niche-constrained.
  if (isStartingCollege) {
    if (majorTerms[0] && stageTerms[0]) pushBroad(`${majorTerms[0]} scholarships ${stageTerms[0]}`);
    if (majorTerms[0] && stageTerms[0]) pushBroad(`${stageTerms[0]} ${majorTerms[0]} scholarship`);
    if (ethnicityTerms[0] && stageTerms[0]) pushBroad(`${ethnicityTerms[0]} scholarship ${stageTerms[0]}`);
    if (state && stageTerms[0]) pushBroad(`${state} ${stageTerms[0]} scholarship`);
    if (majorTerms[0] && stageTerms[1]) pushBroad(`${majorTerms[0]} scholarship ${stageTerms[1]}`);
    if (majorTerms[0] && state && stageTerms[1]) pushBroad(`${majorTerms[0]} scholarship ${state} ${stageTerms[1]}`);
    if (ethnicityTerms[0] && majorTerms[0] && stageTerms[1]) pushBroad(`${ethnicityTerms[0]} ${majorTerms[0]} scholarship ${stageTerms[1]}`);
    if (ethnicityTerms[0] && state && stageTerms[0]) pushBroad(`${ethnicityTerms[0]} scholarship ${state} ${stageTerms[0]}`);
    if (majorTerms[0] && stageTerms[2]) pushBroad(`${majorTerms[0]} scholarship ${stageTerms[2]}`);
    if (state && stageTerms[2]) pushBroad(`${state} ${stageTerms[2]} scholarship`);
    if (majorTerms[0] && state) pushBroad(`${majorTerms[0]} scholarship ${state} first-year student`);
    if (majorTerms[0]) pushBroad(`${majorTerms[0]} STEM scholarship ${stageTerms[0]}`);
    if (ethnicityTerms[0] && majorTerms[0]) pushBroad(`${ethnicityTerms[0]} ${majorTerms[0]} scholarship`);
    if (ethnicityTerms[0] && state) pushBroad(`${ethnicityTerms[0]} STEM scholarship ${state} ${stageTerms[0]}`);
    if (state && stageTerms[1]) pushBroad(`${state} ${stageTerms[1]} scholarship`);
    if (stageTerms[0]) pushBroad(`STEM scholarship ${stageTerms[0]}`);
    if (state) pushBroad(`college freshman scholarship ${state}`);
  } else {
    if (majorTerms[0]) pushBroad(`${majorTerms[0]} undergraduate scholarship`);
    if (majorTerms[0] && state) pushBroad(`${majorTerms[0]} undergraduate scholarship ${state}`);
    if (majorTerms[0] && stageTerms[0]) pushBroad(`${majorTerms[0]} scholarships ${stageTerms[0]}`);
    if (majorTerms[0] && stageTerms[0]) pushBroad(`${stageTerms[0]} ${majorTerms[0]} scholarship`);
    if (ethnicityTerms[0] && stageTerms[0]) pushBroad(`${ethnicityTerms[0]} scholarship ${stageTerms[0]}`);
    if (state && stageTerms[0]) pushBroad(`${state} ${stageTerms[0]} scholarship`);
    if (majorTerms[0] && stageTerms[1]) pushBroad(`${majorTerms[0]} scholarship ${stageTerms[1]}`);
    if (majorTerms[0] && state && stageTerms[1]) pushBroad(`${majorTerms[0]} scholarship ${state} ${stageTerms[1]}`);
    if (ethnicityTerms[0] && majorTerms[0] && stageTerms[1]) pushBroad(`${ethnicityTerms[0]} ${majorTerms[0]} scholarship ${stageTerms[1]}`);
    if (ethnicityTerms[0] && state && stageTerms[0]) pushBroad(`${ethnicityTerms[0]} scholarship ${state} ${stageTerms[0]}`);
    if (majorTerms[0] && stageTerms[2]) pushBroad(`${majorTerms[0]} scholarship ${stageTerms[2]}`);
    if (state && stageTerms[2]) pushBroad(`${state} ${stageTerms[2]} scholarship`);
    if (majorTerms[0]) pushBroad(`${majorTerms[0]} scholarship undergraduate freshman`);
    if (majorTerms[0] && state) pushBroad(`${majorTerms[0]} scholarship ${state} first-year student`);
    if (majorTerms[0]) pushBroad(`${majorTerms[0]} STEM scholarship`);
    if (ethnicityTerms[0] && majorTerms[0]) pushBroad(`${ethnicityTerms[0]} ${majorTerms[0]} scholarship`);
    if (ethnicityTerms[0] && state) pushBroad(`${ethnicityTerms[0]} STEM scholarship ${state}`);
    if (state && stageTerms[1]) pushBroad(`${state} ${stageTerms[1]} scholarship`);
  }

  // Generic widening family: intentionally broad, low-restriction opportunities.
  if (isStartingCollege) {
    if (stageTerms[0]) pushGeneric(`${stageTerms[0]} scholarship`);
    if (state && stageTerms[0]) pushGeneric(`${state} ${stageTerms[0]} no essay scholarship`);
    if (state) pushGeneric(`${state} college freshman scholarship`);
    pushGeneric("no essay scholarship incoming freshman");
    pushGeneric("scholarship open to all majors incoming freshman");
    pushGeneric("easy apply scholarship incoming freshman");
    pushGeneric("college freshman no essay scholarship");
    pushGeneric("STEM scholarship incoming freshman");
    pushGeneric("high school senior scholarship");
    pushGeneric("college freshman scholarship");
  } else {
    if (stageTerms[0]) pushGeneric(`${stageTerms[0]} scholarship`);
    if (state && stageTerms[0]) pushGeneric(`${state} ${stageTerms[0]} no essay scholarship`);
    if (state) pushGeneric(`${state} no essay scholarship`);
    pushGeneric("no essay scholarship undergraduate");
    pushGeneric("no essay scholarship incoming freshman");
    pushGeneric("scholarship open to all majors undergraduate");
    pushGeneric("easy apply scholarship undergraduate");
    pushGeneric("general undergraduate scholarship");
    pushGeneric("college freshman no essay scholarship");
    pushGeneric("STEM scholarship open to all majors");
    pushGeneric("scholarship open to all students");
    pushGeneric("college scholarship application");
  }

  const allBaseQueries = [
    ...specificFitFamily.values,
    ...broadFitFamily.values,
    ...genericFamily.values
  ];
  const hintedDomains = uniqueStrings(discoveryDomains).slice(0, 3);
  for (const domain of hintedDomains) {
    for (const query of allBaseQueries.slice(0, Math.max(2, Math.ceil(allBaseQueries.length / Math.max(hintedDomains.length, 1))))) {
      if (specificFitFamily.values.length < 18) {
        pushSpecific(`site:${domain} ${query}`);
      } else if (broadFitFamily.values.length < 18) {
        pushBroad(`site:${domain} ${query}`);
      } else {
        pushGeneric(`site:${domain} ${query}`);
      }
    }
  }

  return {
    specificFit: specificFitFamily.values,
    broadFit: broadFitFamily.values,
    genericWidening: genericFamily.values
  };
}

function buildDirectLinkPriorityQueries({ profile, studentStage = "" }, strategy = "control") {
  const normalizedStrategy = normalizeText(strategy) || "control";
  if (normalizedStrategy === "control") return [];

  const personal = profile?.personalInfo || {};
  const academics = profile?.academics || {};
  const major = normalizeSearchPhrase(personal.intendedMajor);
  const ethnicity = normalizeSearchPhrase(personal.ethnicity);
  const state = normalizeStateValue(personal.state);
  const gradeLevel = cleanText(academics.gradeLevel);
  const stageTerms = getStageSearchTerms(studentStage, gradeLevel);
  const primaryStage = stageTerms[0] || "incoming college freshman";
  const majorTerms = uniqueStrings([
    major,
    major ? major.replace(/\b(major|degree)\b/gi, "").trim() : ""
  ]);
  const ethnicityTerms = uniqueStrings([
    ethnicity,
    ethnicity.split(/\s+/)
  ].flat());

  const queries = [];
  const push = (value) => {
    const cleaned = cleanText(value);
    if (!cleaned) return;
    if (queries.some((item) => item.toLowerCase() === cleaned.toLowerCase())) return;
    queries.push(cleaned);
  };
  const stateText = state === "CA" ? "California" : state;

  if (normalizedStrategy === "direct_action_mix" || normalizedStrategy === "direct_action_precision") {
    if (majorTerms[0]) push(`${majorTerms[0]} scholarship apply ${primaryStage}`);
    if (majorTerms[0]) push(`${majorTerms[0]} scholarship deadline ${primaryStage}`);
    if (majorTerms[0]) push(`${majorTerms[0]} scholarship eligibility ${primaryStage}`);
    if (majorTerms[0]) push(`${majorTerms[0]} scholarship award ${primaryStage}`);
    if (majorTerms[0] && state) push(`${state} ${majorTerms[0]} scholarship apply ${primaryStage}`);
    if (ethnicityTerms[0] && majorTerms[0]) push(`${ethnicityTerms[0]} ${majorTerms[0]} scholarship apply ${primaryStage}`);
    if (ethnicityTerms[0]) push(`${ethnicityTerms[0]} STEM scholarship deadline ${primaryStage}`);
    push(`${primaryStage} scholarship apply`);
  }

  if (normalizedStrategy === "singular_detail_mix") {
    if (majorTerms[0]) push(`${majorTerms[0]} scholarship ${primaryStage}`);
    if (majorTerms[0]) push(`${majorTerms[0]} scholarship incoming freshman`);
    if (majorTerms[0]) push(`${majorTerms[0]} scholarship deadline incoming freshman`);
    if (majorTerms[0]) push(`${majorTerms[0]} scholarship eligibility incoming freshman`);
    if (majorTerms[0] && state) push(`${state} ${majorTerms[0]} scholarship incoming freshman`);
    if (ethnicityTerms[0] && majorTerms[0]) push(`${ethnicityTerms[0]} ${majorTerms[0]} scholarship incoming freshman`);
    if (ethnicityTerms[0]) push(`${ethnicityTerms[0]} scholarship incoming freshman`);
    push("incoming freshman scholarship apply");
  }

  if (normalizedStrategy === "control_plus_singular") {
    if (majorTerms[0]) push(`${majorTerms[0]} scholarship ${primaryStage}`);
    if (majorTerms[0] && state) push(`${majorTerms[0]} scholarship ${state} ${primaryStage}`);
    if (ethnicityTerms[0] && majorTerms[0]) push(`${ethnicityTerms[0]} ${majorTerms[0]} scholarship ${primaryStage}`);
    if (majorTerms[0]) push(`${majorTerms[0]} scholarship incoming freshman`);
    if (majorTerms[0]) push(`${majorTerms[0]} scholarship first-year student`);
    if (majorTerms[0] && primaryStage) push(`${primaryStage} ${majorTerms[0]} scholarship`);
    if (ethnicityTerms[0]) push(`${ethnicityTerms[0]} scholarship ${primaryStage}`);
    push(`${primaryStage} scholarship`);
    if (majorTerms[0]) push(`${majorTerms[0]} award incoming freshman`);
    if (stateText) push(`${stateText} engineering scholarship incoming freshman`);
  }

  if (normalizedStrategy === "singular_synonym_mix") {
    if (majorTerms[0]) push(`${majorTerms[0]} scholarship incoming freshman`);
    if (majorTerms[0]) push(`${majorTerms[0]} award incoming freshman`);
    if (majorTerms[0]) push(`${majorTerms[0]} grant incoming freshman`);
    if (ethnicityTerms[0] && majorTerms[0]) push(`${ethnicityTerms[0]} ${majorTerms[0]} scholarship incoming freshman`);
    if (ethnicityTerms[0]) push(`${ethnicityTerms[0]} engineering award incoming freshman`);
    if (stateText) push(`${stateText} engineering scholarship incoming freshman`);
    if (majorTerms[0]) push(`incoming freshman scholarship ${majorTerms[0]}`);
    if (majorTerms[0]) push(`first-year student ${majorTerms[0]} scholarship`);
    push("incoming freshman STEM scholarship");
    if (ethnicityTerms[0]) push(`${ethnicityTerms[0]} scholarship incoming freshman`);
  }

  if (normalizedStrategy === "detail_phrase_mix") {
    if (majorTerms[0]) push(`${majorTerms[0]} scholarship incoming freshman`);
    if (majorTerms[0]) push(`${majorTerms[0]} scholarship deadline incoming freshman`);
    if (majorTerms[0]) push(`${majorTerms[0]} scholarship eligibility incoming freshman`);
    if (majorTerms[0]) push(`${majorTerms[0]} scholarship award incoming freshman`);
    if (ethnicityTerms[0] && majorTerms[0]) push(`${ethnicityTerms[0]} ${majorTerms[0]} scholarship incoming freshman`);
    if (ethnicityTerms[0]) push(`${ethnicityTerms[0]} scholarship deadline incoming freshman`);
    if (stateText) push(`${stateText} engineering scholarship incoming freshman`);
    push("incoming freshman scholarship apply");
    push("first-year student scholarship engineering");
    push("incoming freshman STEM scholarship");
  }

  return queries;
}

function buildDiscoveryQueries({
  profile,
  studentStage = "",
  maxQueries = 6,
  discoveryDomains = [],
  manualRerun = false,
  freshStart = false,
  strategy = "control"
}) {
  const queryFamilies = buildDiscoveryQueryFamilies({ profile, studentStage, discoveryDomains });
  const budget = allocateDiscoveryQueryBudget(maxQueries, { manualRerun, freshStart });
  const directPriorityQueries = buildDirectLinkPriorityQueries({ profile, studentStage }, strategy);
  const normalizedStrategy = normalizeText(strategy) || "control";
  const queries = [];
  const push = (value) => {
    const cleaned = cleanText(value);
    if (!cleaned) {
      return;
    }
    if (queries.some((item) => item.toLowerCase() === cleaned.toLowerCase())) {
      return;
    }
    queries.push(cleaned);
  };
  directPriorityQueries.forEach(push);
  queryFamilies.specificFit.slice(0, budget.specificFit).forEach(push);
  queryFamilies.broadFit.slice(0, budget.broadFit).forEach(push);
  if (normalizedStrategy !== "singular_detail_mix") {
    queryFamilies.genericWidening.slice(0, budget.genericWidening).forEach(push);
  }

  return queries.slice(0, Math.max(1, maxQueries));
}

function buildDomainFeedbackStats(existingCandidates = []) {
  const stats = new Map();
  for (const candidate of existingCandidates || []) {
    const domain = String(candidate?.sourceDomain || "").replace(/^www\./i, "").toLowerCase();
    if (!domain) {
      continue;
    }
    const current = stats.get(domain) || {
      approved: 0,
      rejected: 0,
      submitted: 0,
      pending: 0
    };
    const status = String(candidate?.status || "pending");
    if (status === "approved") current.approved += 1;
    else if (status === "rejected") current.rejected += 1;
    else if (status === "submitted") current.submitted += 1;
    else current.pending += 1;
    stats.set(domain, current);
  }
  return stats;
}

function buildRecentDomainYieldStats(urlHistory, { withinHours = 24 * 14 } = {}) {
  const now = Date.now();
  const stats = new Map();
  for (const record of urlHistory?.values?.() || []) {
    const fetchedAtMs = Date.parse(String(record?.lastFetchedAt || ""));
    if (!Number.isFinite(fetchedAtMs)) {
      continue;
    }
    if ((now - fetchedAtMs) > (withinHours * 60 * 60 * 1000)) {
      continue;
    }
    const domain = String(record?.sourceDomain || "").replace(/^www\./i, "");
    if (!domain) {
      continue;
    }
    const current = stats.get(domain) || {
      direct: 0,
      list: 0,
      other: 0,
      fetchError: 0
    };
    const pageType = String(record?.pageType || "");
    if (pageType === "direct_scholarship") current.direct += 1;
    else if (pageType === "scholarship_list_page") current.list += 1;
    else if (pageType === "fetch_error") current.fetchError += 1;
    else current.other += 1;
    stats.set(domain, current);
  }
  return stats;
}

function scoreDomainFeedback(domain, domainFeedbackStats, recentDomainYieldStats = new Map()) {
  const normalizedDomain = String(domain || "").replace(/^www\./i, "").toLowerCase();
  const stats = domainFeedbackStats?.get(normalizedDomain);
  const yieldStats = recentDomainYieldStats?.get(normalizedDomain);

  let score = 0;
  if (stats) {
    const positive = (stats.approved * 1.5) + (stats.submitted * 2) + (stats.pending * 0.1);
    const negative = stats.rejected * 2.5;
    score += Math.max(-6, Math.min(6, positive - negative));
    if ((stats.rejected || 0) >= ((stats.approved || 0) + (stats.submitted || 0) + (stats.pending || 0) + 2)) {
      score -= 2;
    }
  }

  if (yieldStats) {
    if ((yieldStats.list || 0) >= 6 && (yieldStats.direct || 0) === 0) {
      score -= 4;
    } else if ((yieldStats.list || 0) >= Math.max(4, (yieldStats.direct || 0) * 4)) {
      score -= 2.5;
    }
    if ((yieldStats.fetchError || 0) >= 3) {
      score -= 1.5;
    }
  }

  return Math.max(-8, Math.min(6, score));
}

function getRecentHistoryDomainCounts(urlHistory, { withinHours = 24 * 14 } = {}) {
  const now = Date.now();
  const counts = new Map();
  for (const record of urlHistory?.values?.() || []) {
    const fetchedAtMs = Date.parse(String(record?.lastFetchedAt || ""));
    if (!Number.isFinite(fetchedAtMs)) {
      continue;
    }
    if ((now - fetchedAtMs) > (withinHours * 60 * 60 * 1000)) {
      continue;
    }
    const domain = String(record?.sourceDomain || "").replace(/^www\./i, "");
    if (!domain) {
      continue;
    }
    const pageType = String(record?.pageType || "");
    if (!["direct_scholarship", "scholarship_list_page"].includes(pageType)) {
      continue;
    }
    counts.set(domain, (counts.get(domain) || 0) + 1);
  }
  return counts;
}

function diversifyQueriesWithHistory(queries, {
  urlHistory,
  domainFeedbackStats = new Map(),
  studentStage = "",
  maxQueries = 6,
  logs = []
} = {}) {
  const baseQueries = uniqueStrings(queries);
  if (baseQueries.length === 0) {
    return baseQueries;
  }

  const domainCounts = getRecentHistoryDomainCounts(urlHistory);
  const avoidDomains = [...domainCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([domain]) => domain)
    .slice(0, 2);
  const feedbackAvoidDomains = [...domainFeedbackStats.entries()]
    .filter(([, stats]) => (stats.rejected || 0) >= 2 && (stats.approved || 0) === 0 && (stats.submitted || 0) === 0)
    .sort((a, b) => (b[1].rejected || 0) - (a[1].rejected || 0) || a[0].localeCompare(b[0]))
    .map(([domain]) => domain)
    .slice(0, 2);
  const combinedAvoidDomains = uniqueStrings([...avoidDomains, ...feedbackAvoidDomains]).slice(0, 3);

  const diversified = [];
  const push = (value) => {
    const cleaned = cleanText(value);
    if (!cleaned) return;
    if (diversified.some((item) => item.toLowerCase() === cleaned.toLowerCase())) return;
    diversified.push(cleaned);
  };

  const reservedVariantSlots = combinedAvoidDomains.length + (normalizeText(studentStage) === "starting_college" ? 1 : 0);
  const keepBaseCount = Math.max(1, maxQueries - reservedVariantSlots);
  baseQueries.slice(0, keepBaseCount).forEach(push);

  for (let index = 0; index < combinedAvoidDomains.length && diversified.length < maxQueries; index += 1) {
    const domain = combinedAvoidDomains[index];
    const sourceQuery = baseQueries[index % baseQueries.length] || baseQueries[0];
    push(`${sourceQuery} -site:${domain}`);
  }

  if (normalizeText(studentStage) === "starting_college" && diversified.length < maxQueries) {
    const sourceQuery = baseQueries[0];
    push(`${sourceQuery} -graduate -fellowship -phd -masters`);
  }

  if (combinedAvoidDomains.length > 0) {
    logs.push(`[query-diversify] avoiding_recent_domains=${combinedAvoidDomains.join(",")}`);
  }

  return diversified.slice(0, Math.max(1, maxQueries));
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)));
}

function stripTags(html) {
  return String(html || "").replace(/<[^>]+>/g, " ");
}

function htmlToText(html) {
  const withoutScripts = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr)>/gi, "\n");
  return cleanText(decodeHtmlEntities(stripTags(withoutScripts))).slice(0, MAX_PAGE_TEXT_LENGTH);
}

function extractMetaContent(html, attrName, attrValue) {
  const regex = new RegExp(
    `<meta[^>]+${attrName}=["']${attrValue}["'][^>]+content=["']([^"']+)["'][^>]*>`,
    "i"
  );
  const match = String(html || "").match(regex);
  return cleanText(decodeHtmlEntities(match?.[1] || ""));
}

function extractDocumentTitle(html) {
  const explicit = extractMetaContent(html, "property", "og:title") || extractMetaContent(html, "name", "twitter:title");
  if (explicit) {
    return explicit;
  }
  const titleMatch = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return cleanText(decodeHtmlEntities(titleMatch?.[1] || ""));
}

function extractHeading(html) {
  const h1Match = String(html || "").match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  return cleanText(decodeHtmlEntities(stripTags(h1Match?.[1] || "")));
}

function splitIntoSentences(text) {
  return String(text || "")
    .replace(/\r/g, "\n")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((part) => cleanText(part))
    .filter((part) => part.length >= 20);
}

function extractRequirementSentences(text) {
  const sentences = splitIntoSentences(text);
  const explicitRequirementCue = /\b(must|must be|must have|required|requirements?|criteria|eligible|eligibility|open to|restricted to|limited to|only for|minimum|at least|residents? of|citizens?|gpa)\b/i;
  const subjectRequirementCue = /\b(applicants?|candidates?|students?)\b/i;
  const structuredEligibilityDetail = /\b(major|majoring|degree|studying|study|enrolled|resident|citizen|gpa|background|ethnicity|race|state)\b/i;
  const matches = sentences.filter((sentence) => (
    explicitRequirementCue.test(sentence)
      || (subjectRequirementCue.test(sentence) && structuredEligibilityDetail.test(sentence) && /\b(must|eligible|open to|required|minimum|at least)\b/i.test(sentence))
  ));
  return matches.slice(0, MAX_REQUIREMENT_SENTENCES);
}

function parseCurrencyValue(value) {
  const numeric = Number(String(value || "").replace(/[$,]/g, ""));
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return numeric > 0 && numeric <= 250000 ? numeric : null;
}

function extractAwardAmount(text) {
  const contextualRegexes = [
    /(?:award(?:ed)?|scholarship(?: award)?|grant|fellowship|receive(?:s|d)?|worth|amount|up to)[^$\n]{0,40}(\$\s?\d[\d,]*(?:\.\d{2})?)/gi,
    /(\$\s?\d[\d,]*(?:\.\d{2})?)[^.\n]{0,40}(?:award|scholarship|grant|fellowship)/gi
  ];
  const values = [];
  for (const regex of contextualRegexes) {
    for (const match of text.matchAll(regex)) {
      const amount = parseCurrencyValue(match[1]);
      if (amount !== null) {
        values.push(amount);
      }
    }
  }

  if (values.length === 0) {
    for (const match of text.matchAll(/\$\s?\d[\d,]*(?:\.\d{2})?/g)) {
      const amount = parseCurrencyValue(match[0]);
      if (amount !== null) {
        values.push(amount);
      }
    }
  }

  if (values.length === 0) {
    return 0;
  }

  return Math.max(...values);
}

function normalizeDateString(raw) {
  const value = cleanText(raw);
  if (!value) {
    return "";
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }
  if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(value)) {
    const [month, day, year] = value.split("/");
    const normalizedYear = year.length === 2 ? `20${year}` : year;
    return `${normalizedYear.padStart(4, "0")}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }
  const monthNameMatch = value.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4})$/);
  if (monthNameMatch) {
    const parsed = new Date(`${monthNameMatch[1]} ${monthNameMatch[2]}, ${monthNameMatch[3]}`);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString().slice(0, 10);
    }
  }
  if (!/\d{4}/.test(value)) {
    return "";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }
  return parsed.toISOString().slice(0, 10);
}

function isExpiredIsoDeadline(value) {
  const deadline = cleanText(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline)) {
    return false;
  }
  const today = new Date().toISOString().slice(0, 10);
  return deadline < today;
}

function extractDeadline(text) {
  const patterns = [
    /(?:deadline|apply by|applications?\s+due|due date|submission deadline)[^.\n:]{0,40}?[:\-]?\s*\b([A-Z][a-z]{2,8}\s+\d{1,2},\s+\d{4})\b/i,
    /(?:deadline|apply by|applications?\s+due|due date|submission deadline)[^.\n:]{0,40}?[:\-]?\s*\b(\d{1,2}\/\d{1,2}\/\d{2,4})\b/i,
    /(?:deadline|apply by|applications?\s+due|due date|submission deadline)[^.\n:]{0,40}?[:\-]?\s*\b([A-Z][a-z]{2,8}\s+\d{1,2})\b/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return normalizeDateString(match[1]);
    }
  }

  return "";
}

function extractMinGpa(text) {
  const patterns = [
    /(?:minimum|required|at least)[^.\n]{0,24}(\d\.\d{1,2})\s*gpa/i,
    /gpa[^.\n]{0,24}(?:minimum|required|at least)[^.\n]{0,12}(\d\.\d{1,2})/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const value = Number(match[1]);
      if (Number.isFinite(value)) {
        return value;
      }
    }
  }
  return null;
}

function collectMatchesFromRules(text, rules) {
  const values = [];
  for (const rule of rules) {
    if (rule.pattern.test(text)) {
      values.push(...rule.values);
    }
  }
  return uniqueStrings(values);
}

function extractMajors(text) {
  return collectMatchesFromRules(text, MAJOR_RULES);
}

function extractEthnicities(text) {
  return collectMatchesFromRules(text, ETHNICITY_RULES);
}

function extractStates(text) {
  const normalized = ` ${String(text || "")} `;
  const matches = [];
  for (const [abbr, name] of STATE_ENTRIES) {
    const namePattern = new RegExp(`\\b${name.replace(/\s+/g, "\\s+")}\\b`, "i");
    const abbrPattern = new RegExp(`\\b${abbr}\\b`, "i");
    if (namePattern.test(normalized) || abbrPattern.test(normalized)) {
      matches.push(abbr);
    }
  }
  return uniqueStrings(matches);
}

function extractAgeBounds(text) {
  const minMatch = text.match(/(?:at least|minimum age|must be)\s+(\d{1,2})\s+years?\s+old/i);
  const maxMatch = text.match(/(?:under|no older than|maximum age|up to)\s+(\d{1,2})\s+years?\s+old/i);
  return {
    minAge: minMatch ? Number(minMatch[1]) : null,
    maxAge: maxMatch ? Number(maxMatch[1]) : null
  };
}

function extractRequiredStudentStages(statements, title = "") {
  const relevantText = [
    /\b(high school|freshman|first[- ]year|undergraduate|graduate|junior|senior|sophomore|college student|university student)\b/i.test(title)
      ? title
      : "",
    ...(Array.isArray(statements) ? statements : [])
  ].filter(Boolean).join(" ");

  if (!relevantText) {
    return [];
  }

  const requiredStages = [];

  if (/\b(graduate|graduate students?|doctoral|doctorate|phd|masters?|master'?s|grad(?:uate)? school)\b/i.test(relevantText)) {
    requiredStages.push("graduate");
  }
  if (/\b(high school students?|high school senior(?:s)?|secondary school students?)\b/i.test(relevantText)) {
    requiredStages.push("high_school");
  }
  if (/\b(incoming (?:college )?freshm(?:a)?n|entering (?:college )?freshm(?:a)?n|entering first[- ]year|incoming first[- ]year|first[- ]year college|college freshmen?|entering students?)\b/i.test(relevantText)) {
    requiredStages.push("incoming_freshman");
  }
  if (/\b(undergraduate students?|undergraduate student|college students?|university students?)\b/i.test(relevantText)) {
    requiredStages.push("undergraduate");
  }
  if (/\b(sophomores?|juniors?|seniors?|upperclass(?:men)?|currently enrolled|current undergraduate students?|current college students?|students? enrolled at|attending (?:a |an )?(?:college|university)|enrolled (?:within|at|in) (?:a |an )?(?:college|university|school)|college student member)\b/i.test(relevantText)) {
    requiredStages.push("continuing_college");
  }

  return uniqueStrings(requiredStages);
}

function normalizeProfileStudentStage(studentStage = "", gradeLevel = "") {
  const normalizedStage = normalizeText(studentStage);
  if (normalizedStage) {
    return normalizedStage;
  }

  const normalizedGrade = normalizeText(gradeLevel);
  if (!normalizedGrade) {
    return "";
  }
  if (/\b(12th|high school senior|grade 12|senior)\b/.test(normalizedGrade)) {
    return "starting_college";
  }
  if (/\b(9th|10th|11th|high school|junior in high school|sophomore in high school)\b/.test(normalizedGrade)) {
    return "pre_college";
  }
  if (/\b(college|undergraduate|freshman in college|sophomore|junior|senior in college|transfer)\b/.test(normalizedGrade)) {
    return "in_college";
  }
  return "";
}

function extractRequirementText(statements, predicate) {
  return (Array.isArray(statements) ? statements : [])
    .filter((sentence) => predicate.test(sentence))
    .join(" ");
}

function extractEssayPrompts(text) {
  const prompts = [];
  for (const sentence of splitIntoSentences(text)) {
    if (!/\b(essay|personal statement|describe|tell us|explain)\b/i.test(sentence)) {
      continue;
    }
    if (sentence.length > 260) {
      prompts.push(`${sentence.slice(0, 257)}...`);
    } else {
      prompts.push(sentence);
    }
  }
  return uniqueStrings(prompts).slice(0, 3);
}

function detectRequiresAccount(text) {
  return /\b(create an account|sign in to apply|log in to apply|login to apply|register to apply|application portal)\b/i.test(text);
}

function detectClosedScholarship(text, title) {
  const value = `${title}\n${text}`;
  return /\b(applications? closed|deadline has passed|no longer accepting applications|scholarship closed|closed for this cycle)\b/i.test(value);
}

function countMatches(value, regex) {
  const matches = String(value || "").match(regex);
  return matches ? matches.length : 0;
}

function parseUrlSafely(value) {
  try {
    return new URL(String(value || ""));
  } catch {
    return null;
  }
}

function isLikelyScholarshipDetailPath(pathname) {
  const path = String(pathname || "").toLowerCase();
  if (!path || path === "/") {
    return false;
  }
  if (/\/(by-major|by-state|types|type|category|categories|directory|financial-aid)\//i.test(path)) {
    return false;
  }
  if (/\/scholarships\/search\/[^/]+\/?$/i.test(path)) {
    return true;
  }
  if (/\/scholarships?\/[^/]+\/?$/i.test(path) && !/\/scholarships?\/?(?:$|search\/?$)/i.test(path)) {
    return true;
  }
  return /\/(?:award|grant|fellowship|scholarship)-[a-z0-9-]+\/?$/i.test(path);
}

function getExpansionBudgetForDepth(depth) {
  if (depth <= 1) {
    return MAX_EXPANDED_CHILD_URLS_DEPTH_1;
  }
  if (depth === 2) {
    return MAX_EXPANDED_CHILD_URLS_DEPTH_2_PLUS;
  }
  return MAX_EXPANDED_CHILD_URLS_DEPTH_3_MANUAL;
}

function scoreScholarshipLinkCandidate({ anchorText, pathname }) {
  const anchor = String(anchorText || "");
  const path = String(pathname || "");
  const combined = `${anchor} ${path}`;
  let score = 0;

  if (/\bscholarship\b/i.test(anchor)) {
    score += 3;
  }
  if (/\baward\b|\bgrant\b/i.test(anchor)) {
    score += 2;
  }
  if (/\bfellowship\b/i.test(anchor)) {
    score += 1;
  }
  if (isLikelyScholarshipDetailPath(path)) {
    score += 4;
  }
  if (/\/scholarships?\//i.test(path)) {
    score += 2;
  }
  if (/\/search\//i.test(path)) {
    score += 1;
  }
  if (anchor && !/\bscholarships\b/i.test(anchor)) {
    score += 1;
  }
  if (/\b(high school|freshman|first[- ]year|undergraduate|college)\b/i.test(combined)) {
    score += 1.5;
  }
  if (/\b(graduate|doctoral|doctorate|phd|masters?|fellowships?)\b/i.test(combined)) {
    score -= 2.5;
  }
  if (/\bscholarships\b/i.test(anchor)) {
    score -= 1;
  }

  return score;
}

function extractLikelyScholarshipLinks(html, baseUrl) {
  let parsedBaseUrl;
  try {
    parsedBaseUrl = new URL(String(baseUrl || ""));
  } catch {
    return [];
  }

  const links = [];
  const regex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  let position = 0;
  while ((match = regex.exec(String(html || "")))) {
    position += 1;
    const href = cleanText(decodeHtmlEntities(match[1]));
    const anchorText = cleanText(decodeHtmlEntities(stripTags(match[2])));
    if (!href || /^#|^javascript:|^mailto:|^tel:/i.test(href)) {
      continue;
    }

    let resolved;
    try {
      resolved = new URL(href, parsedBaseUrl);
    } catch {
      continue;
    }

    if (!/^https?:$/i.test(resolved.protocol)) {
      continue;
    }
    if (resolved.hostname !== parsedBaseUrl.hostname) {
      continue;
    }
    if (resolved.toString() === parsedBaseUrl.toString()) {
      continue;
    }

    const combined = `${anchorText} ${resolved.pathname}`;
    if (!/\b(scholarship|award|fellowship|grant)\b/i.test(combined)) {
      continue;
    }
    if (/\.(pdf|docx?|xlsx?)$/i.test(resolved.pathname)) {
      continue;
    }
    if (/\b(top scholarships|best scholarships|browse scholarships|scholarship list|directory|login|sign in|privacy|terms|contact|about|faq|blog)\b/i.test(combined)) {
      continue;
    }

    const score = scoreScholarshipLinkCandidate({
      anchorText,
      pathname: resolved.pathname
    });

    links.push({
      url: resolved.toString(),
      anchorText,
      score,
      position
    });
  }

  const bestByUrl = new Map();
  for (const item of links) {
    const existing = bestByUrl.get(item.url);
    if (!existing || existing.score < item.score) {
      bestByUrl.set(item.url, item);
    }
  }

  return [...bestByUrl.values()]
    .sort((a, b) => b.score - a.score || a.position - b.position)
    .slice(0, MAX_LIST_CHILDREN_PER_PAGE)
    .map((item) => item.url);
}

function looksLikeListPage(title, url, text, html = "") {
  const value = `${title}\n${url}\n${text}`;
  const urlLower = String(url || "").toLowerCase();
  const titleLower = String(title || "").toLowerCase();
  const textLower = String(text || "").toLowerCase();
  const parsedUrl = parseUrlSafely(url);
  const pathname = String(parsedUrl?.pathname || "").toLowerCase();
  const childLinkCount = extractLikelyScholarshipLinks(html, url).length;
  const detailPath = isLikelyScholarshipDetailPath(pathname);

  const explicitListPattern = /\b(top \d+|best scholarships|list of scholarships|scholarships for students|scholarship directory|roundup|browse scholarships|scholarship lists?)\b/i;
  if (explicitListPattern.test(value)) {
    return true;
  }

  if (/^\/?$/.test(pathname) && childLinkCount >= 3 && countMatches(textLower, /\bscholarship\b/g) >= 3) {
    return true;
  }

  if (/\/scholarships?\/?$/.test(pathname) || /\/scholarships\/scholarships\/?$/.test(pathname)) {
    return true;
  }

  if (/\/(by-major|by-state|types|type|category|categories|directory|financial-aid)\//i.test(pathname)) {
    return true;
  }

  if (/^(engineering scholarships|available scholarships|high school scholarships|scholarships for entering|top scholarships in .+|.+ scholarships - .+)$/i.test(title)) {
    return true;
  }

  const pluralScholarshipTitle = /\bscholarships\b/i.test(titleLower);
  const pluralScholarshipPath = /\/scholarships\/|[-_/]scholarships(?:[-_/]|$)/i.test(urlLower);
  const likelyApplicationPage = /\b(apply|application|guidelines|eligibility|program)\b/i.test(value);
  if ((pluralScholarshipTitle || pluralScholarshipPath) && (!detailPath || childLinkCount >= 2) && !likelyApplicationPage) {
    return true;
  }

  if ((pluralScholarshipTitle || pluralScholarshipPath) && childLinkCount >= 3) {
    return true;
  }

  const currencyMentions = countMatches(textLower, /\$\s?\d[\d,]*(?:\.\d{2})?/g);
  const deadlineMentions = countMatches(textLower, /\b(deadline|apply by|applications due|due date)\b/g);
  const scholarshipMentions = countMatches(textLower, /\bscholarship\b/g);
  const linkMentions = countMatches(String(html || ""), /<a\b/gi);

  if (currencyMentions >= 3 || deadlineMentions >= 3) {
    return true;
  }
  if (scholarshipMentions >= 8 && linkMentions >= 12) {
    return true;
  }

  return false;
}

function looksLikeScholarshipPage({
  title,
  url,
  text,
  html,
  awardAmount,
  deadline,
  requirementStatements,
  skipListPageCheck = false
}) {
  const signalText = `${title}\n${url}\n${text}`;
  const parsedUrl = parseUrlSafely(url);
  const pathname = String(parsedUrl?.pathname || "").toLowerCase();
  const detailPath = isLikelyScholarshipDetailPath(pathname);
  const singularTitle = /\b(scholarship|grant|fellowship|award)\b/i.test(title) && !/\bscholarships\b/i.test(title);
  const applicationSignals = /\b(apply|application deadline|how to apply|eligibility requirements?)\b/i.test(signalText);
  let signals = 0;
  if (/\b(scholarship|grant|fellowship|award|tuition assistance)\b/i.test(signalText)) {
    signals += 1;
  }
  if (singularTitle) {
    signals += 1;
  }
  if (detailPath) {
    signals += 1;
  }
  if (awardAmount > 0) {
    signals += 1;
  }
  if (deadline) {
    signals += 1;
  }
  if ((requirementStatements || []).length > 0) {
    signals += 1;
  }
  if (!skipListPageCheck && looksLikeListPage(title, url, text, html)) {
    return false;
  }

  if (pathname === "/" && !singularTitle && !deadline) {
    return false;
  }

  if (!detailPath && !singularTitle && awardAmount === 0 && !deadline) {
    return false;
  }

  if (!detailPath && !singularTitle && !applicationSignals) {
    return false;
  }

  return signals >= 3;
}

function ruleMatchesValue(rule, value) {
  const normalizedRule = normalizeText(rule);
  const normalizedValue = normalizeText(value);
  if (!normalizedRule || !normalizedValue) {
    return false;
  }
  return normalizedValue === normalizedRule
    || normalizedValue.includes(normalizedRule)
    || normalizedRule.includes(normalizedValue);
}

function scoreCandidateFit({ candidate, profile, studentStage = "", searchRank = 0 }) {
  const reasons = [];
  const eligibilityBlockers = [];
  let score = 0;

  if (candidate.awardAmount > 0) {
    score += Math.min(4, Math.log10(candidate.awardAmount + 1));
    reasons.push(`award:${candidate.awardAmount}`);
  }
  if (candidate.deadline) {
    score += 0.6;
    reasons.push("deadline");
  }

  const major = profile?.personalInfo?.intendedMajor;
  const ethnicity = profile?.personalInfo?.ethnicity;
  const state = normalizeStateValue(profile?.personalInfo?.state);
  const gpa = Number(profile?.academics?.gpa);
  const normalizedStudentStage = normalizeProfileStudentStage(
    studentStage,
    profile?.academics?.gradeLevel || profile?.academics?.currentGradeLevel || ""
  );
  const requiredStudentStages = Array.isArray(candidate?.inferredRequirements?.requiredStudentStages)
    ? candidate.inferredRequirements.requiredStudentStages
    : [];

  if (candidate.eligibility.allowedMajors.length > 0) {
    if (candidate.eligibility.allowedMajors.some((rule) => ruleMatchesValue(rule, major))) {
      score += 3;
      reasons.push("major_match");
    } else {
      eligibilityBlockers.push("major_mismatch");
    }
  }

  if (candidate.eligibility.allowedEthnicities.length > 0) {
    if (candidate.eligibility.allowedEthnicities.some((rule) => ruleMatchesValue(rule, ethnicity))) {
      score += 2;
      reasons.push("ethnicity_match");
    } else {
      eligibilityBlockers.push("ethnicity_mismatch");
    }
  }

  if (candidate.inferredRequirements.requiredStates.length > 0) {
    if (candidate.inferredRequirements.requiredStates.includes(state)) {
      score += 1.5;
      reasons.push("state_match");
    } else {
      eligibilityBlockers.push("state_mismatch");
    }
  }

  if (candidate.eligibility.minGpa !== null) {
    if (Number.isFinite(gpa) && gpa >= candidate.eligibility.minGpa) {
      score += 1.2;
      reasons.push("gpa_match");
    } else {
      eligibilityBlockers.push("gpa_mismatch");
    }
  }

  if (requiredStudentStages.length > 0) {
    if (normalizedStudentStage === "starting_college") {
      if (requiredStudentStages.includes("graduate")) {
        eligibilityBlockers.push("stage_mismatch_graduate");
      } else if (requiredStudentStages.includes("continuing_college")) {
        eligibilityBlockers.push("stage_mismatch_continuing_college");
      } else if (requiredStudentStages.includes("incoming_freshman") || requiredStudentStages.includes("high_school")) {
        score += 2;
        reasons.push("stage_match");
      } else if (requiredStudentStages.includes("undergraduate")) {
        score += 0.8;
      }
    } else if (normalizedStudentStage === "in_college" || normalizedStudentStage === "transfering_college" || normalizedStudentStage === "transferring_college") {
      if (requiredStudentStages.includes("graduate")) {
        eligibilityBlockers.push("stage_mismatch_graduate");
      } else if (requiredStudentStages.includes("high_school") && !requiredStudentStages.includes("incoming_freshman") && !requiredStudentStages.includes("undergraduate")) {
        eligibilityBlockers.push("stage_mismatch_high_school");
      } else if (requiredStudentStages.includes("continuing_college") || requiredStudentStages.includes("undergraduate")) {
        score += 1.5;
        reasons.push("stage_match");
      }
    }
  }

  score += Math.max(0, 2 - (searchRank * 0.2));
  return {
    score: Number(score.toFixed(3)),
    reasons,
    isEligible: eligibilityBlockers.length === 0,
    eligibilityBlockers
  };
}

function buildCandidateFromPage({ url, html, searchResult, allowListPageOverride = false }) {
  const sourceUrl = String(url || "").trim();
  const parsedUrl = new URL(sourceUrl);
  const sourceDomain = parsedUrl.hostname.replace(/^www\./i, "");
  const text = htmlToText(html);
  const title = extractHeading(html) || extractDocumentTitle(html) || cleanText(searchResult?.title || sourceUrl);
  const requirementStatements = extractRequirementSentences(text);
  const awardAmount = extractAwardAmount(text);
  const deadline = extractDeadline(text);

  if (detectClosedScholarship(text, title)) {
    return { candidate: null, skipReason: "scholarship_closed" };
  }
  if (isExpiredIsoDeadline(deadline)) {
    return { candidate: null, skipReason: "scholarship_closed" };
  }

  if (!allowListPageOverride && looksLikeListPage(title, sourceUrl, text, html)) {
    return {
      candidate: null,
      skipReason: "scholarship_list_page",
      childUrls: extractLikelyScholarshipLinks(html, sourceUrl)
    };
  }

  if (!looksLikeScholarshipPage({
    title,
    url: sourceUrl,
    text,
    html,
    awardAmount,
    deadline,
    requirementStatements,
    skipListPageCheck: allowListPageOverride
  })) {
    return { candidate: null, skipReason: "insufficient_scholarship_signals" };
  }

  const majorRequirementText = extractRequirementText(
    requirementStatements,
    /\b(major|majoring|degree|studying|study|enrolled|pursuing)\b/i
  );
  const ethnicityRequirementText = extractRequirementText(
    requirementStatements,
    /\b(hispanic|latino|latina|latinx|black|african american|asian|asian american|native american|indigenous|american indian|pacific islander|native hawaiian|middle eastern|mena)\b/i
  );
  const stateSentences = requirementStatements.filter((sentence) => /\b(resident|residents|state|states|live in|residing)\b/i.test(sentence));
  const states = extractStates(stateSentences.join(" "));
  const { minAge, maxAge } = extractAgeBounds(requirementStatements.join(" "));
  const majors = extractMajors(majorRequirementText);
  const ethnicities = extractEthnicities(ethnicityRequirementText);
  const requiredStudentStages = extractRequiredStudentStages(requirementStatements, title);

  const candidate = {
    name: title,
    sourceDomain,
    sourceUrl,
    sourceName: formatDomainLabel(sourceDomain),
    awardAmount,
    deadline,
    requiresAccount: detectRequiresAccount(text),
    estimatedEffortMinutes: requirementStatements.length >= 5 || detectRequiresAccount(text) ? 60 : 30,
    eligibility: {
      minGpa: extractMinGpa(requirementStatements.join(" ")),
      allowedMajors: majors,
      allowedEthnicities: ethnicities
    },
    inferredRequirements: {
      requiredMajors: majors,
      requiredEthnicities: ethnicities,
      requiredStudentStages,
      requiredStates: states,
      minAge,
      maxAge,
      requirementStatements
    },
    essayPrompts: extractEssayPrompts(text)
  };

  const ambiguityFlags = [];
  if (!candidate.deadline) {
    ambiguityFlags.push("missing_deadline");
  }
  if (candidate.awardAmount === 0) {
    ambiguityFlags.push("missing_award_amount");
  }
  if (candidate.inferredRequirements.requirementStatements.length === 0) {
    ambiguityFlags.push("missing_requirement_statements");
  }

  return {
    candidate,
    skipReason: "",
    ambiguityFlags
  };
}

function parseBraveWebSearchResults(payload, query, limit = MAX_SEARCH_RESULTS_PER_QUERY) {
  const results = [];
  const webResults = Array.isArray(payload?.web?.results) ? payload.web.results : [];
  for (const item of webResults) {
    if (results.length >= limit) {
      break;
    }
    const url = cleanText(item?.url);
    const title = cleanText(item?.title);
    if (!/^https?:\/\//i.test(url) || !title) {
      continue;
    }
    results.push({
      query,
      title,
      url,
      snippet: cleanText(item?.description || item?.page_age || ""),
      rank: results.length + 1
    });
  }
  return results;
}

async function fetchText(url, {
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  headers = {}
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch implementation is required for discovery");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        "user-agent": SEARCH_USER_AGENT,
        accept: "text/html,application/xhtml+xml",
        ...headers
      },
      signal: controller.signal
    });
    const contentType = String(response.headers?.get?.("content-type") || "");
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      contentType,
      text
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, {
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  headers = {}
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch implementation is required for discovery");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        "user-agent": SEARCH_USER_AGENT,
        accept: "application/json",
        ...headers
      },
      signal: controller.signal
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = null;
    }
    return {
      ok: response.ok,
      status: response.status,
      json,
      text
    };
  } finally {
    clearTimeout(timer);
  }
}

async function mapWithConcurrency(items, concurrency, iteratee) {
  const limit = Math.max(1, concurrency || 1);
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await iteratee(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function searchQueries(queries, {
  fetchImpl = globalThis.fetch,
  perQuery = MAX_SEARCH_RESULTS_PER_QUERY,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  concurrency = DEFAULT_SEARCH_CONCURRENCY,
  logs = [],
  braveApiKey = String(process.env.BRAVE_SEARCH_API_KEY || process.env.DISCOVERY_BRAVE_API_KEY || "").trim()
} = {}) {
  if (!braveApiKey) {
    throw new Error("Brave Search API key is missing. Set BRAVE_SEARCH_API_KEY or DISCOVERY_BRAVE_API_KEY.");
  }

  const queryResults = await mapWithConcurrency(queries, concurrency, async (query) => {
    const endpoint = new URL(BRAVE_SEARCH_ENDPOINT);
    endpoint.searchParams.set("q", query);
    endpoint.searchParams.set("count", String(Math.min(20, Math.max(1, perQuery))));
    endpoint.searchParams.set("country", "US");
    endpoint.searchParams.set("search_lang", "en");
    endpoint.searchParams.set("safesearch", "moderate");

    const response = await fetchJson(endpoint, {
      fetchImpl,
      timeoutMs,
      headers: {
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": braveApiKey
      }
    });
    if (!response.ok) {
      const providerMessage = cleanText(response.json?.error?.detail || response.json?.detail || response.text);
      throw new Error(`Brave search request failed (${response.status}) for query "${query}"${providerMessage ? `: ${providerMessage}` : ""}`);
    }
    if (!response.json || typeof response.json !== "object") {
      throw new Error(`Brave search returned non-JSON response for query "${query}"`);
    }
    const parsed = parseBraveWebSearchResults(response.json, query, perQuery);
    logs.push(`[search] "${query}" -> ${parsed.length} result(s)`);
    return parsed;
  });

  return queryResults.flat();
}

async function fetchPages(urls, {
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  retries = DEFAULT_FETCH_RETRIES,
  concurrency = DEFAULT_PAGE_CONCURRENCY,
  logs = []
} = {}) {
  const uniqueUrls = uniqueStrings(urls).filter((value) => /^https?:\/\//i.test(value));
  const pages = await mapWithConcurrency(uniqueUrls, concurrency, async (url) => {
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const response = await fetchText(url, { fetchImpl, timeoutMs });
        if (!response.ok) {
          throw new Error(`status ${response.status}`);
        }
        if (response.contentType && !/html|xml/i.test(response.contentType)) {
          return { url, ok: false, error: `unsupported_content_type:${response.contentType}` };
        }
        logs.push(`[fetch] ${url}`);
        return {
          url,
          ok: true,
          html: String(response.text || "").slice(0, MAX_PAGE_HTML_LENGTH)
        };
      } catch (error) {
        lastError = error;
      }
    }
    logs.push(`[fetch-error] ${url} -> ${lastError?.message || String(lastError)}`);
    return {
      url,
      ok: false,
      error: lastError?.message || String(lastError)
    };
  });
  return pages;
}

function dedupeRankedCandidates(items) {
  const bestByKey = new Map();
  for (const item of items) {
    const candidate = item.candidate;
    const key = candidate.sourceUrl
      ? `url:${candidate.sourceUrl.toLowerCase()}`
      : `name_domain:${candidate.name.toLowerCase()}::${candidate.sourceDomain.toLowerCase()}`;
    const existing = bestByKey.get(key);
    if (!existing || existing.score < item.score) {
      bestByKey.set(key, item);
    }
  }
  return [...bestByKey.values()].sort((a, b) => b.score - a.score);
}

function formatUrlForLog(value) {
  try {
    const parsed = new URL(String(value || ""));
    return `${parsed.hostname}${parsed.pathname}`;
  } catch {
    return String(value || "");
  }
}

function buildHistoryUpdate({
  url,
  query = "",
  pageType = "unknown",
  sourceDomain = "",
  candidate = null,
  error = "",
  timestamp = new Date().toISOString()
}) {
  return {
    url,
    normalizedUrl: normalizeDiscoveryUrl(url),
    sourceDomain,
    pageType,
    lastSeenAt: timestamp,
    lastFetchedAt: pageType === "unknown" ? "" : timestamp,
    lastSearchQuery: query,
    lastError: error,
    candidateId: candidate?.id || "",
    candidateName: candidate?.name || ""
  };
}

function getHistoryRevisitPriority(pageType) {
  if (pageType === "scholarship_list_page") {
    return 0;
  }
  if (pageType === "direct_scholarship") {
    return 1;
  }
  return 9;
}

function getStagePositiveTerms(studentStage = "", gradeLevel = "") {
  const normalizedStage = normalizeText(studentStage);
  const normalizedGrade = normalizeText(gradeLevel);
  if (normalizedStage === "starting_college" || normalizedGrade.includes("12")) {
    return ["incoming college freshman", "high school senior", "first year college", "undergraduate", "freshman"];
  }
  if (normalizedStage === "in_college") {
    return ["undergraduate", "college student", "university student"];
  }
  if (normalizedStage === "transfering_college") {
    return ["transfer student", "undergraduate transfer", "college transfer"];
  }
  return ["undergraduate", "college student"];
}

function classifySearchResultSurface(result) {
  const hintedSurface = normalizeText(result?.surfaceHint || result?.kind || "");
  if (hintedSurface === "direct_scholarship") {
    return "direct_likely";
  }
  if (hintedSurface === "scholarship_program_hub") {
    return "program_hub_likely";
  }
  if (hintedSurface === "scholarship_list_page") {
    return "list_likely";
  }

  const title = cleanText(result?.title || "");
  const snippet = cleanText(result?.snippet || "");
  const parsedUrl = parseUrlSafely(result?.url || "");
  const pathname = String(parsedUrl?.pathname || "").toLowerCase();
  const combined = `${title} ${snippet} ${pathname}`;

  if (isLikelyScholarshipDetailPath(pathname)) {
    return "direct_likely";
  }
  if (/\b(top \d+|best scholarships|list of scholarships|browse scholarships|directory|roundup|scholarship lists?)\b/i.test(combined)) {
    return "list_likely";
  }
  if (/\/(by-major|by-state|types|type|category|categories|directory|financial-aid)\//i.test(pathname)) {
    return "list_likely";
  }
  if (/\bscholarships\b/i.test(title) && !/\b(apply|eligibility|deadline)\b/i.test(combined)) {
    return "list_likely";
  }
  if (/\b(scholarship|grant|award|fellowship)\b/i.test(combined) && !/\bscholarships\b/i.test(title)) {
    return "direct_likely";
  }
  return "other";
}

function scoreSearchResultFitLikelihood(result, profile = {}, studentStage = "", domainFeedbackStats = new Map(), recentDomainYieldStats = new Map()) {
  const title = cleanText(result?.title || "");
  const snippet = cleanText(result?.snippet || "");
  const parsedUrl = parseUrlSafely(result?.url || "");
  const pathname = String(parsedUrl?.pathname || "");
  const sourceDomain = String(parsedUrl?.hostname || "").replace(/^www\./i, "").toLowerCase();
  const combined = `${title}\n${snippet}\n${pathname}`;
  const surfaceType = classifySearchResultSurface(result);
  const personal = profile?.personalInfo || {};
  const academics = profile?.academics || {};
  const major = personal.intendedMajor;
  const ethnicity = personal.ethnicity;
  const state = normalizeStateValue(personal.state);
  const stageTerms = getStagePositiveTerms(studentStage, academics.gradeLevel);

  let score = 0;
  if (surfaceType === "direct_likely") {
    score += 5;
  } else if (surfaceType === "program_hub_likely") {
    score += 3.5;
  } else if (surfaceType === "list_likely") {
    score -= 2.5;
  }

  if (/\b(scholarship|grant|award|fellowship)\b/i.test(combined)) {
    score += 1.5;
  }
  if (/\b(apply|eligibility|deadline|award amount|application)\b/i.test(combined)) {
    score += 1.5;
  }
  if (/\b(blog|directory|guide|financial aid|resource center|advice)\b/i.test(combined)) {
    score -= 2;
  }

  const resultMajors = extractMajors(combined);
  if (resultMajors.some((rule) => ruleMatchesValue(rule, major))) {
    score += 4;
  } else if (resultMajors.length > 0) {
    score -= 1;
  }

  const resultEthnicities = extractEthnicities(combined);
  if (resultEthnicities.some((rule) => ruleMatchesValue(rule, ethnicity))) {
    score += 2.5;
  } else if (resultEthnicities.length > 0) {
    score -= 1.5;
  }

  const resultStates = extractStates(combined);
  if (state && resultStates.includes(state)) {
    score += 1.5;
  } else if (state && resultStates.length > 0) {
    score -= 0.5;
  }

  for (const term of stageTerms) {
    if (new RegExp(`\\b${term.replace(/\s+/g, "\\s+")}\\b`, "i").test(combined)) {
      score += 1.5;
    }
  }
  if (normalizeText(studentStage) === "starting_college" && /\b(juniors?|seniors?|sophomores?|upperclass(?:men)?|currently enrolled|current undergraduate students?|current college students?|undergraduate retention|retention grant)\b/i.test(combined)) {
    score -= 4.5;
  }
  if (normalizeText(studentStage) === "starting_college" && /\b(graduate|doctoral|doctorate|phd|masters?|grad school|fellowships?)\b/i.test(combined)) {
    score -= 5;
  }

  score += scoreDomainFeedback(sourceDomain, domainFeedbackStats, recentDomainYieldStats);

  return Number(score.toFixed(3));
}

function scoreSearchResultNovelty(result, urlHistory, recentDomainCounts) {
  const normalizedUrl = normalizeDiscoveryUrl(result?.url || "");
  const record = urlHistory?.get(normalizedUrl);
  const domain = String(parseUrlSafely(result?.url)?.hostname || "").replace(/^www\./i, "");
  const seenDomainCount = Number(recentDomainCounts?.get(domain) || 0);

  let score = 0;
  if (!record?.lastFetchedAt) {
    score += 12;
  } else {
    const fetchedAtMs = Date.parse(String(record.lastFetchedAt || ""));
    if (Number.isFinite(fetchedAtMs)) {
      const ageHours = Math.max(0, (Date.now() - fetchedAtMs) / (60 * 60 * 1000));
      score += Math.min(8, ageHours / 24);
    }
    if (record.pageType === "direct_scholarship") {
      score -= 3;
    } else if (record.pageType === "scholarship_list_page") {
      score -= 1.5;
    }
  }

  score -= Math.min(4, seenDomainCount * 0.5);

  const pathname = String(parseUrlSafely(result?.url)?.pathname || "");
  if (isLikelyScholarshipDetailPath(pathname)) {
    score += 1;
  }
  if (/\b(scholarship|grant|award|fellowship)\b/i.test(`${result?.title || ""} ${pathname}`)) {
    score += 0.5;
  }

  return score;
}

function dedupeSearchResults(results) {
  const bestByUrl = new Map();
  for (const result of results || []) {
    const key = normalizeDiscoveryUrl(result?.url || "");
    if (!key) continue;
    const existing = bestByUrl.get(key);
    if (!existing) {
      bestByUrl.set(key, result);
      continue;
    }
    if ((result.fitScore || 0) > (existing.fitScore || 0)) {
      bestByUrl.set(key, result);
      continue;
    }
    if ((result.fitScore || 0) === (existing.fitScore || 0) && (result.noveltyScore || 0) > (existing.noveltyScore || 0)) {
      bestByUrl.set(key, result);
    }
  }
  return [...bestByUrl.values()];
}

function compareDiscoverySearchResults(left, right) {
  const getSurfaceRank = (value) => {
    if (value === "direct_likely") return 0;
    if (value === "program_hub_likely") return 1;
    if (value === "list_likely") return 2;
    return 3;
  };
  return (right.fitScore || 0) - (left.fitScore || 0)
    || getSurfaceRank(left.surfaceType) - getSurfaceRank(right.surfaceType)
    || (left.passPriority || 0) - (right.passPriority || 0)
    || (right.noveltyScore || 0) - (left.noveltyScore || 0)
    || (left.globalRank || 0) - (right.globalRank || 0);
}

function rerankSearchResultsForDiscovery(results, urlHistory, profile, studentStage, logs = [], domainFeedbackStats = new Map()) {
  const recentDomainCounts = getRecentHistoryDomainCounts(urlHistory);
  const recentDomainYieldStats = buildRecentDomainYieldStats(urlHistory);
  const reranked = dedupeSearchResults([...results]
    .map((result) => ({
      ...result,
      surfaceType: classifySearchResultSurface(result),
      fitScore: scoreSearchResultFitLikelihood(result, profile, studentStage, domainFeedbackStats, recentDomainYieldStats),
      noveltyScore: scoreSearchResultNovelty(result, urlHistory, recentDomainCounts)
    }))
  )
    .sort(compareDiscoverySearchResults);

  const preview = reranked
    .slice(0, 5)
    .map((result) => `${formatUrlForLog(result.url)}:fit=${Number(result.fitScore || 0).toFixed(1)},novelty=${Number(result.noveltyScore || 0).toFixed(1)},surface=${result.surfaceType}`);
  if (preview.length > 0) {
    logs.push(`[search-rerank] top_fit=${preview.join(" | ")}`);
  }
  return reranked;
}

function buildExistingCandidateIdentitySet(existingCandidates = []) {
  const keys = new Set();
  for (const candidate of existingCandidates || []) {
    const id = cleanText(candidate?.id);
    const sourceUrl = cleanText(candidate?.sourceUrl || candidate?.source_url);
    const name = cleanText(candidate?.name || candidate?.title);
    const sourceDomain = cleanText(candidate?.sourceDomain || candidate?.source_domain).toLowerCase();
    if (id) keys.add(`id:${id}`);
    if (sourceUrl) keys.add(`url:${normalizeDiscoveryUrl(sourceUrl)}`);
    if (name && sourceDomain) keys.add(`name_domain:${name.toLowerCase()}::${sourceDomain}`);
  }
  return keys;
}

function selectInitialFrontier(results, logs = []) {
  const budgets = {
    direct_likely: MAX_TOP_LEVEL_DIRECT_FETCHES,
    program_hub_likely: MAX_TOP_LEVEL_PROGRAM_HUB_FETCHES,
    list_likely: MAX_TOP_LEVEL_LIST_FETCHES,
    other: MAX_TOP_LEVEL_OTHER_FETCHES
  };
  const selected = [];
  const selectedUrls = new Set();

  for (const result of results || []) {
    const key = normalizeDiscoveryUrl(result?.url || "");
    const surfaceType = result?.surfaceType || "other";
    if (!key || selectedUrls.has(key)) {
      continue;
    }
    if ((budgets[surfaceType] || 0) <= 0) {
      continue;
    }
    budgets[surfaceType] -= 1;
    selectedUrls.add(key);
    selected.push({
      ...result,
      expansionDepth: 0
    });
  }

  const remainingCapacity = Object.values(budgets).reduce((sum, value) => sum + value, 0);
  if (remainingCapacity > 0) {
    for (const result of results || []) {
      const key = normalizeDiscoveryUrl(result?.url || "");
      if (!key || selectedUrls.has(key)) {
        continue;
      }
      selectedUrls.add(key);
      selected.push({
        ...result,
        expansionDepth: 0
      });
      if (selected.length >= (MAX_TOP_LEVEL_DIRECT_FETCHES + MAX_TOP_LEVEL_PROGRAM_HUB_FETCHES + MAX_TOP_LEVEL_LIST_FETCHES + MAX_TOP_LEVEL_OTHER_FETCHES)) {
        break;
      }
    }
  }

  const counts = selected.reduce((acc, result) => {
    const surfaceType = result?.surfaceType || "other";
    acc[surfaceType] = (acc[surfaceType] || 0) + 1;
    return acc;
  }, {});
  logs.push(`[frontier] selected top_level direct=${counts.direct_likely || 0} program=${counts.program_hub_likely || 0} list=${counts.list_likely || 0} other=${counts.other || 0}`);
  return selected;
}

async function runSearchPasses(passConfigs, options = {}) {
  const collected = [];
  for (const passConfig of passConfigs || []) {
    const queries = Array.isArray(passConfig?.queries) ? passConfig.queries.filter(Boolean) : [];
    if (queries.length === 0) {
      continue;
    }
    options.logs?.push?.(`[search-pass] ${passConfig.name} queries=${queries.length} per_query=${passConfig.perQuery}`);
    const passResults = await searchQueries(queries, {
      ...options,
      perQuery: passConfig.perQuery
    });
    collected.push(...passResults.map((result) => ({
      ...result,
      searchPass: passConfig.name,
      passPriority: passConfig.priority
    })));
  }
  return collected;
}

function buildPageReviewSnapshot({ url, html, searchResult, extraction }) {
  const sourceUrl = String(url || "").trim();
  const parsedUrl = parseUrlSafely(sourceUrl);
  const text = htmlToText(html);
  const title = extractHeading(html) || extractDocumentTitle(html) || cleanText(searchResult?.title || sourceUrl);
  const childUrls = Array.isArray(extraction?.childUrls) && extraction.childUrls.length > 0
    ? extraction.childUrls
    : extractLikelyScholarshipLinks(html, sourceUrl);

  return {
    sourceUrl,
    title,
    pathname: String(parsedUrl?.pathname || ""),
    preliminaryDecision: extraction?.candidate ? "direct_scholarship" : extraction?.skipReason || "unknown",
    preliminarySkipReason: extraction?.skipReason || "",
    extractedCandidate: extraction?.candidate || null,
    childUrls,
    textExcerpt: text
  };
}

function shouldReviewAcceptedPageWithAi(pageReview) {
  const candidate = pageReview?.extractedCandidate;
  if (!candidate) {
    return false;
  }

  const title = String(pageReview?.title || "");
  const pathname = String(pageReview?.pathname || "").toLowerCase();
  const childLinkCount = Array.isArray(pageReview?.childUrls) ? pageReview.childUrls.length : 0;
  const singularTitle = /\b(scholarship|grant|fellowship|award)\b/i.test(title) && !/\bscholarships\b/i.test(title);
  const categoryPath = /\/(by-major|by-state|types|type|category|categories|directory|financial-aid)\//i.test(pathname)
    || /\/scholarships?\/?$/.test(pathname)
    || /\/scholarships\/scholarships\/?$/.test(pathname);
  const genericTitle = /^(engineering scholarships|available scholarships|high school scholarships|scholarships for entering|top scholarships in .+|.+ scholarships - .+|empowering courageous leaders)$/i.test(title);
  const weakFieldSignals = Number(candidate.awardAmount || 0) === 0
    && !candidate.deadline
    && (candidate.inferredRequirements?.requirementStatements?.length || 0) < 2;

  return pathname === "/"
    || categoryPath
    || genericTitle
    || (/\bscholarships\b/i.test(title) && !singularTitle)
    || childLinkCount >= 2
    || weakFieldSignals;
}

function shouldReviewRejectedListPageWithAi(pageReview) {
  if (pageReview?.preliminarySkipReason !== "scholarship_list_page") {
    return false;
  }

  const title = String(pageReview?.title || "");
  const pathname = String(pageReview?.pathname || "").toLowerCase();
  const childLinkCount = Array.isArray(pageReview?.childUrls) ? pageReview.childUrls.length : 0;
  const singularTitle = /\b(scholarship|grant|fellowship|award)\b/i.test(title) && !/\bscholarships\b/i.test(title);
  const detailPath = isLikelyScholarshipDetailPath(pathname);
  const categoryPath = /\/(by-major|by-state|types|type|category|categories|directory|financial-aid)\//i.test(pathname)
    || /\/scholarships?\/?$/.test(pathname)
    || /\/scholarships\/scholarships\/?$/.test(pathname);
  const genericTitle = /^(engineering scholarships|available scholarships|high school scholarships|scholarships for entering|top scholarships in .+|.+ scholarships - .+)$/i.test(title);
  const homepagePath = /^\/?$/.test(pathname);

  if (homepagePath || categoryPath || genericTitle) {
    return false;
  }

  if (singularTitle || detailPath) {
    return true;
  }

  return childLinkCount > 0 && childLinkCount <= 3;
}

function isPromisingListPageForDeeperExpansion({ result, pageReview, profile, studentStage }) {
  const title = cleanText(pageReview?.title || result?.title || "");
  const pathname = String(pageReview?.pathname || parseUrlSafely(result?.url)?.pathname || "").toLowerCase();
  const query = String(result?.query || "");
  const excerpt = cleanText(pageReview?.textExcerpt || result?.snippet || "");
  const combined = `${title}\n${query}\n${excerpt}\n${pathname}`.toLowerCase();
  const childUrls = Array.isArray(pageReview?.childUrls) ? pageReview.childUrls : [];
  const stageTerms = getStagePositiveTerms(studentStage, profile?.gradeLevel || profile?.currentGradeLevel || "");
  const major = cleanText(profile?.intendedMajor || profile?.major || "").toLowerCase();
  const ethnicity = cleanText(Array.isArray(profile?.ethnicity) ? profile.ethnicity.join(" ") : profile?.ethnicity || "").toLowerCase();
  const state = cleanText(profile?.state || profile?.residenceState || "").toLowerCase();

  let score = 0;

  if (childUrls.length >= 2 && childUrls.length <= 8) {
    score += 2;
  }
  if (childUrls.length > 8) {
    score += 1;
  }
  if (stageTerms.some((term) => combined.includes(term))) {
    score += 3;
  }
  if (major && combined.includes(major)) {
    score += 3;
  } else if (/\bengineering\b/.test(major) && /\bengineering\b/.test(combined)) {
    score += 2;
  }
  if (ethnicity && combined.includes(ethnicity)) {
    score += 2;
  } else if (/\bhispanic|latino|latinx\b/.test(ethnicity) && /\bhispanic|latino|latinx\b/.test(combined)) {
    score += 2;
  }
  if (state && combined.includes(state)) {
    score += 1;
  }
  if (/\/scholarships\/(search\/)?/.test(pathname)) {
    score += 1;
  }
  if (/top \d+|scholarships for|engineering scholarships|scholarships for hispanic|mechanical engineering scholarships/.test(combined)) {
    score += 1;
  }
  if (/\bgraduate|phd|doctoral|master'?s|masters|fellowship\b/.test(combined)) {
    score -= 3;
  }
  if (childUrls.length === 0) {
    score -= 4;
  }

  return score >= 5;
}

function enqueueExpandedChildUrls({
  childUrls,
  parentResult,
  expandedChildResults,
  expandedChildSeenUrls,
  fetchedSeenUrls,
  perDepthCounts,
  perDomainDepthCounts,
  nextDepth
}) {
  for (const childUrl of childUrls || []) {
    if (expandedChildSeenUrls.size >= MAX_EXPANDED_CHILD_URLS) {
      break;
    }
    const depthBudget = getExpansionBudgetForDepth(nextDepth);
    const usedAtDepth = Number(perDepthCounts.get(nextDepth) || 0);
    if (usedAtDepth >= depthBudget) {
      break;
    }
    if (expandedChildSeenUrls.has(childUrl) || fetchedSeenUrls.has(childUrl)) {
      continue;
    }
    const parsedChildUrl = parseUrlSafely(childUrl);
    const hostname = String(parsedChildUrl?.hostname || "").replace(/^www\./i, "") || "unknown";
    const domainDepthKey = `${nextDepth}:${hostname}`;
    const usedForDomainDepth = Number(perDomainDepthCounts.get(domainDepthKey) || 0);
    if (usedForDomainDepth >= MAX_EXPANDED_CHILD_URLS_PER_DOMAIN_PER_DEPTH) {
      continue;
    }
    expandedChildSeenUrls.add(childUrl);
    fetchedSeenUrls.add(childUrl);
    perDepthCounts.set(nextDepth, usedAtDepth + 1);
    perDomainDepthCounts.set(domainDepthKey, usedForDomainDepth + 1);
    expandedChildResults.push({
      query: `${parentResult.query} [list-expanded]`,
      title: "",
      url: childUrl,
      snippet: "",
      rank: expandedChildResults.length + 1,
      globalRank: parentResult.globalRank + ((expandedChildResults.length + 1) / 100),
      expansionDepth: nextDepth
    });
  }
}

async function maybeClassifyPageReviewsWithAi({
  profile,
  pageReviews,
  timeoutMs = 30000,
  logs = [],
  classifyImpl = null,
  enabled = true
} = {}) {
  if (!enabled) {
    return {
      decisionsByUrl: new Map(),
      metadata: { mode: "disabled" }
    };
  }

  const reviewSet = Array.isArray(pageReviews) ? pageReviews : [];
  if (reviewSet.length === 0) {
    return {
      decisionsByUrl: new Map(),
      metadata: { mode: "skipped", reason: "no_borderline_pages" }
    };
  }

  try {
    const classifier = classifyImpl
      || (await import("./discoveryAiAssist.js")).classifyDiscoveryPagesWithAi;
    const result = await classifier({
      profile,
      pages: reviewSet,
      timeoutMs
    });
    const decisions = Array.isArray(result?.decisions) ? result.decisions : [];
    logs.push(`[ai-page] reviewed ${reviewSet.length} borderline page(s); returned ${decisions.length} decision(s)`);
    return {
      decisionsByUrl: new Map(decisions.map((decision) => [String(decision.sourceUrl || ""), decision])),
      metadata: result?.metadata || { mode: "ai_page_classifier" }
    };
  } catch (error) {
    logs.push(`[ai-page-error] ${error?.message || String(error)}`);
    return {
      decisionsByUrl: new Map(),
      metadata: { mode: "failed", reason: error?.message || String(error) }
    };
  }
}

async function maybeRefineAmbiguousCandidatesWithAi({
  profile,
  rankedCandidates,
  timeoutMs = 45000,
  logs = []
} = {}) {
  if (String(process.env.DISCOVERY_ENABLE_AI_ASSIST || "0") !== "1") {
    return {
      candidates: rankedCandidates,
      metadata: { mode: "disabled" }
    };
  }

  const ambiguous = rankedCandidates
    .filter((item) => Array.isArray(item.ambiguityFlags) && item.ambiguityFlags.length > 0)
    .slice(0, 3);
  if (ambiguous.length === 0) {
    return {
      candidates: rankedCandidates,
      metadata: { mode: "skipped", reason: "no_ambiguous_candidates" }
    };
  }

  try {
    const { refineDiscoveryCandidatesWithAi } = await import("./discoveryAiAssist.js");
    const refined = await refineDiscoveryCandidatesWithAi({
      profile,
      candidates: ambiguous,
      timeoutMs
    });

    const updatesByUrl = new Map(refined.updatedCandidates.map((item) => [item.candidate.sourceUrl, item]));
    const merged = rankedCandidates.map((item) => updatesByUrl.get(item.candidate.sourceUrl) || item);
    logs.push(`[ai] refined ${refined.updatedCandidates.length} ambiguous candidate(s)`);
    return {
      candidates: dedupeRankedCandidates(merged),
      metadata: refined.metadata
    };
  } catch (error) {
    logs.push(`[ai-error] ${error?.message || String(error)}`);
    return {
      candidates: rankedCandidates,
      metadata: { mode: "failed", reason: error?.message || String(error) }
    };
  }
}

function shouldExpandDiscoverySearchWithAi(results = []) {
  const topResults = (results || []).slice(0, 15);
  const strongDirect = topResults.filter((item) => item.surfaceType === "direct_likely" && Number(item.fitScore || 0) >= 7).length;
  const strongPrograms = topResults.filter((item) => item.surfaceType === "program_hub_likely" && Number(item.fitScore || 0) >= 6).length;
  const highFit = topResults.filter((item) => Number(item.fitScore || 0) >= 6).length;
  const directLike = topResults.filter((item) => ["direct_likely", "program_hub_likely"].includes(item.surfaceType)).length;

  const weak = topResults.length === 0
    || (strongDirect + strongPrograms) < 3
    || highFit < 6
    || directLike < 4;

  return {
    weak,
    strongDirect,
    strongPrograms,
    highFit,
    directLike
  };
}

function shouldExpandDiscoverySearchAfterHistory(fetchableFrontier = [], skippedByHistory = [], originalFrontier = []) {
  const fetchableDirectLike = fetchableFrontier.filter((item) => ["direct_likely", "program_hub_likely"].includes(item?.surfaceType)).length;
  const fetchableListLike = fetchableFrontier.filter((item) => item?.surfaceType === "list_likely").length;
  const skippedCount = skippedByHistory.length;
  const originalCount = originalFrontier.length;

  const weak = originalCount > 0 && (
    fetchableFrontier.length === 0
    || fetchableDirectLike < 3
    || fetchableFrontier.length < 5
    || skippedCount > fetchableFrontier.length
    || (fetchableListLike >= fetchableFrontier.length && fetchableDirectLike === 0)
  );

  return {
    weak,
    originalCount,
    fetchableCount: fetchableFrontier.length,
    fetchableDirectLike,
    fetchableListLike,
    skippedByHistory: skippedCount
  };
}

async function maybeExpandSearchResultsWithAi({
  profile,
  studentStage = "",
  queries = [],
  rankedSearchResults = [],
  existingCandidates = [],
  fetchImpl = globalThis.fetch,
  searchTimeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  searchConcurrency = DEFAULT_SEARCH_CONCURRENCY,
  logs = [],
  braveApiKey = "",
  timeoutMs = 45000,
  enabled = true,
  expandImpl = null,
  force = false,
  triggerReason = "pre_frontier",
  frontierStats = null
} = {}) {
  if (!enabled) {
    return {
      additionalResults: [],
      additionalQueries: [],
      metadata: { mode: "disabled" }
    };
  }

  const expansionNeed = shouldExpandDiscoverySearchWithAi(rankedSearchResults);
  if (!force && !expansionNeed.weak) {
    logs.push(`[ai-search] skipped trigger=${triggerReason} weak_frontier=no strong_direct=${expansionNeed.strongDirect} strong_programs=${expansionNeed.strongPrograms} high_fit=${expansionNeed.highFit}`);
    return {
      additionalResults: [],
      additionalQueries: [],
      metadata: {
        mode: "skipped",
        reason: "frontier_strong_enough",
        triggerReason,
        ...expansionNeed
      }
    };
  }

  try {
    const expander = expandImpl
      || (await import("./discoveryAiAssist.js")).expandDiscoverySearchWithAi;
    const aiExpansion = await expander({
      profile,
      studentStage,
      attemptedQueries: queries,
      topSearchResults: rankedSearchResults.slice(0, 15),
      existingCandidates,
      timeoutMs
    });

    const existingQueryKeys = new Set((queries || []).map((value) => normalizeText(value)));
    const aiQueryStrings = uniqueStrings((aiExpansion?.queries || []).map((item) => item?.query))
      .filter((query) => !existingQueryKeys.has(normalizeText(query)))
      .slice(0, 6);
    const existingUrlKeys = new Set((rankedSearchResults || []).map((item) => normalizeDiscoveryUrl(item?.url || "")));
    const aiUrlSuggestions = (aiExpansion?.urls || [])
      .filter((item) => /^https?:\/\//i.test(String(item?.url || "")))
      .filter((item) => !existingUrlKeys.has(normalizeDiscoveryUrl(item.url)))
      .slice(0, 8);

    for (const note of aiExpansion?.notes || []) {
      logs.push(`[ai-search-note] ${cleanText(note)}`);
    }

    logs.push(`[ai-search] running trigger=${triggerReason} force=${force ? "yes" : "no"}`);
    const additionalResults = [];
    if (aiQueryStrings.length > 0) {
      logs.push(`[ai-search] expanding with ${aiQueryStrings.length} follow-up quer${aiQueryStrings.length === 1 ? "y" : "ies"}`);
      const aiQueryResults = await searchQueries(aiQueryStrings, {
        fetchImpl,
        perQuery: Math.min(MAX_SEARCH_RESULTS_PER_QUERY, 8),
        timeoutMs: searchTimeoutMs,
        concurrency: searchConcurrency,
        logs,
        braveApiKey
      });
      additionalResults.push(...aiQueryResults.map((result) => ({
        ...result,
        searchPass: "ai_expansion_query",
        passPriority: 2
      })));
    }

    additionalResults.push(...aiUrlSuggestions.map((item, index) => ({
      query: "[ai expansion url]",
      title: cleanText(item?.title || ""),
      url: String(item?.url || ""),
      snippet: cleanText(item?.rationale || ""),
      rank: index + 1,
      searchPass: "ai_expansion_url",
      passPriority: 1,
      surfaceHint: item?.kind || "",
      aiRationale: cleanText(item?.rationale || "")
    })));

    logs.push(`[ai-search] added ${aiQueryStrings.length} quer${aiQueryStrings.length === 1 ? "y" : "ies"} and ${aiUrlSuggestions.length} URL suggestion(s)`);

    return {
      additionalResults,
      additionalQueries: aiQueryStrings,
      metadata: {
        ...(aiExpansion?.metadata || { mode: "ai_search_expansion" }),
        triggerReason,
        ...expansionNeed,
        frontierStats,
        used: true,
        forced: force,
        suggestedQueries: aiQueryStrings.length,
        suggestedUrls: aiUrlSuggestions.length,
        resultingResults: additionalResults.length
      }
    };
  } catch (error) {
    logs.push(`[ai-search-error] ${error?.message || String(error)}`);
    return {
      additionalResults: [],
      additionalQueries: [],
      metadata: {
        mode: "failed",
        triggerReason,
        reason: error?.message || String(error)
      }
    };
  }
}

function mergeDiscoverySearchResultsWithExpansion(baseResults, additionalResults) {
  const existingNormalized = new Set((baseResults || []).map((item) => normalizeDiscoveryUrl(item?.url || "")));
  const merged = [...baseResults];
  let nextGlobalRank = merged.length + 1;
  for (const result of additionalResults || []) {
    const normalized = normalizeDiscoveryUrl(result?.url || "");
    if (!normalized || existingNormalized.has(normalized)) {
      continue;
    }
    existingNormalized.add(normalized);
    merged.push({
      ...result,
      globalRank: nextGlobalRank,
      expansionDepth: 0
    });
    nextGlobalRank += 1;
  }
  return merged;
}

export async function discoverScholarshipCandidates({
  sessionId,
  documents,
  existingCandidates = [],
  studentStage = "",
  discoveryMaxResults = 8,
  discoveryQueryBudget = DEFAULT_DISCOVERY_QUERY_BUDGET,
  discoveryDomains = [],
  fetchImpl = globalThis.fetch,
  searchTimeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  pageTimeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  pageRetries = DEFAULT_FETCH_RETRIES,
  searchConcurrency = DEFAULT_SEARCH_CONCURRENCY,
  pageConcurrency = DEFAULT_PAGE_CONCURRENCY,
  maxListExpansionDepth = DEFAULT_MAX_LIST_EXPANSION_DEPTH,
  manualRerun = false,
  freshStart = false,
  aiTimeoutMs = 45000,
  aiPageClassifierTimeoutMs = 30000,
  aiSearchExpansionTimeoutMs = 45000,
  aiSearchExpansionImpl = null,
  aiClassifyPageEvaluationsImpl = null,
  enableAiSearchExpansion = String(process.env.DISCOVERY_ENABLE_AI_SEARCH_EXPANSION || "1") !== "0" && fetchImpl === globalThis.fetch,
  enableAiPageClassifier = String(process.env.DISCOVERY_ENABLE_AI_PAGE_CLASSIFIER || "1") !== "0" && fetchImpl === globalThis.fetch,
  enableUrlHistory = String(process.env.DISCOVERY_ENABLE_URL_HISTORY || "1") !== "0" && fetchImpl === globalThis.fetch,
  braveApiKey = String(process.env.BRAVE_SEARCH_API_KEY || process.env.DISCOVERY_BRAVE_API_KEY || "").trim()
} = {}) {
  const logs = [];
  const errors = [];
  const urlHistory = enableUrlHistory ? await loadDiscoveryUrlHistory() : new Map();
  const domainFeedbackStats = buildDomainFeedbackStats(existingCandidates);
  const existingCandidateIdentities = buildExistingCandidateIdentitySet(existingCandidates);
  const ingestion = await processSessionDocuments({
    sessionId,
    documents,
    enableAiEnrichment: false
  });
  const mergedProfile = ingestion.mergedProfile || {};
  logs.push("[profile] parsed student documents");

  const queryBudget = allocateDiscoveryQueryBudget(discoveryQueryBudget, { manualRerun, freshStart });
  const queryFamilies = buildDiscoveryQueryFamilies({
    profile: mergedProfile,
    studentStage,
    discoveryDomains
  });
  const specificFitQueries = diversifyQueriesWithHistory(queryFamilies.specificFit, {
    urlHistory,
    domainFeedbackStats,
    studentStage,
    maxQueries: queryBudget.specificFit,
    logs
  }).slice(0, queryBudget.specificFit);
  const broadFitQueries = diversifyQueriesWithHistory(queryFamilies.broadFit, {
    urlHistory,
    domainFeedbackStats,
    studentStage,
    maxQueries: queryBudget.broadFit,
    logs
  }).slice(0, queryBudget.broadFit);
  const genericWideningQueries = diversifyQueriesWithHistory(queryFamilies.genericWidening, {
    urlHistory,
    domainFeedbackStats,
    studentStage,
    maxQueries: queryBudget.genericWidening,
    logs
  }).slice(0, queryBudget.genericWidening);
  const queries = uniqueStrings([
    ...specificFitQueries,
    ...broadFitQueries,
    ...genericWideningQueries
  ]).slice(0, Math.max(1, discoveryQueryBudget));
  logs.push(`[query] generated ${queries.length} search quer${queries.length === 1 ? "y" : "ies"}`);
  logs.push(`[query-allocation] specific_fit=${specificFitQueries.length} broad_fit=${broadFitQueries.length} generic_widening=${genericWideningQueries.length}`);

  const searchPassConfigs = [
    {
      name: "specific_fit",
      priority: 0,
      queries: specificFitQueries,
      perQuery: Math.min(MAX_SEARCH_RESULTS_PER_QUERY, Math.max(SPECIFIC_FIT_RESULTS_PER_QUERY, discoveryMaxResults))
    },
    {
      name: "broad_fit",
      priority: 1,
      queries: broadFitQueries,
      perQuery: Math.min(MAX_SEARCH_RESULTS_PER_QUERY, Math.max(BROAD_FIT_RESULTS_PER_QUERY, discoveryMaxResults))
    },
    {
      name: "generic_widening",
      priority: 2,
      queries: genericWideningQueries,
      perQuery: Math.min(MAX_SEARCH_RESULTS_PER_QUERY, Math.max(GENERIC_WIDENING_RESULTS_PER_QUERY, discoveryMaxResults))
    }
  ];

  let searchResults = [];
  const aiSearchExpansionAttempts = [];
  let aiSearchExpansionMetadata = { mode: "skipped", reason: "not_attempted", attempts: aiSearchExpansionAttempts };
  try {
    searchResults = await runSearchPasses(searchPassConfigs, {
      fetchImpl,
      timeoutMs: searchTimeoutMs,
      concurrency: searchConcurrency,
      logs,
      braveApiKey
    });
  } catch (error) {
    throw new Error(`discovery search failed: ${error?.message || String(error)}`);
  }

  const rankedSearchResults = searchResults.map((result, index) => ({
    ...result,
    globalRank: index + 1,
    expansionDepth: 0
  }));
  let discoveryQueries = [...queries];
  let searchUniverseResults = rankedSearchResults;
  let discoveryRankedSearchResults = rerankSearchResultsForDiscovery(
    rankedSearchResults,
    urlHistory,
    mergedProfile,
    studentStage,
    logs,
    domainFeedbackStats
  );
  const aiSearchExpansion = await maybeExpandSearchResultsWithAi({
    profile: mergedProfile,
    studentStage,
    queries: discoveryQueries,
    rankedSearchResults: discoveryRankedSearchResults,
    existingCandidates,
    fetchImpl,
    searchTimeoutMs,
    searchConcurrency,
    logs,
    braveApiKey,
    timeoutMs: aiSearchExpansionTimeoutMs,
    enabled: enableAiSearchExpansion,
    expandImpl: aiSearchExpansionImpl,
    triggerReason: "pre_frontier"
  });
  aiSearchExpansionAttempts.push(aiSearchExpansion.metadata);
  if (aiSearchExpansion.additionalQueries.length > 0) {
    discoveryQueries = uniqueStrings([...discoveryQueries, ...aiSearchExpansion.additionalQueries]);
  }
  if (aiSearchExpansion.additionalResults.length > 0) {
    const combinedSearchResults = mergeDiscoverySearchResultsWithExpansion(
      searchUniverseResults,
      aiSearchExpansion.additionalResults
    );
    searchUniverseResults = combinedSearchResults;
    discoveryRankedSearchResults = rerankSearchResultsForDiscovery(
      combinedSearchResults,
      urlHistory,
      mergedProfile,
      studentStage,
      logs,
      domainFeedbackStats
    );
  }
  aiSearchExpansionMetadata = {
    ...(aiSearchExpansion.metadata || {}),
    attempts: aiSearchExpansionAttempts
  };
  const initialFrontier = selectInitialFrontier(discoveryRankedSearchResults, logs);
  logs.push(`[search] collected ${discoveryRankedSearchResults.length} raw URL candidate(s)`);
  const historyTimestamp = new Date().toISOString();
  const historyUpdates = enableUrlHistory
    ? discoveryRankedSearchResults.map((result) => ({
        url: result.url,
        normalizedUrl: normalizeDiscoveryUrl(result.url),
        sourceDomain: parseUrlSafely(result.url)?.hostname.replace(/^www\./i, "") || "",
        pageType: urlHistory.get(normalizeDiscoveryUrl(result.url))?.pageType || "unknown",
        lastSeenAt: historyTimestamp,
        lastSearchQuery: result.query
      }))
    : [];

  const extracted = [];
  const skipCounts = new Map();
  const expandedChildSeenUrls = new Set();
  const fetchedSeenUrls = new Set(discoveryRankedSearchResults.map((result) => result.url));
  const perDepthCounts = new Map();
  const perDomainDepthCounts = new Map();
  let frontier = initialFrontier;
  let totalFetchedPages = 0;
  let totalSkippedPages = 0;
  let totalHistorySkippedPages = 0;
  let aiPageReviewMetadata = { mode: "skipped", reason: "no_borderline_pages" };
  const aggressiveExploration = manualRerun || freshStart;
  const effectiveMaxListExpansionDepth = aggressiveExploration
    ? Math.max(maxListExpansionDepth, DEFAULT_MAX_LIST_EXPANSION_DEPTH + 1)
    : maxListExpansionDepth;

  if (aggressiveExploration && effectiveMaxListExpansionDepth > maxListExpansionDepth) {
    logs.push(`[depth-policy] manual_rerun=${manualRerun ? "yes" : "no"} fresh_start=${freshStart ? "yes" : "no"} base_max_depth=${maxListExpansionDepth} effective_max_depth=${effectiveMaxListExpansionDepth} depth3_requires_promising_list_page=yes`);
  } else {
    logs.push(`[depth-policy] manual_rerun=${manualRerun ? "yes" : "no"} fresh_start=${freshStart ? "yes" : "no"} effective_max_depth=${effectiveMaxListExpansionDepth}`);
  }

  let aiPostHistoryExpansionAttempted = false;
  let aiPostFilterRescueAttempted = false;

  while (true) {
    while (frontier.length > 0) {
    const fetchableFrontier = [];
    const skippedByHistory = [];
    for (const result of frontier) {
      if (!enableUrlHistory) {
        fetchableFrontier.push(result);
        continue;
      }
      const historyDecision = shouldSkipUrlByHistory(result.url, urlHistory, Date.now());
      const historyBypassScoreThreshold = freshStart ? 9 : 11;
      const historyBypassMinAgeMs = freshStart ? 0 : (2 * 60 * 60 * 1000);
      const highFitHistoryBypass = aggressiveExploration
        && Number(result.fitScore || 0) >= historyBypassScoreThreshold
        && (
          historyDecision.pageType === "direct_scholarship"
          || historyDecision.pageType === "scholarship_list_page"
        )
        && (
          historyDecision.ageMs === null
          || historyDecision.ageMs >= historyBypassMinAgeMs
        );
      if (highFitHistoryBypass) {
        logs.push(`[history-bypass] depth=${result.expansionDepth} fit=${Number(result.fitScore || 0).toFixed(1)} page_type=${historyDecision.pageType || "unknown"} url=${formatUrlForLog(result.url)}`);
        fetchableFrontier.push(result);
        continue;
      }
      if (!historyDecision.skip) {
        fetchableFrontier.push(result);
        continue;
      }
      skippedByHistory.push({
        result,
        historyDecision
      });
    }

    const shouldTopUpFreshFrontier = enableUrlHistory
      && freshStart
      && skippedByHistory.length > 0
      && fetchableFrontier.length > 0
      && fetchableFrontier.length < MIN_FRESH_START_FRONTIER;

    if (enableUrlHistory && skippedByHistory.length > 0 && (fetchableFrontier.length === 0 || shouldTopUpFreshFrontier)) {
      const frontierShortfall = fetchableFrontier.length === 0
        ? MAX_HISTORY_REVISIT_PER_PASS
        : Math.max(1, MIN_FRESH_START_FRONTIER - fetchableFrontier.length);
      const revisitBudget = Math.min(
        MAX_HISTORY_REVISIT_PER_PASS,
        Math.max(1, Math.min(frontierShortfall, skippedByHistory.length))
      );
      const revisitCandidates = skippedByHistory
        .filter(({ historyDecision }) => (
          historyDecision.pageType === "scholarship_list_page"
          || historyDecision.pageType === "direct_scholarship"
        ))
        .sort((left, right) => (
          getHistoryRevisitPriority(left.historyDecision.pageType) - getHistoryRevisitPriority(right.historyDecision.pageType)
          || (right.historyDecision.ageMs || 0) - (left.historyDecision.ageMs || 0)
          || left.result.globalRank - right.result.globalRank
        ))
        .slice(0, revisitBudget);

      if (revisitCandidates.length > 0) {
        const revisitSet = new Set(revisitCandidates.map(({ result }) => result.url));
        for (const { result, historyDecision } of revisitCandidates) {
          const ageHours = historyDecision.ageMs === null ? "?" : Math.round(historyDecision.ageMs / (60 * 60 * 1000));
          logs.push(`[history-revisit] depth=${result.expansionDepth} page_type=${historyDecision.pageType || "unknown"} age_hours=${ageHours} url=${formatUrlForLog(result.url)}`);
          fetchableFrontier.push(result);
        }
        logs.push(`[history-revisit] reused ${revisitCandidates.length} recent URL(s) because only ${fetchableFrontier.length - revisitCandidates.length} fresh URL(s) remained`);
        for (const item of skippedByHistory) {
          if (!revisitSet.has(item.result.url)) {
            totalHistorySkippedPages += 1;
            const skipReason = `history_recent_${item.historyDecision.pageType || "unknown"}`;
            skipCounts.set(skipReason, (skipCounts.get(skipReason) || 0) + 1);
            const ageHours = item.historyDecision.ageMs === null ? "?" : Math.round(item.historyDecision.ageMs / (60 * 60 * 1000));
            logs.push(`[history-skip] depth=${item.result.expansionDepth} page_type=${item.historyDecision.pageType || "unknown"} age_hours=${ageHours} url=${formatUrlForLog(item.result.url)}`);
          }
        }
      } else {
        for (const item of skippedByHistory) {
          totalHistorySkippedPages += 1;
          const skipReason = `history_recent_${item.historyDecision.pageType || "unknown"}`;
          skipCounts.set(skipReason, (skipCounts.get(skipReason) || 0) + 1);
          const ageHours = item.historyDecision.ageMs === null ? "?" : Math.round(item.historyDecision.ageMs / (60 * 60 * 1000));
          logs.push(`[history-skip] depth=${item.result.expansionDepth} page_type=${item.historyDecision.pageType || "unknown"} age_hours=${ageHours} url=${formatUrlForLog(item.result.url)}`);
        }
      }
    } else {
      for (const item of skippedByHistory) {
        totalHistorySkippedPages += 1;
        const skipReason = `history_recent_${item.historyDecision.pageType || "unknown"}`;
        skipCounts.set(skipReason, (skipCounts.get(skipReason) || 0) + 1);
        const ageHours = item.historyDecision.ageMs === null ? "?" : Math.round(item.historyDecision.ageMs / (60 * 60 * 1000));
        logs.push(`[history-skip] depth=${item.result.expansionDepth} page_type=${item.historyDecision.pageType || "unknown"} age_hours=${ageHours} url=${formatUrlForLog(item.result.url)}`);
      }
    }

    const historyWeakness = shouldExpandDiscoverySearchAfterHistory(fetchableFrontier, skippedByHistory, frontier);
    if (
      !aiPostHistoryExpansionAttempted
      && frontier.some((item) => Number(item?.expansionDepth || 0) === 0)
      && historyWeakness.weak
    ) {
      aiPostHistoryExpansionAttempted = true;
      const aiHistoryExpansion = await maybeExpandSearchResultsWithAi({
        profile: mergedProfile,
        studentStage,
        queries: discoveryQueries,
        rankedSearchResults: discoveryRankedSearchResults,
        existingCandidates,
        fetchImpl,
        searchTimeoutMs,
        searchConcurrency,
        logs,
        braveApiKey,
        timeoutMs: aiSearchExpansionTimeoutMs,
        enabled: enableAiSearchExpansion,
        expandImpl: aiSearchExpansionImpl,
        force: true,
        triggerReason: "post_history",
        frontierStats: historyWeakness
      });
      aiSearchExpansionAttempts.push(aiHistoryExpansion.metadata);
      aiSearchExpansionMetadata = {
        ...(aiHistoryExpansion.metadata || {}),
        attempts: aiSearchExpansionAttempts
      };
      if (aiHistoryExpansion.additionalQueries.length > 0) {
        discoveryQueries = uniqueStrings([...discoveryQueries, ...aiHistoryExpansion.additionalQueries]);
      }
      if (aiHistoryExpansion.additionalResults.length > 0) {
        searchUniverseResults = mergeDiscoverySearchResultsWithExpansion(
          searchUniverseResults,
          aiHistoryExpansion.additionalResults
        );
        discoveryRankedSearchResults = rerankSearchResultsForDiscovery(
          searchUniverseResults,
          urlHistory,
          mergedProfile,
          studentStage,
          logs,
          domainFeedbackStats
        );
        const supplementalFrontier = selectInitialFrontier(discoveryRankedSearchResults, logs)
          .filter((item) => !fetchedSeenUrls.has(item.url));
        if (supplementalFrontier.length > 0) {
          for (const item of supplementalFrontier) {
            fetchedSeenUrls.add(item.url);
            fetchableFrontier.push(item);
          }
          logs.push(`[ai-search] post_history_topup added ${supplementalFrontier.length} top-level URL(s)`);
        }
      }
    }

    if (fetchableFrontier.length === 0) {
      frontier = [];
      continue;
    }

    const fetchedPages = await fetchPages(
      fetchableFrontier.map((result) => result.url),
      {
        fetchImpl,
        timeoutMs: pageTimeoutMs,
        retries: pageRetries,
        concurrency: pageConcurrency,
        logs
      }
    );

    totalFetchedPages += fetchedPages.filter((page) => page.ok).length;
    totalSkippedPages += fetchedPages.filter((page) => !page.ok).length;

    const pageByUrl = new Map(fetchedPages.map((page) => [page.url, page]));
    const expandedChildResults = [];
    const pendingCandidates = [];
    const pendingListPageReviews = [];

    for (const result of fetchableFrontier) {
      const page = pageByUrl.get(result.url);
      const sourceDomain = parseUrlSafely(result.url)?.hostname.replace(/^www\./i, "") || "";
      if (!page?.ok || !page.html) {
        const reason = page?.error || "page_fetch_failed";
        skipCounts.set(reason, (skipCounts.get(reason) || 0) + 1);
        logs.push(`[reject] depth=${result.expansionDepth} fetch_failed reason=${reason} url=${formatUrlForLog(result.url)}`);
        historyUpdates.push(buildHistoryUpdate({
          url: result.url,
          query: result.query,
          sourceDomain,
          pageType: reason.startsWith("unsupported_content_type") ? "unsupported_content_type" : "fetch_error",
          error: reason,
          timestamp: historyTimestamp
        }));
        continue;
      }

      try {
        const extraction = buildCandidateFromPage({
          url: result.url,
          html: page.html,
          searchResult: result
        });
        if (!extraction.candidate) {
          if (extraction.skipReason === "scholarship_list_page" && result.expansionDepth < effectiveMaxListExpansionDepth) {
            const pageReview = buildPageReviewSnapshot({
              url: result.url,
              html: page.html,
              searchResult: result,
              extraction
            });
            if (shouldReviewRejectedListPageWithAi(pageReview)) {
              pendingListPageReviews.push({
                result,
                extraction,
                pageReview,
                html: page.html
              });
              continue;
            }

            skipCounts.set("scholarship_list_page", (skipCounts.get("scholarship_list_page") || 0) + 1);
            const childCount = Array.isArray(extraction.childUrls) ? extraction.childUrls.length : 0;
            const nextDepth = result.expansionDepth + 1;
            const canExpandAtNextDepth = nextDepth < 3 || (
              manualRerun && isPromisingListPageForDeeperExpansion({
                result,
                pageReview,
                profile: mergedProfile,
                studentStage
              })
            );
            if (nextDepth >= 3 && !canExpandAtNextDepth) {
              skipCounts.set("depth_3_not_promising", (skipCounts.get("depth_3_not_promising") || 0) + 1);
              logs.push(`[list-page] depth=${result.expansionDepth} child_urls=${childCount} will_expand=no reason=depth_3_not_promising url=${formatUrlForLog(result.url)}`);
            } else {
              logs.push(`[list-page] depth=${result.expansionDepth} child_urls=${childCount} will_expand=${childCount > 0 ? "yes" : "no"} url=${formatUrlForLog(result.url)}`);
            }
            historyUpdates.push(buildHistoryUpdate({
              url: result.url,
              query: result.query,
              sourceDomain,
              pageType: "scholarship_list_page",
              timestamp: historyTimestamp
            }));
            if (canExpandAtNextDepth) {
              enqueueExpandedChildUrls({
                childUrls: extraction.childUrls,
                parentResult: result,
                expandedChildResults,
                expandedChildSeenUrls,
                fetchedSeenUrls,
                perDepthCounts,
                perDomainDepthCounts,
                nextDepth
              });
            }
          } else if (extraction.skipReason === "scholarship_list_page") {
            skipCounts.set("scholarship_list_page", (skipCounts.get("scholarship_list_page") || 0) + 1);
            skipCounts.set("max_list_expansion_depth_reached", (skipCounts.get("max_list_expansion_depth_reached") || 0) + 1);
            const childCount = Array.isArray(extraction.childUrls) ? extraction.childUrls.length : 0;
            logs.push(`[list-page] depth=${result.expansionDepth} child_urls=${childCount} will_expand=no reason=max_depth url=${formatUrlForLog(result.url)}`);
            historyUpdates.push(buildHistoryUpdate({
              url: result.url,
              query: result.query,
              sourceDomain,
              pageType: "scholarship_list_page",
              timestamp: historyTimestamp
            }));
          } else {
            if (extraction.skipReason) {
              skipCounts.set(extraction.skipReason, (skipCounts.get(extraction.skipReason) || 0) + 1);
            }
            logs.push(`[reject] depth=${result.expansionDepth} reason=${extraction.skipReason || "unknown"} url=${formatUrlForLog(result.url)}`);
            historyUpdates.push(buildHistoryUpdate({
              url: result.url,
              query: result.query,
              sourceDomain,
              pageType: "not_scholarship_page",
              error: extraction.skipReason || "unknown",
              timestamp: historyTimestamp
            }));
          }
          continue;
        }
        logs.push(`[candidate] depth=${result.expansionDepth} title="${extraction.candidate.name}" url=${formatUrlForLog(result.url)}`);
        pendingCandidates.push({
          result,
          extraction,
          pageReview: buildPageReviewSnapshot({
            url: result.url,
            html: page.html,
            searchResult: result,
            extraction
          })
        });
      } catch (error) {
        errors.push(`extract:${result.url}:${error?.message || String(error)}`);
      }
    }

    const borderlineCandidates = pendingCandidates.filter((item) => shouldReviewAcceptedPageWithAi(item.pageReview));
    const borderlineListPageRejects = pendingListPageReviews;
    const aiPageReview = await maybeClassifyPageReviewsWithAi({
      profile: mergedProfile,
      pageReviews: [
        ...borderlineCandidates.map((item) => item.pageReview),
        ...borderlineListPageRejects.map((item) => item.pageReview)
      ],
      timeoutMs: aiPageClassifierTimeoutMs,
      logs,
      classifyImpl: aiClassifyPageEvaluationsImpl,
      enabled: enableAiPageClassifier
    });
    if (aiPageReview.metadata?.mode !== "skipped" || aiPageReviewMetadata.mode === "skipped") {
      aiPageReviewMetadata = aiPageReview.metadata;
    }

    for (const item of borderlineListPageRejects) {
      const aiDecision = aiPageReview.decisionsByUrl.get(String(item.pageReview?.sourceUrl || item.result.url || ""));
      if (aiDecision?.classification === "direct_scholarship") {
        logs.push(`[ai-page-decision] depth=${item.result.expansionDepth} classification=direct_scholarship confidence=${Number(aiDecision.confidence || 0).toFixed(2)} url=${formatUrlForLog(item.result.url)} rationale=${cleanText(aiDecision.rationale || "").slice(0, 140)}`);
        const rescuedExtraction = buildCandidateFromPage({
          url: item.result.url,
          html: item.html,
          searchResult: item.result,
          allowListPageOverride: true
        });
        if (rescuedExtraction.candidate) {
          const scoring = scoreCandidateFit({
            candidate: rescuedExtraction.candidate,
            profile: mergedProfile,
            studentStage,
            searchRank: item.result.globalRank
          });
          const existingIdentityKeys = [
            cleanText(rescuedExtraction.candidate?.id) ? `id:${cleanText(rescuedExtraction.candidate.id)}` : "",
            cleanText(rescuedExtraction.candidate?.sourceUrl) ? `url:${normalizeDiscoveryUrl(rescuedExtraction.candidate.sourceUrl)}` : "",
            cleanText(rescuedExtraction.candidate?.name) && cleanText(rescuedExtraction.candidate?.sourceDomain)
              ? `name_domain:${cleanText(rescuedExtraction.candidate.name).toLowerCase()}::${cleanText(rescuedExtraction.candidate.sourceDomain).toLowerCase()}`
              : ""
          ].filter(Boolean);
          if (existingIdentityKeys.some((key) => existingCandidateIdentities.has(key))) {
            skipCounts.set("already_reviewed_or_known", (skipCounts.get("already_reviewed_or_known") || 0) + 1);
            logs.push(`[reject] depth=${item.result.expansionDepth} reason=already_reviewed_or_known url=${formatUrlForLog(item.result.url)}`);
            historyUpdates.push(buildHistoryUpdate({
              url: item.result.url,
              query: item.result.query,
              sourceDomain: parseUrlSafely(item.result.url)?.hostname.replace(/^www\./i, "") || "",
              pageType: "direct_scholarship",
              candidate: rescuedExtraction.candidate,
              error: "already_reviewed_or_known",
              timestamp: historyTimestamp
            }));
            continue;
          }
          if (!scoring.isEligible) {
            skipCounts.set("profile_ineligible", (skipCounts.get("profile_ineligible") || 0) + 1);
            logs.push(`[reject] depth=${item.result.expansionDepth} reason=profile_ineligible blockers=${scoring.eligibilityBlockers.join(",") || "unknown"} url=${formatUrlForLog(item.result.url)}`);
            historyUpdates.push(buildHistoryUpdate({
              url: item.result.url,
              query: item.result.query,
              sourceDomain: parseUrlSafely(item.result.url)?.hostname.replace(/^www\./i, "") || "",
              pageType: "direct_scholarship",
              candidate: rescuedExtraction.candidate,
              error: `profile_ineligible:${scoring.eligibilityBlockers.join(",")}`,
              timestamp: historyTimestamp
            }));
            continue;
          }
          logs.push(`[accept] depth=${item.result.expansionDepth} score=${scoring.score} reasons=${scoring.reasons.join(",") || "none"} url=${formatUrlForLog(item.result.url)}`);
          extracted.push({
            candidate: rescuedExtraction.candidate,
            score: scoring.score,
            matchReasons: item.result.expansionDepth > 0
              ? [...scoring.reasons, "list_expanded", "ai_page_rescue"]
              : [...scoring.reasons, "ai_page_rescue"],
            ambiguityFlags: rescuedExtraction.ambiguityFlags,
            searchQuery: item.result.query,
            searchRank: item.result.globalRank
          });
          historyUpdates.push(buildHistoryUpdate({
            url: item.result.url,
            query: item.result.query,
            sourceDomain: parseUrlSafely(item.result.url)?.hostname.replace(/^www\./i, "") || "",
            pageType: "direct_scholarship",
            candidate: rescuedExtraction.candidate,
            timestamp: historyTimestamp
          }));
          continue;
        }
        logs.push(`[ai-page-decision] depth=${item.result.expansionDepth} classification=direct_scholarship confidence=${Number(aiDecision.confidence || 0).toFixed(2)} url=${formatUrlForLog(item.result.url)} rationale=override_failed_to_extract_candidate`);
      } else if (aiDecision?.classification === "not_scholarship_page") {
        skipCounts.set("ai_reclassified_not_scholarship", (skipCounts.get("ai_reclassified_not_scholarship") || 0) + 1);
        logs.push(`[ai-page-decision] depth=${item.result.expansionDepth} classification=not_scholarship_page confidence=${Number(aiDecision.confidence || 0).toFixed(2)} url=${formatUrlForLog(item.result.url)} rationale=${cleanText(aiDecision.rationale || "").slice(0, 140)}`);
        historyUpdates.push(buildHistoryUpdate({
          url: item.result.url,
          query: item.result.query,
          sourceDomain: parseUrlSafely(item.result.url)?.hostname.replace(/^www\./i, "") || "",
          pageType: "not_scholarship_page",
          error: "ai_reclassified_not_scholarship",
          timestamp: historyTimestamp
        }));
        continue;
      } else if (aiDecision?.classification === "scholarship_list_page") {
        logs.push(`[ai-page-decision] depth=${item.result.expansionDepth} classification=scholarship_list_page confidence=${Number(aiDecision.confidence || 0).toFixed(2)} url=${formatUrlForLog(item.result.url)} rationale=${cleanText(aiDecision.rationale || "").slice(0, 140)}`);
      }

      skipCounts.set("scholarship_list_page", (skipCounts.get("scholarship_list_page") || 0) + 1);
      const childCount = Array.isArray(item.pageReview.childUrls) ? item.pageReview.childUrls.length : 0;
      historyUpdates.push(buildHistoryUpdate({
        url: item.result.url,
        query: item.result.query,
        sourceDomain: parseUrlSafely(item.result.url)?.hostname.replace(/^www\./i, "") || "",
        pageType: "scholarship_list_page",
        timestamp: historyTimestamp
      }));
      if (item.result.expansionDepth < effectiveMaxListExpansionDepth) {
        logs.push(`[list-page] depth=${item.result.expansionDepth} child_urls=${childCount} will_expand=${childCount > 0 ? "yes" : "no"} url=${formatUrlForLog(item.result.url)}`);
        const nextDepth = item.result.expansionDepth + 1;
        const canExpandAtNextDepth = nextDepth < 3 || (
          manualRerun && isPromisingListPageForDeeperExpansion({
            result: item.result,
            pageReview: item.pageReview,
            profile: mergedProfile,
            studentStage
          })
        );
        if (!canExpandAtNextDepth) {
          skipCounts.set("depth_3_not_promising", (skipCounts.get("depth_3_not_promising") || 0) + 1);
          logs.push(`[list-page] depth=${item.result.expansionDepth} child_urls=${childCount} will_expand=no reason=depth_3_not_promising url=${formatUrlForLog(item.result.url)}`);
        } else {
          enqueueExpandedChildUrls({
            childUrls: item.pageReview.childUrls,
            parentResult: item.result,
            expandedChildResults,
            expandedChildSeenUrls,
            fetchedSeenUrls,
            perDepthCounts,
            perDomainDepthCounts,
            nextDepth
          });
        }
      } else {
        skipCounts.set("max_list_expansion_depth_reached", (skipCounts.get("max_list_expansion_depth_reached") || 0) + 1);
        logs.push(`[list-page] depth=${item.result.expansionDepth} child_urls=${childCount} will_expand=no reason=max_depth url=${formatUrlForLog(item.result.url)}`);
      }
    }

    for (const item of pendingCandidates) {
      const aiDecision = aiPageReview.decisionsByUrl.get(String(item.extraction.candidate?.sourceUrl || ""));
      if (aiDecision?.classification === "scholarship_list_page") {
        skipCounts.set("ai_reclassified_list_page", (skipCounts.get("ai_reclassified_list_page") || 0) + 1);
        logs.push(`[ai-page-decision] depth=${item.result.expansionDepth} classification=scholarship_list_page confidence=${Number(aiDecision.confidence || 0).toFixed(2)} url=${formatUrlForLog(item.result.url)} rationale=${cleanText(aiDecision.rationale || "").slice(0, 140)}`);
        if (item.result.expansionDepth < effectiveMaxListExpansionDepth) {
          const childCount = Array.isArray(item.pageReview.childUrls) ? item.pageReview.childUrls.length : 0;
          const nextDepth = item.result.expansionDepth + 1;
          const canExpandAtNextDepth = nextDepth < 3 || (
            manualRerun && isPromisingListPageForDeeperExpansion({
              result: item.result,
              pageReview: item.pageReview,
              profile: mergedProfile,
              studentStage
            })
          );
          if (!canExpandAtNextDepth) {
            skipCounts.set("depth_3_not_promising", (skipCounts.get("depth_3_not_promising") || 0) + 1);
            logs.push(`[ai-list-page] depth=${item.result.expansionDepth} child_urls=${childCount} will_expand=no reason=depth_3_not_promising url=${formatUrlForLog(item.result.url)}`);
          } else {
            logs.push(`[ai-list-page] depth=${item.result.expansionDepth} child_urls=${childCount} will_expand=${childCount > 0 ? "yes" : "no"} url=${formatUrlForLog(item.result.url)}`);
            enqueueExpandedChildUrls({
              childUrls: item.pageReview.childUrls,
              parentResult: item.result,
              expandedChildResults,
              expandedChildSeenUrls,
              fetchedSeenUrls,
              perDepthCounts,
              perDomainDepthCounts,
              nextDepth
            });
          }
        } else {
          skipCounts.set("max_list_expansion_depth_reached", (skipCounts.get("max_list_expansion_depth_reached") || 0) + 1);
          logs.push(`[ai-list-page] depth=${item.result.expansionDepth} will_expand=no reason=max_depth url=${formatUrlForLog(item.result.url)}`);
        }
        continue;
      }
      if (aiDecision?.classification === "not_scholarship_page") {
        skipCounts.set("ai_reclassified_not_scholarship", (skipCounts.get("ai_reclassified_not_scholarship") || 0) + 1);
        logs.push(`[ai-page-decision] depth=${item.result.expansionDepth} classification=not_scholarship_page confidence=${Number(aiDecision.confidence || 0).toFixed(2)} url=${formatUrlForLog(item.result.url)} rationale=${cleanText(aiDecision.rationale || "").slice(0, 140)}`);
        historyUpdates.push(buildHistoryUpdate({
          url: item.result.url,
          query: item.result.query,
          sourceDomain: parseUrlSafely(item.result.url)?.hostname.replace(/^www\./i, "") || "",
          pageType: "not_scholarship_page",
          error: "ai_reclassified_not_scholarship",
          timestamp: historyTimestamp
        }));
        continue;
      }
      if (aiDecision?.classification === "direct_scholarship") {
        logs.push(`[ai-page-decision] depth=${item.result.expansionDepth} classification=direct_scholarship confidence=${Number(aiDecision.confidence || 0).toFixed(2)} url=${formatUrlForLog(item.result.url)}`);
      }

      const scoring = scoreCandidateFit({
        candidate: item.extraction.candidate,
        profile: mergedProfile,
        studentStage,
        searchRank: item.result.globalRank
      });
      const existingIdentityKeys = [
        cleanText(item.extraction.candidate?.id) ? `id:${cleanText(item.extraction.candidate.id)}` : "",
        cleanText(item.extraction.candidate?.sourceUrl) ? `url:${normalizeDiscoveryUrl(item.extraction.candidate.sourceUrl)}` : "",
        cleanText(item.extraction.candidate?.name) && cleanText(item.extraction.candidate?.sourceDomain)
          ? `name_domain:${cleanText(item.extraction.candidate.name).toLowerCase()}::${cleanText(item.extraction.candidate.sourceDomain).toLowerCase()}`
          : ""
      ].filter(Boolean);
      if (existingIdentityKeys.some((key) => existingCandidateIdentities.has(key))) {
        skipCounts.set("already_reviewed_or_known", (skipCounts.get("already_reviewed_or_known") || 0) + 1);
        logs.push(`[reject] depth=${item.result.expansionDepth} reason=already_reviewed_or_known url=${formatUrlForLog(item.result.url)}`);
        historyUpdates.push(buildHistoryUpdate({
          url: item.result.url,
          query: item.result.query,
          sourceDomain: parseUrlSafely(item.result.url)?.hostname.replace(/^www\./i, "") || "",
          pageType: "direct_scholarship",
          candidate: item.extraction.candidate,
          error: "already_reviewed_or_known",
          timestamp: historyTimestamp
        }));
        continue;
      }
      if (!scoring.isEligible) {
        skipCounts.set("profile_ineligible", (skipCounts.get("profile_ineligible") || 0) + 1);
        logs.push(`[reject] depth=${item.result.expansionDepth} reason=profile_ineligible blockers=${scoring.eligibilityBlockers.join(",") || "unknown"} url=${formatUrlForLog(item.result.url)}`);
        historyUpdates.push(buildHistoryUpdate({
          url: item.result.url,
          query: item.result.query,
          sourceDomain: parseUrlSafely(item.result.url)?.hostname.replace(/^www\./i, "") || "",
          pageType: "direct_scholarship",
          candidate: item.extraction.candidate,
          error: `profile_ineligible:${scoring.eligibilityBlockers.join(",")}`,
          timestamp: historyTimestamp
        }));
        continue;
      }
      logs.push(`[accept] depth=${item.result.expansionDepth} score=${scoring.score} reasons=${scoring.reasons.join(",") || "none"} url=${formatUrlForLog(item.result.url)}`);
      extracted.push({
        candidate: item.extraction.candidate,
        score: scoring.score,
        matchReasons: item.result.expansionDepth > 0
          ? [...scoring.reasons, "list_expanded"]
          : scoring.reasons,
        ambiguityFlags: item.extraction.ambiguityFlags,
        searchQuery: item.result.query,
        searchRank: item.result.globalRank
      });
      historyUpdates.push(buildHistoryUpdate({
        url: item.result.url,
        query: item.result.query,
        sourceDomain: parseUrlSafely(item.result.url)?.hostname.replace(/^www\./i, "") || "",
        pageType: "direct_scholarship",
        candidate: item.extraction.candidate,
        timestamp: historyTimestamp
      }));
    }

    if (expandedChildResults.length > 0) {
      const nextDepth = Math.max(...expandedChildResults.map((item) => Number(item.expansionDepth || 0)));
      logs.push(`[expand] queued ${expandedChildResults.length} child URL(s) from scholarship list pages at depth ${nextDepth}`);
    }

    frontier = expandedChildResults;
  }

    if (extracted.length === 0 && !aiPostFilterRescueAttempted) {
      aiPostFilterRescueAttempted = true;
      const aiRescueExpansion = await maybeExpandSearchResultsWithAi({
        profile: mergedProfile,
        studentStage,
        queries: discoveryQueries,
        rankedSearchResults: discoveryRankedSearchResults,
        existingCandidates,
        fetchImpl,
        searchTimeoutMs,
        searchConcurrency,
        logs,
        braveApiKey,
        timeoutMs: aiSearchExpansionTimeoutMs,
        enabled: enableAiSearchExpansion,
        expandImpl: aiSearchExpansionImpl,
        force: true,
        triggerReason: "post_filter_rescue",
        frontierStats: {
          extractedCount: extracted.length,
          historySkippedPages: totalHistorySkippedPages,
          topLevelSearchResults: discoveryRankedSearchResults.length
        }
      });
      aiSearchExpansionAttempts.push(aiRescueExpansion.metadata);
      aiSearchExpansionMetadata = {
        ...(aiRescueExpansion.metadata || {}),
        attempts: aiSearchExpansionAttempts
      };
      if (aiRescueExpansion.additionalQueries.length > 0) {
        discoveryQueries = uniqueStrings([...discoveryQueries, ...aiRescueExpansion.additionalQueries]);
      }
      if (aiRescueExpansion.additionalResults.length > 0) {
        searchUniverseResults = mergeDiscoverySearchResultsWithExpansion(
          searchUniverseResults,
          aiRescueExpansion.additionalResults
        );
        discoveryRankedSearchResults = rerankSearchResultsForDiscovery(
          searchUniverseResults,
          urlHistory,
          mergedProfile,
          studentStage,
          logs,
          domainFeedbackStats
        );
        frontier = selectInitialFrontier(discoveryRankedSearchResults, logs)
          .filter((item) => !fetchedSeenUrls.has(item.url));
        if (frontier.length > 0) {
          logs.push(`[ai-search] post_filter_rescue queued ${frontier.length} top-level URL(s)`);
          continue;
        }
      }
    }

    break;
  }

  let rankedCandidates = dedupeRankedCandidates(extracted);
  const aiRefinement = await maybeRefineAmbiguousCandidatesWithAi({
    profile: mergedProfile,
    rankedCandidates,
    timeoutMs: aiTimeoutMs,
    logs
  });
  rankedCandidates = aiRefinement.candidates;

  for (const [reason, count] of skipCounts.entries()) {
    logs.push(`[skip] ${reason} -> ${count}`);
  }
  for (const error of errors) {
    logs.push(`[extract-error] ${error}`);
  }
  logs.push(`[history] skipped_recent_urls -> ${totalHistorySkippedPages}`);

  const finalCandidates = rankedCandidates.slice(0, Math.max(1, discoveryMaxResults));
  logs.push(`[result] discovered ${finalCandidates.length} candidate(s) after filtering`);
  if (enableUrlHistory) {
    await upsertDiscoveryUrlHistory(historyUpdates);
  }

  return {
    mergedProfile,
    queries: discoveryQueries,
    candidates: finalCandidates,
    diagnostics: {
      searchResults: discoveryRankedSearchResults.length,
      fetchedPages: totalFetchedPages,
      skippedPages: totalSkippedPages,
      historySkippedPages: totalHistorySkippedPages,
      extractedCandidates: extracted.length,
      aiSearchExpansion: aiSearchExpansionMetadata,
      aiPageClassifier: aiPageReviewMetadata,
      aiRefinement: aiRefinement.metadata
    },
    logs,
    errors
  };
}

export const __testables = {
  allocateDiscoveryQueryBudget,
  buildDiscoveryQueryFamilies,
  buildDiscoveryQueries,
  parseBraveWebSearchResults,
  buildCandidateFromPage,
  scoreCandidateFit,
  scoreSearchResultFitLikelihood,
  rerankSearchResultsForDiscovery,
  selectInitialFrontier,
  shouldExpandDiscoverySearchWithAi,
  extractLikelyScholarshipLinks,
  normalizeDateString,
  extractDeadline,
  extractAwardAmount,
  extractMinGpa
};
