import {
  loadDiscoveryUrlHistory,
  normalizeDiscoveryUrl,
  shouldSkipUrlByHistory
} from "./discoveryHistoryStore.js";

const BRAVE_SEARCH_ENDPOINT = String(process.env.DISCOVERY_SEARCH_ENDPOINT || "https://api.search.brave.com/res/v1/web/search").trim();
const SEARCH_USER_AGENT = "ScholarshipBot/0.1 (+scholarship-web-search)";
const DEFAULT_FETCH_TIMEOUT_MS = 10000;
const DEFAULT_SEARCH_CONCURRENCY = 2;
const MAX_SEARCH_RESULTS_PER_QUERY = 20;
const DEFAULT_EXPERIMENT_VARIANT = "control";

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
  ["AL", "Alabama"], ["AK", "Alaska"], ["AZ", "Arizona"], ["AR", "Arkansas"], ["CA", "California"],
  ["CO", "Colorado"], ["CT", "Connecticut"], ["DE", "Delaware"], ["FL", "Florida"], ["GA", "Georgia"],
  ["HI", "Hawaii"], ["ID", "Idaho"], ["IL", "Illinois"], ["IN", "Indiana"], ["IA", "Iowa"],
  ["KS", "Kansas"], ["KY", "Kentucky"], ["LA", "Louisiana"], ["ME", "Maine"], ["MD", "Maryland"],
  ["MA", "Massachusetts"], ["MI", "Michigan"], ["MN", "Minnesota"], ["MS", "Mississippi"], ["MO", "Missouri"],
  ["MT", "Montana"], ["NE", "Nebraska"], ["NV", "Nevada"], ["NH", "New Hampshire"], ["NJ", "New Jersey"],
  ["NM", "New Mexico"], ["NY", "New York"], ["NC", "North Carolina"], ["ND", "North Dakota"], ["OH", "Ohio"],
  ["OK", "Oklahoma"], ["OR", "Oregon"], ["PA", "Pennsylvania"], ["RI", "Rhode Island"], ["SC", "South Carolina"],
  ["SD", "South Dakota"], ["TN", "Tennessee"], ["TX", "Texas"], ["UT", "Utah"], ["VT", "Vermont"],
  ["VA", "Virginia"], ["WA", "Washington"], ["WV", "West Virginia"], ["WI", "Wisconsin"], ["WY", "Wyoming"],
  ["DC", "District of Columbia"]
];

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeText(value) {
  return cleanText(value).toLowerCase();
}

function uniqueStrings(values) {
  const seen = new Set();
  const output = [];
  for (const value of values || []) {
    const cleaned = cleanText(value);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(cleaned);
  }
  return output;
}

function parseUrlSafely(value) {
  try {
    return new URL(String(value || ""));
  } catch {
    return null;
  }
}

function normalizeStateValue(value) {
  const raw = cleanText(value);
  if (!raw) return "";
  const upper = raw.toUpperCase();
  for (const [abbr, name] of STATE_ENTRIES) {
    if (upper === abbr || normalizeText(raw) === name.toLowerCase()) {
      return abbr;
    }
  }
  return upper.length === 2 ? upper : raw;
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
  if (normalizedStage === "transfering_college" || normalizedStage === "transferring_college") {
    return ["transfer student", "undergraduate transfer", "college transfer"];
  }
  return ["undergraduate", "college student"];
}

function stageTermMatchesText(term, text) {
  const normalizedTerm = normalizeText(term);
  const normalizedText = normalizeText(text);
  if (!normalizedTerm || !normalizedText) return false;
  if (normalizedText.includes(normalizedTerm)) return true;
  if (normalizedTerm.includes("freshman") && normalizedText.includes(normalizedTerm.replace("freshman", "freshmen"))) {
    return true;
  }
  return false;
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

function detectInstitutionSignals(combined = "", sourceDomain = "") {
  const institutionSpecificSignal = /\.edu$/i.test(sourceDomain)
    || /\b(university|college|department|school of engineering|campus|incoming students?|current students?)\b/i.test(combined);
  const specificSchoolSignal = /\.edu$/i.test(sourceDomain)
    && /\b(university|college|department|school of engineering|campus|incoming students?|current students?|undergraduate students?)\b/i.test(combined);
  return {
    institutionSpecificSignal,
    specificSchoolSignal
  };
}

function getSearchExperimentConfig(variant = DEFAULT_EXPERIMENT_VARIANT) {
  const normalized = normalizeText(variant) || DEFAULT_EXPERIMENT_VARIANT;
  const base = {
    name: DEFAULT_EXPERIMENT_VARIANT,
    surfaceDirectBonus: 7,
    surfaceHubBonus: 0.5,
    surfaceListPenalty: 0.25,
    scholarshipKeywordBonus: 1.5,
    actionKeywordBonus: 1.5,
    genericBlogPenalty: 2,
    indirectPenalty: 2.5,
    stalePenalty: 4,
    institutionPenalty: 2.25,
    specificSchoolPenalty: 2.75,
    homepagePenalty: 4.5,
    exactMajorBonus: 0,
    broadOnlyEngineeringPenalty: 0,
    directDetailPathBonus: 0,
    pluralScholarshipsPenalty: 0,
    scholarshipProgramBonus: 0,
    noveltyWeight: 1
  };

  if (normalized === "precision_first") {
    return {
      ...base,
      name: normalized,
      surfaceDirectBonus: 1.75,
      surfaceHubBonus: 0.35,
      surfaceListPenalty: 0.6,
      scholarshipKeywordBonus: 1.75,
      actionKeywordBonus: 1.75,
      genericBlogPenalty: 2.75,
      indirectPenalty: 3.5,
      stalePenalty: 5.5,
      homepagePenalty: 5,
      directDetailPathBonus: 1
    };
  }

  if (normalized === "non_school_bias") {
    return {
      ...base,
      name: normalized,
      surfaceHubBonus: 0.25
    };
  }

  if (normalized === "major_precision") {
    return {
      ...base,
      name: normalized,
      exactMajorBonus: 1.75,
      broadOnlyEngineeringPenalty: 3.25,
      surfaceHubBonus: 0.35
    };
  }

  if (normalized === "direct_link_push") {
    return {
      ...base,
      name: normalized,
      surfaceDirectBonus: 2.75,
      surfaceHubBonus: 0.15,
      surfaceListPenalty: 1.25,
      scholarshipKeywordBonus: 1.75,
      actionKeywordBonus: 2.1,
      genericBlogPenalty: 3.5,
      indirectPenalty: 4.25,
      stalePenalty: 5.5,
      institutionPenalty: 2.5,
      specificSchoolPenalty: 3.25,
      homepagePenalty: 5.5,
      directDetailPathBonus: 2.25,
      pluralScholarshipsPenalty: 1.5,
      scholarshipProgramBonus: 1.25
    };
  }

  return base;
}

function ruleMatchesValue(rule, value) {
  const normalizedRule = normalizeText(rule);
  const normalizedValue = normalizeText(value);
  if (!normalizedRule || !normalizedValue) return false;
  return normalizedValue === normalizedRule
    || normalizedValue.includes(normalizedRule)
    || normalizedRule.includes(normalizedValue);
}

function isLikelyScholarshipDetailPath(pathname) {
  const path = String(pathname || "").toLowerCase();
  if (!path || path === "/") return false;
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

function isLikelyScholarshipHubPath(pathname) {
  const path = String(pathname || "").toLowerCase();
  if (!path || path === "/") return false;
  if (/\/(by-major|by-state|types|type|category|categories|directory|financial-aid)\//i.test(path)) {
    return false;
  }
  if (/\/scholarships?\/?$/.test(path)) return true;
  if (/\/(students-and-faculty|student[s-]?and-?faculty|undergraduate|graduate|admissions|programs?)\/.*scholarships?\/?$/i.test(path)) {
    return true;
  }
  return /\/(?:available|department|college|school)-[a-z0-9-]*scholarships?\/?$/i.test(path);
}

function isLikelyScholarshipHomepage(result) {
  const title = cleanText(result?.title || "");
  const snippet = cleanText(result?.snippet || "");
  const parsedUrl = parseUrlSafely(result?.url || "");
  const pathname = String(parsedUrl?.pathname || "").toLowerCase();
  const sourceDomain = String(parsedUrl?.hostname || "").replace(/^www\./i, "").toLowerCase();
  const combined = `${title} ${snippet} ${pathname}`;

  if (!/^\/?$/.test(pathname)) return false;
  if (/\bhome\b/i.test(title)) return true;
  if (/\b(scholarship fund|foundation|college board|financial aid finder)\b/i.test(title) && !/\b(deadline|eligibility|apply|award)\b/i.test(combined)) {
    return true;
  }
  return /^(hsf\.net|bold\.org|scholarships\.com)$/i.test(sourceDomain) && !/\b(deadline|eligibility|apply|award)\b/i.test(combined);
}

function isLikelyScholarshipCenterOrCategoryPage(result) {
  const title = cleanText(result?.title || "");
  const snippet = cleanText(result?.snippet || "");
  const parsedUrl = parseUrlSafely(result?.url || "");
  const pathname = String(parsedUrl?.pathname || "").toLowerCase();
  const combined = `${title} ${snippet} ${pathname}`;

  if (/\b(scholarship center|scholarship office|financial aid office|donor scholarships)\b/i.test(combined)) {
    return true;
  }
  if (/\b(scholarship programs?|college opportunities|opportunities)\b/i.test(title) && /\bscholarship/i.test(title)) {
    return true;
  }
  if (/\bfirst[- ]year students?\b/i.test(combined) && /\bscholarship/i.test(combined) && !isLikelyScholarshipDetailPath(pathname)) {
    return true;
  }
  return false;
}

function classifySearchResultSurface(result) {
  const hintedSurface = normalizeText(result?.surfaceHint || result?.kind || "");
  if (hintedSurface === "direct_scholarship") return "direct_likely";
  if (hintedSurface === "scholarship_program_hub") return "hub_likely";
  if (hintedSurface === "scholarship_list_page") return "list_likely";

  const title = cleanText(result?.title || "");
  const snippet = cleanText(result?.snippet || "");
  const parsedUrl = parseUrlSafely(result?.url || "");
  const pathname = String(parsedUrl?.pathname || "").toLowerCase();
  const combined = `${title} ${snippet} ${pathname}`;
  const indirectContentSignal = hasIndirectContentSignals(`${title}\n${snippet}`, String(parsedUrl?.hostname || ""), pathname);

  if (/\b(top \d+|best scholarships|list of scholarships|browse scholarships|directory|roundup|scholarship lists?)\b/i.test(combined)) {
    return "list_likely";
  }
  if (indirectContentSignal) {
    return "list_likely";
  }
  if (isLikelyScholarshipHomepage(result)) {
    return "other";
  }
  if (isLikelyScholarshipCenterOrCategoryPage(result)) {
    return "hub_likely";
  }
  if (/\/(by-major|by-state|types|type|category|categories|directory|financial-aid)\//i.test(pathname)) {
    return "list_likely";
  }
  if (/\bscholarships\b/i.test(title) && /\b(top \d+|best|directory|roundup|opportunities)\b/i.test(combined)) {
    return "list_likely";
  }
  if (/\bscholarships\b/i.test(title) && !/\b(apply|eligibility|deadline)\b/i.test(combined)) {
    return "list_likely";
  }
  if (
    isLikelyScholarshipHubPath(pathname)
    || /\b(available|department|program|students? and faculty|incoming students?|current and incoming students?)\b/i.test(combined)
  ) {
    return "hub_likely";
  }
  if (isLikelyScholarshipDetailPath(pathname)) return "direct_likely";
  if (/\b(scholarship|grant|award|fellowship)\b/i.test(combined) && !/\bscholarships\b/i.test(title)) {
    return "direct_likely";
  }
  return "other";
}

function normalizeDomainHint(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^site:/, "")
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
}

function domainMatchesHint(domain, hint) {
  const normalizedDomain = normalizeDomainHint(domain);
  const normalizedHint = normalizeDomainHint(hint);
  if (!normalizedDomain || !normalizedHint) return false;
  return normalizedDomain === normalizedHint || normalizedDomain.endsWith(`.${normalizedHint}`);
}

function hasStaleCycleSignals(text, { currentYear = new Date().getUTCFullYear() } = {}) {
  const combined = cleanText(text);
  if (!combined) return false;
  const yearMatches = [...combined.matchAll(/\b(20\d{2})\b/g)].map((match) => Number(match[1]));
  if (yearMatches.length === 0) return false;
  const hasCurrentOrFutureYear = yearMatches.some((year) => year >= currentYear);
  const hasPastYear = yearMatches.some((year) => year < currentYear);
  if (!hasPastYear || hasCurrentOrFutureYear) return false;
  return /\b(deadline|application|apply|applications?|award year|academic year|semester|fall|spring|currently open|opens?|renewable)\b/i.test(combined);
}

function hasIndirectContentSignals(text, sourceDomain = "", pathname = "") {
  const combined = `${cleanText(text)} ${cleanText(sourceDomain)} ${cleanText(pathname)}`;
  if (!combined) return false;
  if (/^blog\./i.test(sourceDomain) || /\/blog\//i.test(pathname)) return true;
  return /\b(these scholarship applications are currently open|you can apply today|our guide|this guide|how to win|tips for|best scholarships|top \d+|list of scholarships|browse scholarships|scholarships for [a-z/& -]+ students)\b/i.test(combined);
}

function buildRecentDomainCounts(urlHistory, { withinHours = 24 * 14 } = {}) {
  const now = Date.now();
  const counts = new Map();
  for (const record of urlHistory?.values?.() || []) {
    const fetchedAtMs = Date.parse(String(record?.lastFetchedAt || ""));
    if (!Number.isFinite(fetchedAtMs)) continue;
    if ((now - fetchedAtMs) > (withinHours * 60 * 60 * 1000)) continue;
    const domain = String(record?.sourceDomain || "").replace(/^www\./i, "");
    if (!domain) continue;
    counts.set(domain, (counts.get(domain) || 0) + 1);
  }
  return counts;
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
    if (record.pageType === "direct_scholarship") score -= 3;
    else if (record.pageType === "scholarship_list_page") score -= 1.5;
  }

  score -= Math.min(4, seenDomainCount * 0.5);

  const pathname = String(parseUrlSafely(result?.url)?.pathname || "");
  if (isLikelyScholarshipDetailPath(pathname)) score += 1;
  if (/\b(scholarship|grant|award|fellowship)\b/i.test(`${result?.title || ""} ${pathname}`)) {
    score += 0.5;
  }

  return Number(score.toFixed(3));
}

function scoreSearchResultFitLikelihood(result, profile = {}, studentStage = "", allowDomains = [], experimentVariant = DEFAULT_EXPERIMENT_VARIANT) {
  const title = cleanText(result?.title || "");
  const snippet = cleanText(result?.snippet || "");
  const parsedUrl = parseUrlSafely(result?.url || "");
  const pathname = String(parsedUrl?.pathname || "");
  const sourceDomain = String(parsedUrl?.hostname || "").replace(/^www\./i, "").toLowerCase();
  const combined = `${title}\n${snippet}\n${pathname}`;
  const surfaceType = classifySearchResultSurface(result);
  const experiment = getSearchExperimentConfig(experimentVariant);
  const staleCycleSignal = hasStaleCycleSignals(combined);
  const indirectContentSignal = hasIndirectContentSignals(`${title}\n${snippet}`, sourceDomain, pathname);
  const { institutionSpecificSignal, specificSchoolSignal } = detectInstitutionSignals(combined, sourceDomain);
  const homepageSignal = isLikelyScholarshipHomepage(result);
  const personal = profile?.personalInfo || {};
  const academics = profile?.academics || {};
  const major = personal.intendedMajor;
  const ethnicity = personal.ethnicity;
  const state = normalizeStateValue(personal.state);
  const stageTerms = getStagePositiveTerms(studentStage, academics.gradeLevel);

  let score = 0;
  // Surface type is a weak structural prior, not a strong quality judgment.
  if (surfaceType === "direct_likely") score += experiment.surfaceDirectBonus;
  else if (surfaceType === "hub_likely") score += experiment.surfaceHubBonus;
  else if (surfaceType === "list_likely") score -= experiment.surfaceListPenalty;

  if (/\b(scholarship|grant|award|fellowship)\b/i.test(combined)) score += experiment.scholarshipKeywordBonus;
  if (/\b(apply|eligibility|deadline|award amount|application)\b/i.test(combined)) score += experiment.actionKeywordBonus;
  if (
    /\b(blog|directory|guide|financial aid|resource center|advice)\b/i.test(combined)
    || /^blog\./i.test(sourceDomain)
  ) {
    score -= experiment.genericBlogPenalty;
  }
  if (indirectContentSignal) score -= experiment.indirectPenalty;
  if (staleCycleSignal) score -= experiment.stalePenalty;
  if (institutionSpecificSignal) score -= experiment.institutionPenalty;
  if (specificSchoolSignal) score -= experiment.specificSchoolPenalty;
  if (homepageSignal) score -= experiment.homepagePenalty;
  if (isLikelyScholarshipDetailPath(pathname)) score += experiment.directDetailPathBonus;
  if (/\bscholarship program\b/i.test(combined)) score += experiment.scholarshipProgramBonus;
  if (
    experiment.pluralScholarshipsPenalty > 0
    && /\bscholarships\b/i.test(title)
    && !/\b(apply|eligibility|deadline|award amount|application)\b/i.test(combined)
    && !isLikelyScholarshipDetailPath(pathname)
  ) {
    score -= experiment.pluralScholarshipsPenalty;
  }

  const resultMajors = extractMajors(combined);
  const majorMatches = resultMajors.some((rule) => ruleMatchesValue(rule, major));
  const exactMajorMatch = resultMajors.some((rule) => normalizeText(rule) === normalizeText(major));
  const broadOnlyEngineering = normalizeText(major).includes("engineering")
    && resultMajors.includes("engineering")
    && !exactMajorMatch;
  if (majorMatches) score += 4;
  else if (resultMajors.length > 0) score -= 1;
  if (exactMajorMatch) score += experiment.exactMajorBonus;
  if (broadOnlyEngineering) score -= experiment.broadOnlyEngineeringPenalty;

  const resultEthnicities = extractEthnicities(combined);
  if (resultEthnicities.some((rule) => ruleMatchesValue(rule, ethnicity))) score += 2.5;
  else if (resultEthnicities.length > 0) score -= 1.5;

  const resultStates = extractStates(combined);
  if (state && resultStates.includes(state)) score += 1.5;
  else if (state && resultStates.length > 0) score -= 0.5;

  for (const term of stageTerms) {
    if (stageTermMatchesText(term, combined)) {
      score += 1.5;
    }
  }
  if (normalizeText(studentStage) === "starting_college" && /\b(juniors?|seniors?|sophomores?|upperclass(?:men)?|currently enrolled|current undergraduate students?|current college students?|undergraduate retention|retention grant)\b/i.test(combined)) {
    score -= 4.5;
  }
  if (normalizeText(studentStage) === "starting_college" && /\b(graduate|doctoral|doctorate|phd|masters?|grad school|fellowships?)\b/i.test(combined)) {
    score -= 5;
  }

  if (allowDomains.some((hint) => domainMatchesHint(sourceDomain, hint))) {
    score += 1.25;
  }

  return Number(score.toFixed(3));
}

function parseBraveWebSearchResults(payload, query, limit = MAX_SEARCH_RESULTS_PER_QUERY) {
  const results = [];
  const webResults = Array.isArray(payload?.web?.results) ? payload.web.results : [];
  for (const item of webResults) {
    if (results.length >= limit) break;
    const url = cleanText(item?.url);
    const title = cleanText(item?.title);
    if (!/^https?:\/\//i.test(url) || !title) continue;
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

async function fetchJson(url, {
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  headers = {}
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch implementation is required for scholarship_web_search");
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

function dedupeResults(results = []) {
  const bestByUrl = new Map();
  for (const result of results) {
    const key = String(result?.normalizedUrl || "");
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

export async function scholarshipWebSearch({
  queries = [],
  profile = {},
  studentStage = "",
  maxResultsPerQuery = 8,
  domainAllowHints = [],
  domainDenyHints = [],
  queryFamily = "",
  runContext = {},
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  concurrency = DEFAULT_SEARCH_CONCURRENCY,
  braveApiKey = String(process.env.BRAVE_SEARCH_API_KEY || process.env.DISCOVERY_BRAVE_API_KEY || "").trim(),
  urlHistory = null,
  experimentVariant = DEFAULT_EXPERIMENT_VARIANT
} = {}) {
  const normalizedQueries = uniqueStrings(queries);
  if (normalizedQueries.length === 0) {
    throw new Error("queries must be a non-empty array");
  }
  if (!braveApiKey) {
    throw new Error("Brave Search API key is missing. Set BRAVE_SEARCH_API_KEY or DISCOVERY_BRAVE_API_KEY.");
  }

  const allowHints = uniqueStrings(domainAllowHints).map(normalizeDomainHint).filter(Boolean);
  const denyHints = uniqueStrings(domainDenyHints).map(normalizeDomainHint).filter(Boolean);
  const historyMap = urlHistory instanceof Map ? urlHistory : await loadDiscoveryUrlHistory();
  const recentDomainCounts = buildRecentDomainCounts(historyMap);
  const skippedQueries = [];
  const notes = [];

  const queryResults = await mapWithConcurrency(normalizedQueries, concurrency, async (query) => {
    const endpoint = new URL(BRAVE_SEARCH_ENDPOINT);
    endpoint.searchParams.set("q", query);
    endpoint.searchParams.set("count", String(Math.min(MAX_SEARCH_RESULTS_PER_QUERY, Math.max(1, Number(maxResultsPerQuery) || 1))));
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
      skippedQueries.push({
        query,
        reason: `provider_error:${response.status}${providerMessage ? `:${providerMessage}` : ""}`
      });
      return [];
    }
    if (!response.json || typeof response.json !== "object") {
      skippedQueries.push({
        query,
        reason: "provider_non_json_response"
      });
      return [];
    }
    return parseBraveWebSearchResults(response.json, query, maxResultsPerQuery);
  });

  const filteredOutDeniedDomains = [];
  const annotated = queryResults
    .flat()
    .map((result) => {
      const parsedUrl = parseUrlSafely(result.url);
      const sourceDomain = String(parsedUrl?.hostname || "").replace(/^www\./i, "").toLowerCase();
      const normalizedUrl = normalizeDiscoveryUrl(result.url);
      const surfaceType = classifySearchResultSurface(result);
      const fitScore = scoreSearchResultFitLikelihood(result, profile, studentStage, allowHints, experimentVariant);
      const noveltyScore = scoreSearchResultNovelty(result, historyMap, recentDomainCounts);
      const historyDecision = shouldSkipUrlByHistory(result.url, historyMap, Date.now());
      const combined = `${result.title}\n${result.snippet}\n${parsedUrl?.pathname || ""}`;
      const sourceDomainLooksBloggy = /^blog\./i.test(sourceDomain) || /\.blog\./i.test(sourceDomain);
      const staleCycleSignal = hasStaleCycleSignals(combined);
      const indirectContentSignal = hasIndirectContentSignals(`${result.title}\n${result.snippet}`, sourceDomain, parsedUrl?.pathname || "");
      const { institutionSpecificSignal, specificSchoolSignal } = detectInstitutionSignals(combined, sourceDomain);

      return {
        query: result.query,
        title: result.title,
        url: result.url,
        normalizedUrl,
        snippet: result.snippet,
        sourceDomain,
        providerRank: result.rank,
        queryFamily: cleanText(queryFamily),
        fitScore,
        noveltyScore,
        heuristics: {
          surfaceType,
          majorMatch: extractMajors(combined).some((rule) => ruleMatchesValue(rule, profile?.personalInfo?.intendedMajor)),
          ethnicityMatch: extractEthnicities(combined).some((rule) => ruleMatchesValue(rule, profile?.personalInfo?.ethnicity)),
          stateMatch: Boolean(
            normalizeStateValue(profile?.personalInfo?.state)
            && extractStates(combined).includes(normalizeStateValue(profile?.personalInfo?.state))
          ),
          stageMatch: getStagePositiveTerms(studentStage, profile?.academics?.gradeLevel).some((term) => (
            stageTermMatchesText(term, combined)
          )),
          negativeGraduateSignal: /\b(graduate|doctoral|doctorate|phd|masters?|grad school|fellowships?)\b/i.test(combined),
          negativeBlogSignal: sourceDomainLooksBloggy || /\b(blog|resource center|advice|tips|how to win|guide)\b/i.test(combined),
          negativeDirectorySignal: surfaceType === "list_likely" || /\b(directory|roundup|browse scholarships|top scholarships)\b/i.test(combined),
          institutionSpecificSignal,
          specificSchoolSignal,
          staleCycleSignal,
          indirectContentSignal,
          sameDomainAsPriorHit: false,
          seenRecently: historyDecision.skip,
          noveltyScore
        },
        traceMeta: {
          round: Number(runContext?.round || 1) || 1
        }
      };
    })
    .filter((result) => {
      if (!result.sourceDomain) return false;
      const denied = denyHints.some((hint) => domainMatchesHint(result.sourceDomain, hint));
      if (denied) {
        filteredOutDeniedDomains.push(result.sourceDomain);
        return false;
      }
      return true;
    });

  const sorted = dedupeResults(annotated).sort((left, right) => (
    (right.fitScore || 0) - (left.fitScore || 0)
    || (right.noveltyScore || 0) - (left.noveltyScore || 0)
    || (left.providerRank || 0) - (right.providerRank || 0)
  ));

  const seenDomains = new Set();
  const results = sorted.map((result) => {
    const sameDomainAsPriorHit = seenDomains.has(result.sourceDomain);
    seenDomains.add(result.sourceDomain);
    return {
      query: result.query,
      title: result.title,
      url: result.url,
      normalizedUrl: result.normalizedUrl,
      snippet: result.snippet,
      sourceDomain: result.sourceDomain,
      providerRank: result.providerRank,
      queryFamily: result.queryFamily,
      fitScore: result.fitScore,
      heuristics: {
        ...result.heuristics,
        sameDomainAsPriorHit
      },
      traceMeta: result.traceMeta
    };
  });

  if (allowHints.length > 0) {
    notes.push(`allow_domain_hints=${allowHints.join(",")}`);
  }
  if (denyHints.length > 0) {
    notes.push(`deny_domain_hints=${denyHints.join(",")}`);
  }
  if (filteredOutDeniedDomains.length > 0) {
    notes.push(`filtered_denied_domains=${uniqueStrings(filteredOutDeniedDomains).join(",")}`);
  }
  if (normalizeText(experimentVariant) && normalizeText(experimentVariant) !== DEFAULT_EXPERIMENT_VARIANT) {
    notes.push(`experiment_variant=${normalizeText(experimentVariant)}`);
  }

  return {
    provider: {
      name: "brave_search",
      requestCount: normalizedQueries.length,
      variant: normalizeText(experimentVariant) || DEFAULT_EXPERIMENT_VARIANT
    },
    results,
    skippedQueries,
    notes
  };
}
