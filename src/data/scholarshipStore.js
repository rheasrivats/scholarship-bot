import fs from "node:fs/promises";
import path from "node:path";
import { createScholarship, TRUSTED_SOURCE_TIERS } from "../schemas/scholarshipSchema.js";

const DATA_FILE_PATH = path.resolve(process.cwd(), "data/scholarships.vetted.json");

let cachedScholarships = null;

function validateSourceTier(value) {
  return value === TRUSTED_SOURCE_TIERS.TIER_1
    || value === TRUSTED_SOURCE_TIERS.TIER_2
    || value === TRUSTED_SOURCE_TIERS.TIER_3;
}

function normalizeList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }

  if (typeof value === "string") {
    return value.split("|").map((item) => item.trim()).filter(Boolean);
  }

  return [];
}

function normalizeFormFields(formFields) {
  if (!Array.isArray(formFields)) {
    return [];
  }

  return formFields
    .filter((field) => field && field.fieldName && field.sourcePath)
    .map((field) => ({
      fieldName: String(field.fieldName).trim(),
      sourcePath: String(field.sourcePath).trim(),
      displayLabel: field.displayLabel ? String(field.displayLabel).trim() : undefined,
      mappingReason: field.mappingReason ? String(field.mappingReason).trim() : undefined,
      fieldType: field.fieldType ? String(field.fieldType).trim() : undefined,
      acceptedFileTypes: field.acceptedFileTypes ? String(field.acceptedFileTypes).trim() : undefined,
      essayPrompt: field.essayPrompt ? String(field.essayPrompt).trim() : undefined
    }));
}

export function normalizeScholarshipRecord(record) {
  if (!record || typeof record !== "object") {
    throw new Error("Scholarship record must be an object");
  }

  const required = ["id", "name", "sourceDomain", "sourceTier"];
  for (const key of required) {
    if (!record[key]) {
      throw new Error(`Scholarship missing required field: ${key}`);
    }
  }

  if (!validateSourceTier(record.sourceTier)) {
    throw new Error(`Invalid sourceTier '${record.sourceTier}' for scholarship '${record.id}'`);
  }

  return createScholarship({
    id: String(record.id).trim(),
    name: String(record.name).trim(),
    sourceDomain: String(record.sourceDomain).trim(),
    sourceTier: String(record.sourceTier).trim(),
    requiresAccount: Boolean(record.requiresAccount),
    awardAmount: Number(record.awardAmount || 0),
    deadline: record.deadline ? String(record.deadline).trim() : "",
    estimatedEffortMinutes: Number(record.estimatedEffortMinutes || 30),
    eligibility: {
      minGpa: record.eligibility?.minGpa === null || record.eligibility?.minGpa === undefined || record.eligibility?.minGpa === ""
        ? null
        : Number(record.eligibility.minGpa),
      allowedMajors: normalizeList(record.eligibility?.allowedMajors),
      allowedEthnicities: normalizeList(record.eligibility?.allowedEthnicities)
    },
    essayPrompts: normalizeList(record.essayPrompts),
    formFields: normalizeFormFields(record.formFields),
    sourceName: record.sourceName ? String(record.sourceName).trim() : undefined,
    sourceUrl: record.sourceUrl ? String(record.sourceUrl).trim() : undefined,
    verifiedAt: record.verifiedAt ? String(record.verifiedAt).trim() : undefined,
    notes: record.notes ? String(record.notes).trim() : undefined,
    formMappingMeta: record.formMappingMeta && typeof record.formMappingMeta === "object"
      ? {
        mode: record.formMappingMeta.mode ? String(record.formMappingMeta.mode).trim() : undefined,
        sourceUrl: record.formMappingMeta.sourceUrl ? String(record.formMappingMeta.sourceUrl).trim() : undefined,
        updatedAt: record.formMappingMeta.updatedAt ? String(record.formMappingMeta.updatedAt).trim() : undefined,
        fallbackReason: record.formMappingMeta.fallbackReason ? String(record.formMappingMeta.fallbackReason).trim() : undefined
      }
      : undefined
  });
}

export async function loadScholarships({ forceReload = false } = {}) {
  if (!forceReload && cachedScholarships) {
    return cachedScholarships;
  }

  const raw = await fs.readFile(DATA_FILE_PATH, "utf8");
  const records = JSON.parse(raw);
  if (!Array.isArray(records)) {
    throw new Error("Scholarship data file must contain a JSON array");
  }

  cachedScholarships = records.map(normalizeScholarshipRecord);
  return cachedScholarships;
}

export async function replaceScholarships(records) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error("Replacement scholarships payload must be a non-empty array");
  }

  const normalized = records.map(normalizeScholarshipRecord);
  await fs.writeFile(DATA_FILE_PATH, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  cachedScholarships = normalized;
  return normalized;
}

export function getScholarshipsDataFilePath() {
  return DATA_FILE_PATH;
}
