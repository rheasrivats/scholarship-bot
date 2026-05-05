import {
  loadDiscoveryUrlHistory,
  normalizeDiscoveryUrl,
  shouldSkipUrlByHistory
} from "./discoveryHistoryStore.js";

const SEARCH_USER_AGENT = "ScholarshipBot/0.1 (+batch-fetch-page-bundles)";
const DEFAULT_FETCH_TIMEOUT_MS = 12000;
const DEFAULT_PAGE_CONCURRENCY = 4;
const MAX_URLS_PER_BATCH = 6;
const MAX_TEXT_CHARS_PER_PAGE = 4000;
const MAX_SNIPPET_CHARS = 400;
const MAX_CHILD_LINKS_PER_PAGE = 15;
const MAX_CHILD_LINKS_RETURNED_TOTAL = 50;
const MAX_PAGE_HTML_LENGTH = 350000;
const MAX_PAGE_TEXT_LENGTH = 60000;
const MAX_REQUIREMENT_SENTENCES = 8;
const MONTH_INDEX_BY_NAME = new Map([
  ["jan", 0], ["january", 0],
  ["feb", 1], ["february", 1],
  ["mar", 2], ["march", 2],
  ["apr", 3], ["april", 3],
  ["may", 4],
  ["jun", 5], ["june", 5],
  ["jul", 6], ["july", 6],
  ["aug", 7], ["august", 7],
  ["sep", 8], ["sept", 8], ["september", 8],
  ["oct", 9], ["october", 9],
  ["nov", 10], ["november", 10],
  ["dec", 11], ["december", 11]
]);

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

function truncateText(value, maxChars) {
  const text = cleanText(value);
  const limit = Math.max(0, Number(maxChars) || 0);
  if (!text || !limit || text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 3)).trim()}...`;
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
    if (upper === abbr || normalizeText(raw) === name.toLowerCase()) return abbr;
  }
  return upper.length === 2 ? upper : raw;
}

function normalizeProfileStudentStage(studentStage = "", gradeLevel = "") {
  const normalizedStage = normalizeText(studentStage);
  if (normalizedStage) return normalizedStage;
  const normalizedGrade = normalizeText(gradeLevel);
  if (!normalizedGrade) return "";
  if (/\b(12th|high school senior|grade 12|senior)\b/.test(normalizedGrade)) return "starting_college";
  if (/\b(9th|10th|11th|high school|junior in high school|sophomore in high school)\b/.test(normalizedGrade)) return "pre_college";
  if (/\b(college|undergraduate|freshman in college|sophomore|junior|senior in college|transfer)\b/.test(normalizedGrade)) return "in_college";
  return "";
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
  const regex = new RegExp(`<meta[^>]+${attrName}=["']${attrValue}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i");
  const match = String(html || "").match(regex);
  return cleanText(decodeHtmlEntities(match?.[1] || ""));
}

function extractDocumentTitle(html) {
  const explicit = extractMetaContent(html, "property", "og:title") || extractMetaContent(html, "name", "twitter:title");
  if (explicit) return explicit;
  const titleMatch = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return cleanText(decodeHtmlEntities(titleMatch?.[1] || ""));
}

function extractHeading(html) {
  const h1Match = String(html || "").match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  return cleanText(decodeHtmlEntities(stripTags(h1Match?.[1] || "")));
}

function choosePageTitle(html, fallbackUrl = "") {
  const heading = extractHeading(html);
  const documentTitle = extractDocumentTitle(html);
  if (heading && documentTitle) {
    const headingLooksScholarship = /\b(scholarship|grant|award|fellowship)\b/i.test(heading);
    const documentLooksScholarship = /\b(scholarship|grant|award|fellowship)\b/i.test(documentTitle);
    if (documentLooksScholarship && !headingLooksScholarship) return documentTitle;
    return heading;
  }
  return heading || documentTitle || cleanText(fallbackUrl);
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
  const structuredEligibilityDetail = /\b(major|majoring|degree|studying|study|enrolled|resident|citizen|gpa|background|ethnicity|race|state|freshman|junior|senior|undergraduate|graduate)\b/i;
  const matches = sentences.filter((sentence) => (
    explicitRequirementCue.test(sentence)
      || (subjectRequirementCue.test(sentence) && structuredEligibilityDetail.test(sentence) && /\b(must|eligible|open to|required|minimum|at least)\b/i.test(sentence))
  ));
  return matches.slice(0, MAX_REQUIREMENT_SENTENCES);
}

function parseCurrencyValue(value) {
  const numeric = Number(String(value || "").replace(/[$,]/g, ""));
  if (!Number.isFinite(numeric)) return null;
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
      if (amount !== null) values.push(amount);
    }
  }
  if (values.length === 0) {
    for (const match of text.matchAll(/\$\s?\d[\d,]*(?:\.\d{2})?/g)) {
      const amount = parseCurrencyValue(match[0]);
      if (amount !== null) values.push(amount);
    }
  }
  return values.length === 0 ? 0 : Math.max(...values);
}

function normalizeDateString(raw) {
  const value = cleanText(raw);
  if (!value) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(value)) {
    const [month, day, year] = value.split("/");
    const normalizedYear = year.length === 2 ? `20${year}` : year;
    return `${normalizedYear.padStart(4, "0")}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }
  const monthNameMatch = value.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4})$/);
  if (monthNameMatch) {
    const parsed = new Date(`${monthNameMatch[1]} ${monthNameMatch[2]}, ${monthNameMatch[3]}`);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  }
  if (!/\d{4}/.test(value)) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toISOString().slice(0, 10);
}

function extractDeadline(text) {
  const patterns = [
    /(?:deadline|apply by|applications?\s+due|due date|submission deadline)[^.\n:]{0,40}?[:\-]?\s*\b([A-Z][a-z]{2,8}\s+\d{1,2},\s+\d{4})\b/i,
    /(?:deadline|apply by|applications?\s+due|due date|submission deadline)[^.\n:]{0,40}?[:\-]?\s*\b(\d{1,2}\/\d{1,2}\/\d{2,4})\b/i,
    /(?:deadline|apply by|applications?\s+due|due date|submission deadline)[^.\n:]{0,40}?[:\-]?\s*\b([A-Z][a-z]{2,8}\s+\d{1,2})\b/i,
    /(?:application\s+closes?|applications?\s+close|closes?\s+on|close\s+date|closing\s+date)[^.\n:]{0,40}?[:\-]?\s*\b([A-Z][a-z]{2,8}\s+\d{1,2},\s+\d{4})\b/i,
    /(?:application\s+closes?|applications?\s+close|closes?\s+on|close\s+date|closing\s+date)[^.\n:]{0,40}?[:\-]?\s*\b(\d{1,2}\/\d{1,2}\/\d{2,4})\b/i,
    /(?:application\s+closes?|applications?\s+close|closes?\s+on|close\s+date|closing\s+date)[^.\n:]{0,40}?[:\-]?\s*\b([A-Z][a-z]{2,8}\s+\d{1,2})\b/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return normalizeDateString(match[1]);
  }
  return "";
}

function extractPartialDeadlineMonthDay(text) {
  const patterns = [
    /(?:deadline|apply by|applications?\s+due|due date|submission deadline)[^.\n:]{0,40}?[:\-]?\s*\b([A-Z][a-z]{2,8})\s+(\d{1,2})\b(?!\s*,?\s*\d{4})/i,
    /(?:application\s+closes?|applications?\s+close|closes?\s+on|close\s+date|closing\s+date)[^.\n:]{0,40}?[:\-]?\s*\b([A-Z][a-z]{2,8})\s+(\d{1,2})\b(?!\s*,?\s*\d{4})/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const monthIndex = MONTH_INDEX_BY_NAME.get(normalizeText(match?.[1] || ""));
    const day = Number(match?.[2] || 0);
    if (monthIndex !== undefined && Number.isInteger(day) && day >= 1 && day <= 31) {
      return { monthIndex, day };
    }
  }
  return null;
}

function isExpiredPartialDeadline(partialDeadline, now = new Date()) {
  if (!partialDeadline) return false;
  const current = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(current.getTime())) return false;
  const currentMonth = current.getUTCMonth();
  const currentDay = current.getUTCDate();
  if (partialDeadline.monthIndex < currentMonth) return true;
  if (partialDeadline.monthIndex > currentMonth) return false;
  return partialDeadline.day < currentDay;
}

function isExpiredIsoDeadline(value, now = new Date()) {
  const deadline = cleanText(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline)) return false;
  const current = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(current.getTime())) return false;
  const today = current.toISOString().slice(0, 10);
  return deadline < today;
}

function detectClosedScholarship(text, title = "") {
  return /\b(applications? closed|deadline has passed|no longer accepting applications|scholarship closed|closed for this cycle)\b/i.test(`${title}\n${text}`);
}

function extractRequiredStudentStages(statements, title = "") {
  const relevantText = [
    /\b(high school|freshman|first[- ]year|undergraduate|graduate|junior|senior|sophomore|college student|university student)\b/i.test(title)
      ? title
      : "",
    ...(Array.isArray(statements) ? statements : [])
  ].filter(Boolean).join(" ");
  if (!relevantText) return [];
  const requiredStages = [];
  if (/\b(graduate|graduate students?|doctoral|doctorate|phd|masters?|master'?s|grad(?:uate)? school)\b/i.test(relevantText)) {
    requiredStages.push("graduate");
  }
  if (/\b(high school students?|high school senior(?:s)?|secondary school students?)\b/i.test(relevantText)) {
    requiredStages.push("high_school");
  }
  if (/\b(incoming (?:college )?freshm(?:a)?n|entering (?:college )?freshm(?:a)?n|new freshm(?:a)?n|entering first[- ]year|incoming first[- ]year|first[- ]year college|college freshmen?|entering students?|incoming students?|new students?|incoming transfers?|incoming transfer students?)\b/i.test(relevantText)) {
    requiredStages.push("incoming_freshman");
  }
  if (/\b(undergraduate students?|undergraduate student|college students?|university students?)\b/i.test(relevantText)) {
    requiredStages.push("undergraduate");
  }
  if (/\b(sophomores?|juniors?|seniors?|upperclass(?:men)?|currently enrolled|current undergraduate students?|current college students?|students? enrolled at|attending (?:a |an )?(?:college|university)|enrolled (?:within|at|in) (?:a |an )?(?:college|university|school)|college student member|third[- ]year|fourth[- ]year)\b/i.test(relevantText)) {
    requiredStages.push("continuing_college");
  }
  return uniqueStrings(requiredStages);
}

function computeStageMatchSignal(requiredStudentStages = [], normalizedStudentStage = "") {
  if (!Array.isArray(requiredStudentStages) || requiredStudentStages.length === 0) {
    return false;
  }
  if (normalizedStudentStage === "starting_college") {
    return requiredStudentStages.includes("incoming_freshman")
      || requiredStudentStages.includes("high_school")
      || (requiredStudentStages.includes("undergraduate")
        && !requiredStudentStages.includes("continuing_college")
        && !requiredStudentStages.includes("graduate"));
  }
  if (normalizedStudentStage === "in_college") {
    return requiredStudentStages.includes("continuing_college")
      || requiredStudentStages.includes("undergraduate")
      || requiredStudentStages.includes("incoming_freshman");
  }
  return false;
}

function computeExplicitStageMismatchSignal(requiredStudentStages = [], normalizedStudentStage = "", stageMatchSignal = false) {
  if (!Array.isArray(requiredStudentStages) || requiredStudentStages.length === 0 || stageMatchSignal) {
    return false;
  }
  if (normalizedStudentStage === "starting_college") {
    return requiredStudentStages.includes("graduate") || requiredStudentStages.includes("continuing_college");
  }
  if (normalizedStudentStage === "in_college") {
    return requiredStudentStages.includes("graduate")
      || (requiredStudentStages.includes("high_school") && !requiredStudentStages.includes("incoming_freshman") && !requiredStudentStages.includes("undergraduate"));
  }
  return false;
}

function collectMatchesFromRules(text, rules) {
  const values = [];
  for (const rule of rules) {
    if (rule.pattern.test(text)) values.push(...rule.values);
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
    if (namePattern.test(normalized) || abbrPattern.test(normalized)) matches.push(abbr);
  }
  return uniqueStrings(matches);
}

function ruleMatchesValue(rule, value) {
  const normalizedRule = normalizeText(rule);
  const normalizedValue = normalizeText(value);
  if (!normalizedRule || !normalizedValue) return false;
  return normalizedValue === normalizedRule || normalizedValue.includes(normalizedRule) || normalizedRule.includes(normalizedValue);
}

function hasStaleCycleSignals(text, { currentYear = new Date().getUTCFullYear() } = {}) {
  const combined = cleanText(text);
  if (!combined) return false;
  const yearMatches = [...combined.matchAll(/\b(20\d{2})\b/g)].map((match) => Number(match[1]));
  if (yearMatches.length === 0) return false;
  const hasCurrentOrFutureYear = yearMatches.some((year) => year >= currentYear);
  const hasPastYear = yearMatches.some((year) => year < currentYear);
  if (!hasPastYear || hasCurrentOrFutureYear) return false;
  return /\b(deadline|application|apply|applications?|award year|academic year|semester|fall|spring|currently open|opens?|renewable|scholarship)\b/i.test(combined);
}

function hasIndirectContentSignals(text, sourceDomain = "", pathname = "") {
  const combined = `${cleanText(text)} ${cleanText(sourceDomain)} ${cleanText(pathname)}`;
  if (!combined) return false;
  if (/^blog\./i.test(sourceDomain) || /\/blog\//i.test(pathname)) return true;
  return /\b(these scholarship applications are currently open|you can apply today|our guide|this guide|how to win|tips for|best scholarships|top \d+|list of scholarships|browse scholarships|learn more on the website of)\b/i.test(combined);
}

function hasAggregatorSummarySignals(text, sourceDomain = "", pathname = "") {
  const combined = `${cleanText(text)} ${cleanText(pathname)}`;
  if (!combined) return false;
  if (/\b(accessscholarships\.com|scholarships360\.org|scholarships\.com|collegescholarships\.(?:com|org)|fastweb\.com|bold\.org|unigo\.com|niche\.com|usnews\.com)\b/i.test(sourceDomain)) {
    return true;
  }
  if (/\/scholarship-directory\b|\/scholarships-by-|\/scholarships\/by-|\/scholarships\/search\//i.test(pathname)) {
    return true;
  }
  return /\b(scholarship search|scholarship directory|print scholarship|see something that's not right|submit a scholarship|featured scholarships|scholarships by state|scholarships by major)\b/i.test(combined);
}

function isLikelyScholarshipDetailPath(pathname) {
  const path = String(pathname || "").toLowerCase();
  if (!path || path === "/") return false;
  if (/\/(by-major|by-state|types|type|category|categories|directory|financial-aid)\//i.test(path)) return false;
  if (/\/scholarships\/search\/[^/]+\/?$/i.test(path)) return true;
  if (/\/scholarships?\/[^/]+\/?$/i.test(path) && !/\/scholarships?\/?(?:$|search\/?$)/i.test(path)) return true;
  return /\/(?:award|grant|fellowship|scholarship)-[a-z0-9-]+\/?$/i.test(path);
}

function isLikelyScholarshipHubPath(pathname) {
  const path = String(pathname || "").toLowerCase();
  if (!path || path === "/") return false;
  if (/\/(by-major|by-state|types|type|category|categories|directory|financial-aid)\//i.test(path)) return false;
  if (/\/scholarships?\/?$/.test(path)) return true;
  if (/\/(students-and-faculty|student[s-]?and-?faculty|undergraduate|graduate|admissions|programs?)\/.*scholarships?\/?$/i.test(path)) return true;
  return /\/(?:available|department|college|school)-[a-z0-9-]*scholarships?\/?$/i.test(path);
}

function looksLikeListPage(title, url, text, html = "") {
  const value = `${title}\n${url}\n${text}`;
  const parsedUrl = parseUrlSafely(url);
  const pathname = String(parsedUrl?.pathname || "").toLowerCase();
  const childLinkCount = extractChildLinks(html, url, new Map(), { maxLinks: 50 }).length;
  if (/\b(top \d+|best scholarships|list of scholarships|scholarships for students|scholarship directory|roundup|browse scholarships|scholarship lists?)\b/i.test(value)) {
    return true;
  }
  if (/\/scholarships?\/?$/.test(pathname) || /\/scholarships\/scholarships\/?$/.test(pathname)) {
    return true;
  }
  if (/\/(by-major|by-state|types|type|category|categories|directory|financial-aid)\//i.test(pathname)) {
    return true;
  }
  const titleLower = String(title || "").toLowerCase();
  const pluralScholarshipTitle = /\bscholarships\b/i.test(titleLower);
  const pluralScholarshipPath = /\/scholarships\/|[-_/]scholarships(?:[-_/]|$)/i.test(String(url || "").toLowerCase());
  const likelyApplicationPage = /\b(apply|application|guidelines|eligibility|program)\b/i.test(value);
  if ((pluralScholarshipTitle || pluralScholarshipPath) && childLinkCount >= 2 && !likelyApplicationPage) return true;
  if ((pluralScholarshipTitle || pluralScholarshipPath) && childLinkCount >= 2) return true;
  return false;
}

function extractEvidenceSnippet(sentences, patterns = [], maxChars = MAX_SNIPPET_CHARS) {
  for (const sentence of sentences) {
    if (patterns.some((pattern) => pattern.test(sentence))) return truncateText(sentence, maxChars);
  }
  return null;
}

function scoreChildLinkCandidate({ anchorText, pathname, sameDomain }) {
  const anchor = cleanText(anchorText);
  const path = String(pathname || "");
  const combined = `${anchor} ${path}`;
  let score = 0;
  if (/\bscholarship\b/i.test(anchor)) score += 3;
  if (/\baward\b|\bgrant\b/i.test(anchor)) score += 2;
  if (/\bfellowship\b/i.test(anchor)) score += 1;
  if (isLikelyScholarshipDetailPath(path)) score += 4;
  if (/\/scholarships?\//i.test(path)) score += 2;
  if (anchor && !/\bscholarships\b/i.test(anchor)) score += 1;
  if (/\b(high school|freshman|first[- ]year|undergraduate|college)\b/i.test(combined)) score += 1.5;
  if (/\b(graduate|doctoral|doctorate|phd|masters?|fellowships?)\b/i.test(combined)) score -= 2.5;
  if (!sameDomain) score -= 0.5;
  return score;
}

function hasOriginalSourceLink(childLinks = [], pageDomain = "") {
  const normalizedPageDomain = String(pageDomain || "").replace(/^www\./i, "").toLowerCase();
  return (Array.isArray(childLinks) ? childLinks : []).some((link) => {
    const anchor = cleanText(link?.anchorText || "");
    const sourceDomain = String(link?.sourceDomain || "").replace(/^www\./i, "").toLowerCase();
    if (!sourceDomain || sourceDomain === normalizedPageDomain) return false;
    return /\b(apply|apply online|application|official|website|learn more|more information)\b/i.test(anchor)
      || Boolean(link?.detailPathLikely);
  });
}

function extractChildLinks(html, baseUrl, historyMap, { maxLinks = MAX_CHILD_LINKS_PER_PAGE } = {}) {
  const parsedBaseUrl = parseUrlSafely(baseUrl);
  if (!parsedBaseUrl) return [];
  const links = [];
  const regex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  let position = 0;
  while ((match = regex.exec(String(html || "")))) {
    position += 1;
    const href = cleanText(decodeHtmlEntities(match[1]));
    const anchorText = cleanText(decodeHtmlEntities(stripTags(match[2])));
    if (!href || /^#|^javascript:|^mailto:|^tel:/i.test(href)) continue;
    let resolved;
    try {
      resolved = new URL(href, parsedBaseUrl);
    } catch {
      continue;
    }
    if (!/^https?:$/i.test(resolved.protocol)) continue;
    const normalizedUrl = normalizeDiscoveryUrl(resolved.toString());
    if (!normalizedUrl || normalizedUrl === normalizeDiscoveryUrl(parsedBaseUrl.toString())) continue;
    const sameDomain = resolved.hostname === parsedBaseUrl.hostname;
    const combined = `${anchorText} ${resolved.pathname}`.toLowerCase();
    if (/\.(pdf|docx?|xlsx?)$/i.test(resolved.pathname)) continue;
    if (/\b(login|sign in|privacy|terms|contact|about|faq|blog|home|menu|search)\b/i.test(combined)) continue;
    if (!/\b(scholarship|award|fellowship|grant|apply|application|program)\b/i.test(combined)) continue;
    links.push({
      url: normalizedUrl,
      anchorText: truncateText(anchorText || resolved.pathname.split("/").pop() || normalizedUrl, 120),
      sourceDomain: String(resolved.hostname || "").replace(/^www\./i, "").toLowerCase(),
      sameDomain,
      detailPathLikely: isLikelyScholarshipDetailPath(resolved.pathname),
      seenRecently: shouldSkipUrlByHistory(normalizedUrl, historyMap, Date.now()).skip,
      score: scoreChildLinkCandidate({ anchorText, pathname: resolved.pathname, sameDomain }),
      position
    });
  }
  const bestByUrl = new Map();
  for (const item of links) {
    const existing = bestByUrl.get(item.url);
    if (!existing || item.score > existing.score) bestByUrl.set(item.url, item);
  }
  return [...bestByUrl.values()]
    .sort((a, b) => b.score - a.score || a.position - b.position)
    .slice(0, Math.max(1, Number(maxLinks) || 1))
    .map(({ score, position, ...rest }) => rest);
}

async function fetchText(url, { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch implementation is required for batch_fetch_page_bundles");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        "user-agent": SEARCH_USER_AGENT,
        accept: "text/html,application/xhtml+xml"
      },
      signal: controller.signal
    });
    const contentType = String(response.headers?.get?.("content-type") || "");
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      contentType,
      text,
      finalUrl: String(response.url || url || "")
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

function buildPageBundle({
  requestedUrl,
  finalUrl,
  html,
  contentType,
  httpStatus,
  profile,
  studentStage,
  maxTextCharsPerPage,
  maxSnippetChars,
  maxChildLinksPerPage,
  runContext,
  historyMap,
  now
}) {
  const canonicalUrl = normalizeDiscoveryUrl(finalUrl || requestedUrl || "");
  const parsedUrl = parseUrlSafely(canonicalUrl);
  const sourceDomain = String(parsedUrl?.hostname || "").replace(/^www\./i, "").toLowerCase();
  const fullText = htmlToText(html);
  const title = choosePageTitle(html, canonicalUrl || requestedUrl);
  const requirementStatements = extractRequirementSentences(fullText);
  const sentences = splitIntoSentences(fullText);
  const stageSentences = sentences.filter((sentence) => (
    /\b(high school|freshman|first[- ]year|undergraduate|graduate|junior|senior|sophomore|third[- ]year|fourth[- ]year|incoming students?|transfer students?)\b/i.test(sentence)
  ));
  const deadline = extractDeadline(fullText);
  const awardAmount = extractAwardAmount(fullText);
  const requiredStudentStages = extractRequiredStudentStages([...requirementStatements, ...stageSentences], title);
  const normalizedStudentStage = normalizeProfileStudentStage(studentStage, profile?.academics?.gradeLevel || profile?.academics?.currentGradeLevel || "");

  const majorText = `${title}\n${fullText}`;
  const majorMatchSignal = extractMajors(majorText).some((rule) => ruleMatchesValue(rule, profile?.personalInfo?.intendedMajor));
  const ethnicityMatchSignal = extractEthnicities(majorText).some((rule) => ruleMatchesValue(rule, profile?.personalInfo?.ethnicity));
  const stateMatchSignal = Boolean(normalizeStateValue(profile?.personalInfo?.state) && extractStates(majorText).includes(normalizeStateValue(profile?.personalInfo?.state)));
  const stageMatchSignal = computeStageMatchSignal(requiredStudentStages, normalizedStudentStage);
  const explicitStageMismatchSignal = computeExplicitStageMismatchSignal(requiredStudentStages, normalizedStudentStage, stageMatchSignal);
  const institutionSpecificSignal = /\.edu$/i.test(sourceDomain)
    || /\b(university|college|department|school of|student member|member institution|campus)\b/i.test(`${title}\n${fullText.slice(0, 3000)}`);
  const specificSchoolSignal = /\.edu$/i.test(sourceDomain)
    || /\b(at|from|enrolled at|accepted into)\s+(ucla|uc ?irvine|uc ?berkeley|montana state|stanford|san jose state|cal poly|university|college)\b/i.test(`${title}\n${fullText.slice(0, 3000)}`)
    || /\b(department|school of engineering|college of engineering|campus|incoming students?|current students?)\b/i.test(`${title}\n${fullText.slice(0, 3000)}`);

  const childLinks = extractChildLinks(html, canonicalUrl, historyMap, { maxLinks: maxChildLinksPerPage });
  const indirectContentSignal = hasIndirectContentSignals(`${title}\n${fullText.slice(0, 3000)}`, sourceDomain, parsedUrl?.pathname || "");
  const aggregatorSummarySignal = hasAggregatorSummarySignals(`${title}\n${fullText.slice(0, 5000)}`, sourceDomain, parsedUrl?.pathname || "");
  const originalSourceLinkSignal = hasOriginalSourceLink(childLinks, sourceDomain);
  const partialDeadline = extractPartialDeadlineMonthDay(fullText);
  const expiredPartialDeadlineSignal = isExpiredPartialDeadline(partialDeadline, now);
  const listSignal = looksLikeListPage(title, canonicalUrl, fullText, html) || aggregatorSummarySignal;
  const directScholarshipSignal = !listSignal && !indirectContentSignal && !aggregatorSummarySignal && (
    isLikelyScholarshipDetailPath(parsedUrl?.pathname || "")
      || (/\b(scholarship|grant|fellowship|award)\b/i.test(title) && !/\bscholarships\b/i.test(title))
      || ((awardAmount > 0 ? 1 : 0) + (deadline ? 1 : 0) + (requirementStatements.length > 0 ? 1 : 0) >= 2)
  );
  const hubSignal = !directScholarshipSignal && (
    isLikelyScholarshipHubPath(parsedUrl?.pathname || "")
      || (/\bscholarships\b/i.test(title) && institutionSpecificSignal)
  );
  const closedSignal = detectClosedScholarship(fullText, title) || isExpiredIsoDeadline(deadline, now) || expiredPartialDeadlineSignal;
  const pastCycleSignal = hasStaleCycleSignals(`${title}\n${fullText.slice(0, 6000)}`);
  const applicationSignal = /\b(apply|application deadline|how to apply|common application|apply now|application portal)\b/i.test(`${title}\n${fullText}`);
  const truncatedText = fullText.length > maxTextCharsPerPage;

  return {
    requestedUrl,
    canonicalUrl,
    fetchStatus: "ok",
    httpStatus,
    contentType,
    sourceDomain,
    title,
    textExcerpt: truncateText(fullText, maxTextCharsPerPage),
    evidenceSnippets: {
      deadlineSnippet: extractEvidenceSnippet(sentences, [/\b(deadline|apply by|applications?\s+due|due date|submission deadline|application\s+closes?|applications?\s+close|closes?\s+on|close\s+date|closing\s+date)\b/i], maxSnippetChars),
      eligibilitySnippet: extractEvidenceSnippet(requirementStatements.length > 0 ? requirementStatements : sentences, [/\b(must|required|eligible|open to|restricted to|limited to|minimum|citizen|resident|major|majoring|enrolled|pursuing)\b/i], maxSnippetChars),
      amountSnippet: extractEvidenceSnippet(sentences, [/\$\s?\d[\d,]*(?:\.\d{2})?/, /\b(award|scholarship|grant|fellowship|up to)\b/i], maxSnippetChars),
      stageRestrictionSnippet: extractEvidenceSnippet(stageSentences.length > 0 ? stageSentences : (requirementStatements.length > 0 ? requirementStatements : sentences), [/\b(high school|freshman|first[- ]year|undergraduate|graduate|junior|senior|sophomore|third[- ]year|fourth[- ]year)\b/i], maxSnippetChars),
      closedSnippet: extractEvidenceSnippet(sentences, [/\b(applications? closed|deadline has passed|no longer accepting applications|closed for this cycle|application\s+closes?|applications?\s+close|closes?\s+on|close\s+date|closing\s+date)\b/i], maxSnippetChars)
    },
    blockers: {
      closedSignal,
      pastCycleSignal,
      explicitStageMismatchSignal,
      accessBlockedSignal: false
    },
    fitSignals: {
      majorMatchSignal,
      ethnicityMatchSignal,
      stateMatchSignal,
      stageMatchSignal,
      institutionSpecificSignal,
      specificSchoolSignal
    },
    pageSignals: {
      directScholarshipSignal,
      hubSignal,
      listSignal,
      deadlineSignal: Boolean(deadline || partialDeadline),
      awardAmountSignal: awardAmount > 0,
      eligibilitySignal: requirementStatements.length > 0,
      applicationSignal,
      indirectContentSignal: indirectContentSignal || aggregatorSummarySignal,
      aggregatorSummarySignal,
      originalSourceLinkSignal
    },
    childLinks,
    traceMeta: {
      round: Number(runContext?.round || 1) || 1,
      depth: Number(runContext?.depth || 0) || 0,
      textCharsReturned: truncateText(fullText, maxTextCharsPerPage).length,
      childLinksReturned: childLinks.length,
      truncatedText,
      truncatedChildLinks: false
    }
  };
}

export async function batchFetchPageBundles({
  urls = [],
  profile = {},
  studentStage = "",
  maxTextCharsPerPage = MAX_TEXT_CHARS_PER_PAGE,
  maxSnippetChars = MAX_SNIPPET_CHARS,
  maxChildLinksPerPage = MAX_CHILD_LINKS_PER_PAGE,
  runContext = {},
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  concurrency = DEFAULT_PAGE_CONCURRENCY,
  urlHistory = null,
  now = new Date()
} = {}) {
  const normalizedUrls = uniqueStrings(urls)
    .filter((value) => /^https?:\/\//i.test(value))
    .slice(0, MAX_URLS_PER_BATCH);
  if (normalizedUrls.length === 0) {
    throw new Error("urls must be a non-empty array");
  }

  const boundedTextCharsPerPage = Math.min(MAX_TEXT_CHARS_PER_PAGE, Math.max(250, Number(maxTextCharsPerPage) || MAX_TEXT_CHARS_PER_PAGE));
  const boundedSnippetChars = Math.min(MAX_SNIPPET_CHARS, Math.max(80, Number(maxSnippetChars) || MAX_SNIPPET_CHARS));
  const boundedChildLinksPerPage = Math.min(MAX_CHILD_LINKS_PER_PAGE, Math.max(1, Number(maxChildLinksPerPage) || MAX_CHILD_LINKS_PER_PAGE));
  const historyMap = urlHistory instanceof Map ? urlHistory : await loadDiscoveryUrlHistory();
  const notes = [];
  let truncatedPages = Array.isArray(urls) && urls.length > normalizedUrls.length;

  const fetched = await mapWithConcurrency(normalizedUrls, concurrency, async (requestedUrl) => {
    try {
      const response = await fetchText(requestedUrl, { fetchImpl, timeoutMs });
      const canonicalUrl = normalizeDiscoveryUrl(response.finalUrl || requestedUrl);
      if (!response.ok) {
        return {
          requestedUrl,
          canonicalUrl,
          fetchStatus: "error",
          httpStatus: response.status,
          contentType: response.contentType,
          sourceDomain: String(parseUrlSafely(canonicalUrl)?.hostname || "").replace(/^www\./i, "").toLowerCase(),
          title: cleanText(canonicalUrl || requestedUrl),
          textExcerpt: "",
          evidenceSnippets: {
            deadlineSnippet: null,
            eligibilitySnippet: null,
            amountSnippet: null,
            stageRestrictionSnippet: null,
            closedSnippet: null
          },
          blockers: {
            closedSignal: false,
            pastCycleSignal: false,
            explicitStageMismatchSignal: false,
            accessBlockedSignal: true
          },
          fitSignals: {
            majorMatchSignal: false,
            ethnicityMatchSignal: false,
            stateMatchSignal: false,
            stageMatchSignal: false,
            institutionSpecificSignal: false,
            specificSchoolSignal: false
          },
          pageSignals: {
            directScholarshipSignal: false,
            hubSignal: false,
            listSignal: false,
            deadlineSignal: false,
            awardAmountSignal: false,
            eligibilitySignal: false,
            applicationSignal: false,
            indirectContentSignal: false,
            aggregatorSummarySignal: false,
            originalSourceLinkSignal: false
          },
          childLinks: [],
          traceMeta: {
            round: Number(runContext?.round || 1) || 1,
            depth: Number(runContext?.depth || 0) || 0,
            textCharsReturned: 0,
            childLinksReturned: 0,
            truncatedText: false,
            truncatedChildLinks: false
          }
        };
      }
      if (response.contentType && !/html|xml/i.test(response.contentType)) {
        return {
          requestedUrl,
          canonicalUrl,
          fetchStatus: "unsupported_content_type",
          httpStatus: response.status,
          contentType: response.contentType,
          sourceDomain: String(parseUrlSafely(canonicalUrl)?.hostname || "").replace(/^www\./i, "").toLowerCase(),
          title: cleanText(canonicalUrl || requestedUrl),
          textExcerpt: "",
          evidenceSnippets: {
            deadlineSnippet: null,
            eligibilitySnippet: null,
            amountSnippet: null,
            stageRestrictionSnippet: null,
            closedSnippet: null
          },
          blockers: {
            closedSignal: false,
            pastCycleSignal: false,
            explicitStageMismatchSignal: false,
            accessBlockedSignal: true
          },
          fitSignals: {
            majorMatchSignal: false,
            ethnicityMatchSignal: false,
            stateMatchSignal: false,
            stageMatchSignal: false,
            institutionSpecificSignal: false,
            specificSchoolSignal: false
          },
          pageSignals: {
            directScholarshipSignal: false,
            hubSignal: false,
            listSignal: false,
            deadlineSignal: false,
            awardAmountSignal: false,
            eligibilitySignal: false,
            applicationSignal: false,
            indirectContentSignal: false,
            aggregatorSummarySignal: false,
            originalSourceLinkSignal: false
          },
          childLinks: [],
          traceMeta: {
            round: Number(runContext?.round || 1) || 1,
            depth: Number(runContext?.depth || 0) || 0,
            textCharsReturned: 0,
            childLinksReturned: 0,
            truncatedText: false,
            truncatedChildLinks: false
          }
        };
      }

      return buildPageBundle({
        requestedUrl,
        finalUrl: response.finalUrl || requestedUrl,
        html: String(response.text || "").slice(0, MAX_PAGE_HTML_LENGTH),
        contentType: response.contentType,
        httpStatus: response.status,
        profile,
        studentStage,
        maxTextCharsPerPage: boundedTextCharsPerPage,
        maxSnippetChars: boundedSnippetChars,
        maxChildLinksPerPage: boundedChildLinksPerPage,
        runContext,
        historyMap,
        now
      });
    } catch (error) {
      return {
        requestedUrl,
        canonicalUrl: normalizeDiscoveryUrl(requestedUrl),
        fetchStatus: "error",
        httpStatus: 0,
        contentType: "",
        sourceDomain: String(parseUrlSafely(requestedUrl)?.hostname || "").replace(/^www\./i, "").toLowerCase(),
        title: cleanText(requestedUrl),
        textExcerpt: "",
        evidenceSnippets: {
          deadlineSnippet: null,
          eligibilitySnippet: null,
          amountSnippet: null,
          stageRestrictionSnippet: null,
          closedSnippet: null
        },
        blockers: {
          closedSignal: false,
          pastCycleSignal: false,
          explicitStageMismatchSignal: false,
          accessBlockedSignal: true
        },
        fitSignals: {
          majorMatchSignal: false,
          ethnicityMatchSignal: false,
          stateMatchSignal: false,
          stageMatchSignal: false,
          institutionSpecificSignal: false,
          specificSchoolSignal: false
        },
        pageSignals: {
          directScholarshipSignal: false,
          hubSignal: false,
          listSignal: false,
          deadlineSignal: false,
          awardAmountSignal: false,
          eligibilitySignal: false,
          applicationSignal: false,
          indirectContentSignal: false,
          aggregatorSummarySignal: false,
          originalSourceLinkSignal: false
        },
        childLinks: [],
        traceMeta: {
          round: Number(runContext?.round || 1) || 1,
          depth: Number(runContext?.depth || 0) || 0,
          textCharsReturned: 0,
          childLinksReturned: 0,
          truncatedText: false,
          truncatedChildLinks: false
        }
      };
    }
  });

  let remainingChildLinkBudget = MAX_CHILD_LINKS_RETURNED_TOTAL;
  let truncatedChildLinksTotal = false;
  const pages = fetched.map((page) => {
    const allowed = Math.max(0, remainingChildLinkBudget);
    const limitedChildLinks = page.childLinks.slice(0, allowed);
    const truncatedChildLinks = limitedChildLinks.length < page.childLinks.length;
    remainingChildLinkBudget -= limitedChildLinks.length;
    if (truncatedChildLinks) truncatedChildLinksTotal = true;
    return {
      ...page,
      childLinks: limitedChildLinks,
      traceMeta: {
        ...page.traceMeta,
        childLinksReturned: limitedChildLinks.length,
        truncatedChildLinks
      }
    };
  });

  if (truncatedPages) {
    notes.push(`clamped_urls=${normalizedUrls.length}`);
  }
  if (boundedTextCharsPerPage !== Number(maxTextCharsPerPage || 0) && maxTextCharsPerPage) {
    notes.push(`clamped_text_chars=${boundedTextCharsPerPage}`);
  }
  if (boundedSnippetChars !== Number(maxSnippetChars || 0) && maxSnippetChars) {
    notes.push(`clamped_snippet_chars=${boundedSnippetChars}`);
  }
  if (boundedChildLinksPerPage !== Number(maxChildLinksPerPage || 0) && maxChildLinksPerPage) {
    notes.push(`clamped_child_links_per_page=${boundedChildLinksPerPage}`);
  }
  if (truncatedChildLinksTotal) {
    notes.push(`clamped_child_links_total=${MAX_CHILD_LINKS_RETURNED_TOTAL}`);
  }

  return {
    pages,
    meta: {
      requestedUrlCount: Array.isArray(urls) ? urls.filter((value) => /^https?:\/\//i.test(String(value || ""))).length : 0,
      returnedPageCount: pages.length,
      truncatedPages,
      truncatedChildLinksTotal,
      responseCharBudgetApplied: true
    },
    notes
  };
}
