import { createEmptyStudentProfile } from "../schemas/studentProfileSchema.js";

function firstMatch(text, regex) {
  const match = text.match(regex);
  return match?.[1]?.trim() || null;
}

function cleanValue(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeLabelMatchText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function lineContainsLabelPhrase(line, label) {
  const normalizedLine = normalizeLabelMatchText(line);
  const normalizedLabel = normalizeLabelMatchText(label);
  if (!normalizedLine || !normalizedLabel) return false;
  if (normalizedLine === normalizedLabel) return true;
  if (normalizedLine.startsWith(`${normalizedLabel} `)) return true;
  if (normalizedLine.endsWith(` ${normalizedLabel}`)) return true;
  return normalizedLine.includes(` ${normalizedLabel} `);
}

function findFieldValue(text, labels) {
  const lines = text.split("\n");
  const normalizedLabels = labels.map((label) => String(label || "").toLowerCase().trim()).filter(Boolean);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const lower = line.toLowerCase();

    for (const label of normalizedLabels) {
      if (!lineContainsLabelPhrase(lower, label)) {
        continue;
      }

      const tabValueMatch = line.match(/\t+(.+)$/);
      if (tabValueMatch?.[1]) {
        return cleanValue(tabValueMatch[1]);
      }

      const colonValueMatch = line.match(/:\s*(.+)$/);
      if (colonValueMatch?.[1]) {
        return cleanValue(colonValueMatch[1]);
      }

      const trimmedLine = line.trimStart();
      const trimmedLower = lower.trimStart();
      if (trimmedLower.startsWith(label)) {
        const afterLabel = trimmedLine.slice(label.length).replace(/^[:\-\t\s]+/, "").trim();
        if (afterLabel) {
          return cleanValue(afterLabel);
        }
      }

      let j = i + 1;
      while (j < lines.length) {
        const next = cleanValue(lines[j]);
        if (!next || /^--\s*\d+\s+of\s+\d+\s*--$/i.test(next)) {
          j += 1;
          continue;
        }

        return next;
      }
    }
  }

  return null;
}

function parseActivities(text) {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.filter((line) => /^activity\s*:/i.test(line)).map((line) => line.replace(/^activity\s*:/i, "").trim());
}

function parseAwards(text) {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.filter((line) => /^award\s*:/i.test(line)).map((line) => line.replace(/^award\s*:/i, "").trim());
}

const UC_ACTIVITY_AWARD_LABELS = new Set([
  "program name",
  "program description",
  "activity name",
  "activity description",
  "course name",
  "course description",
  "organization, group or program name",
  "organization, group or program description",
  "description of volunteer experience",
  "name of the award or honor",
  "level of recognition",
  "type of award",
  "grade participation",
  "grade level when awarded",
  "time commitment",
  "award requirements",
  "what you did to earn award"
]);

function parseUcActivitiesAndAwards(rawText) {
  const lines = rawText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !isPageMarkerLine(line));

  const startIdx = lines.findIndex((line) => /^activities\/awards$/i.test(line));
  if (startIdx < 0) {
    return { activities: [], awards: [] };
  }

  const endIdx = lines.findIndex((line, idx) => idx > startIdx && /^personal insight/i.test(line));
  const section = lines.slice(startIdx + 1, endIdx > startIdx ? endIdx : undefined);

  const entries = [];
  let current = null;
  let currentLabel = null;

  const flush = () => {
    if (!current) {
      return;
    }

    const values = {};
    for (const [label, parts] of Object.entries(current.values)) {
      values[label] = cleanValue(parts.join(" "));
    }

    entries.push({
      index: current.index,
      kind: current.kind,
      values
    });
  };

  for (const line of section) {
    const entryMatch = line.match(/^(\d+)\.\s+(.+)$/);
    if (entryMatch) {
      flush();
      current = {
        index: Number(entryMatch[1]),
        kind: cleanValue(entryMatch[2]),
        values: {}
      };
      currentLabel = null;
      continue;
    }

    if (!current) {
      continue;
    }

    const normalized = line.toLowerCase();
    if (UC_ACTIVITY_AWARD_LABELS.has(normalized)) {
      currentLabel = normalized;
      if (!current.values[currentLabel]) {
        current.values[currentLabel] = [];
      }
      continue;
    }

    if (currentLabel) {
      current.values[currentLabel].push(line);
    }
  }

  flush();

  const activities = [];
  const awards = [];

  for (const entry of entries) {
    const isAward = /award or honor/i.test(entry.kind);
    if (isAward) {
      const name = entry.values["name of the award or honor"] || "Unnamed award";
      const type = entry.values["type of award"] || "";
      const grade = entry.values["grade level when awarded"] || "";
      const summary = cleanValue(`${name}${type ? ` (${type})` : ""}${grade ? ` - ${grade}` : ""}`);
      awards.push(summary);
      continue;
    }

    const name = (
      entry.values["activity name"]
      || entry.values["program name"]
      || entry.values["course name"]
      || entry.values["organization, group or program name"]
      || entry.kind
    );
    const description = (
      entry.values["activity description"]
      || entry.values["program description"]
      || entry.values["course description"]
      || entry.values["description of volunteer experience"]
      || entry.values["organization, group or program description"]
      || ""
    );
    const summary = cleanValue(`${name}${description ? ` - ${description.slice(0, 160)}` : ""}`);
    activities.push(summary);
  }

  return {
    activities: Array.from(new Set(activities.filter(Boolean))),
    awards: Array.from(new Set(awards.filter(Boolean)))
  };
}

function parseUcHighSchoolName(rawText) {
  const match = rawText.match(/High schools[\s\S]{0,300}?\n([A-Z][A-Z0-9 '&.\-]+SCHOOL)\n/i);
  return match?.[1] ? cleanValue(match[1]) : null;
}

function parseUcCurrentGradeLevel(rawText) {
  const sectionMatch = rawText.match(/Grades attended([\s\S]{0,220})/i);
  if (!sectionMatch?.[1]) {
    return null;
  }

  const gradeLines = sectionMatch[1]
    .split("\n")
    .map((line) => cleanValue(line))
    .filter((line) => /^\d{1,2}(st|nd|rd|th)\s+grade$/i.test(line));

  if (gradeLines.length === 0) {
    return null;
  }

  return gradeLines[gradeLines.length - 1];
}

function parseStateValue(rawText) {
  const candidates = [
    firstMatch(rawText, /(?:^|\n)\s*State\s*\t+([^\n]+)/im),
    firstMatch(rawText, /(?:^|\n)\s*State\s*\n([^\n]+)/im),
    firstMatch(rawText, /(?:^|\n)\s*State\s*:\s*([^\n]+)/im),
    firstMatch(rawText, /(?:^|\n)\s*State\/Province\s*\n([^\n]+)/im)
  ]
    .map((value) => cleanValue(value))
    .filter(Boolean);

  for (const value of candidates) {
    if (/(student id|ssid|school code|code|number)/i.test(value)) continue;
    if (/^[A-Za-z]{2}$/.test(value) || /^[A-Za-z][A-Za-z .'-]{2,40}$/.test(value)) {
      return value;
    }
  }

  return null;
}

function parseUcPrimaryMajor(rawText) {
  const chooseMajorsBlockMatch = rawText.match(/Choose majors([\s\S]{0,4500})/i);
  if (!chooseMajorsBlockMatch?.[1]) return null;

  const section = chooseMajorsBlockMatch[1]
    .split(/\n/)
    .map((line) => cleanValue(line))
    .filter((line) => line && !isPageMarkerLine(line));

  const stripCampusPrefix = (value) => String(value || "")
    .replace(
      /^UC\s+(Davis|Merced|Riverside|Santa Barbara|Berkeley|Irvine|Los Angeles|San Diego|Santa Cruz)\s+/i,
      ""
    )
    .trim();

  const normalizeMajorLine = (line) => {
    const strippedLine = stripCampusPrefix(line);
    const degreePrefix = strippedLine.split(/,\s*B\.[A-Z.]+/i)[0];
    const cleaned = cleanValue(degreePrefix);
    if (!cleaned) return null;
    if (/(undergraduate|undeclared|alternate major|school of|college of|campus\s+major|do you want to select)/i.test(cleaned)) {
      return null;
    }
    return cleaned;
  };

  for (let i = 0; i < section.length; i += 1) {
    const line = section[i];
    if (!/^UC\s+[A-Za-z]/.test(line)) continue;

    if (/,\s*B\.[A-Z.]+/i.test(line)) {
      const major = normalizeMajorLine(line);
      if (major) return major;
    }

    for (let j = i + 1; j < Math.min(section.length, i + 6); j += 1) {
      const candidateLine = section[j];
      if (/^UC\s+[A-Za-z]/.test(candidateLine)) break;
      if (/,\s*B\.[A-Z.]+/i.test(candidateLine)) {
        const major = normalizeMajorLine(candidateLine);
        if (major) return major;
      }
    }
  }

  return null;
}

function inferEthnicity(text) {
  const hispanicLineValue = firstMatch(text, /hispanic\s*\/\s*latino\s*\t+([^\n]+)/i);
  if (hispanicLineValue) {
    return "hispanic/latino";
  }

  if (/do you consider yourself hispanic or latino\?\s*(?:\t| )*yes/i.test(text)) {
    return "hispanic/latino";
  }

  const explicitEthnicityLabel = firstMatch(text, /(?:^|\n)\s*ethnicity\s*:\s*([^\n]+)/i);
  if (explicitEthnicityLabel) {
    return cleanValue(explicitEthnicityLabel);
  }

  const explicit = findFieldValue(text, ["race/ethnicity"]);
  if (explicit) {
    return explicit;
  }

  if (/\bhispanic\s*\/\s*latino\b/i.test(text)) {
    return "hispanic/latino";
  }

  return null;
}

function isPageMarkerLine(line) {
  return /^--\s*\d+\s+of\s+\d+\s*--$/i.test(line);
}

function looksLikePromptStart(line) {
  const normalized = cleanValue(line).toLowerCase();
  return (
    normalized.startsWith("describe an example of your leadership experience")
    || normalized.startsWith("describe how you have taken advantage of a significant educational opportunity")
    || normalized.startsWith("describe the most significant challenge")
    || normalized.startsWith("think about an academic subject that inspires you")
    || normalized.startsWith("what have you done to make your school or your community a better place")
    || normalized.startsWith("what would you say is your greatest talent or skill")
    || normalized.startsWith("every person has a creative side")
    || normalized.startsWith("beyond what has already been shared in your application")
  );
}

function lineLooksLikeResponseStart(line) {
  const normalized = cleanValue(line);
  return /^(I|My|Ever|From|Growing|Since|When|As|Baseball|One|This|That)\b/.test(normalized);
}

function extractUcPersonalInsightEssays(rawText, sourceDocumentId) {
  const startMatch = rawText.match(/Personal insight questions/i);
  if (!startMatch?.index && startMatch?.index !== 0) {
    return [];
  }

  const startIndex = startMatch.index;
  const rest = rawText.slice(startIndex);
  const endMatch = rest.match(/\n(?:Additional comments|Verified information)\b/i);
  const section = endMatch ? rest.slice(0, endMatch.index) : rest;

  const lines = section
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !isPageMarkerLine(line));

  const essays = [];
  let i = 0;

  while (i < lines.length) {
    if (!looksLikePromptStart(lines[i])) {
      i += 1;
      continue;
    }

    const promptLines = [lines[i]];
    i += 1;

    while (
      i < lines.length
      && !looksLikePromptStart(lines[i])
      && !lineLooksLikeResponseStart(lines[i])
      && promptLines.length < 4
    ) {
      promptLines.push(lines[i]);
      if (/[?.]$/.test(lines[i])) {
        i += 1;
        break;
      }
      i += 1;
    }

    const responseLines = [];
    while (i < lines.length && !looksLikePromptStart(lines[i])) {
      responseLines.push(lines[i]);
      i += 1;
    }

    const prompt = cleanValue(promptLines.join(" "));
    const content = cleanValue(responseLines.join(" "));

    if (content.length > 120) {
      essays.push({
        id: `${sourceDocumentId}-essay-${essays.length + 1}`,
        prompt,
        content,
        sourceDocumentId
      });
    }
  }

  return essays;
}

export function extractProfileFromText(rawText, sourceDocumentId) {
  const profile = createEmptyStudentProfile();

  const firstName = findFieldValue(rawText, ["first / given name", "first name"]);
  const middleName = findFieldValue(rawText, ["middle name"]);
  const lastName = findFieldValue(rawText, ["last / family / surname", "last name", "surname"]);
  const composedFullName = [firstName, middleName, lastName].filter(Boolean).join(" ").trim();

  const addressLine1 = findFieldValue(rawText, ["address line 1", "street address", "mailing address line 1"]);
  const addressLine2 = findFieldValue(rawText, ["address line 2", "apt, suite, unit, building, etc.", "apartment", "suite"]);
  const city = firstMatch(rawText, /(?:^|\n)\s*City\s*\t+([^\n]+)/im) || findFieldValue(rawText, ["city"]);
  const state = parseStateValue(rawText) || findFieldValue(rawText, ["state/province", "state"]);
  const postalCode = firstMatch(rawText, /(?:^|\n)\s*ZIP code\s*\t+([^\n]+)/im) || findFieldValue(rawText, ["zip code", "postal code"]);
  const country = findFieldValue(rawText, ["country"]);
  const dateOfBirth = findFieldValue(rawText, ["when were you born?", "date of birth"]);
  const composedAddress = [addressLine1, addressLine2, city, state, postalCode, country].filter(Boolean).join(", ");

  const majorFromChooseMajors = parseUcPrimaryMajor(rawText);

  const extracted = {
    "personalInfo.fullName": composedFullName || findFieldValue(rawText, ["student name", "name", "first / given name"]),
    "personalInfo.email": findFieldValue(rawText, ["email address", "email"]),
    "personalInfo.phone": findFieldValue(rawText, ["primary phone number", "phone"]),
    "personalInfo.address": composedAddress || findFieldValue(rawText, ["address", "mailing address"]),
    "personalInfo.addressLine1": addressLine1,
    "personalInfo.addressLine2": addressLine2,
    "personalInfo.city": city,
    "personalInfo.state": state,
    "personalInfo.postalCode": postalCode,
    "personalInfo.country": country,
    "personalInfo.dateOfBirth": dateOfBirth,
    "personalInfo.intendedMajor": majorFromChooseMajors || findFieldValue(rawText, ["intended major", "academic major or interest", "major(s)"]),
    "personalInfo.ethnicity": inferEthnicity(rawText),
    "academics.gpa": firstMatch(rawText, /(?:gpa|grade point average)\s*:?\s*([0-9]+(?:\.[0-9]+)?)/i),
    "academics.graduationYear": firstMatch(rawText, /(?:graduation year|class of)\s*:?\s*([0-9]{4})/i),
    "academics.schoolName": parseUcHighSchoolName(rawText) || findFieldValue(rawText, ["school you will graduate from", "school name", "high school name", "current school"]),
    "academics.gradeLevel": findFieldValue(rawText, ["current grade level", "select grade level"]) || parseUcCurrentGradeLevel(rawText)
  };

  const ucStructured = parseUcActivitiesAndAwards(rawText);
  profile.activities = Array.from(new Set([...parseActivities(rawText), ...ucStructured.activities]));
  profile.awards = Array.from(new Set([...parseAwards(rawText), ...ucStructured.awards]));

  for (const [fieldPath, value] of Object.entries(extracted)) {
    if (value === null || value === "") {
      continue;
    }

    const [root, child] = fieldPath.split(".");
    profile[root][child] = value;
    profile.extractionConfidence[fieldPath] = 0.8;
    profile.fieldProvenance[fieldPath] = sourceDocumentId;
  }

  const ucPersonalInsightEssays = extractUcPersonalInsightEssays(rawText, sourceDocumentId);
  if (ucPersonalInsightEssays.length > 0) {
    profile.essays = ucPersonalInsightEssays;
    return profile;
  }

  const essayBlocks = rawText
    .split(/\n\s*\n/g)
    .map((block) => block.trim())
    .filter((block) => block.length > 400)
    .slice(0, 6);

  profile.essays = essayBlocks.map((content, index) => ({
    id: `${sourceDocumentId}-essay-${index + 1}`,
    content,
    sourceDocumentId
  }));

  return profile;
}
