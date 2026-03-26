import { shouldBlockAutofill, maskSensitiveValue } from "./safetyFilter.js";

function getValueByPath(obj, path) {
  return path
    .split(".")
    .reduce((acc, key) => (acc && key in acc ? acc[key] : undefined), obj);
}

export function createNoAccountAutofillDraft({ scholarship, profile }) {
  const autofillFields = [];
  const manualFields = [];

  for (const field of scholarship.formFields) {
    const isFileField = String(field.fieldType || "").toLowerCase() === "file";
    const value = getValueByPath(profile, field.sourcePath);

    if (isFileField) {
      manualFields.push({
        fieldName: field.fieldName,
        displayLabel: field.displayLabel,
        mappingReason: field.mappingReason,
        fieldType: "file",
        acceptedFileTypes: field.acceptedFileTypes,
        essayPrompt: field.essayPrompt,
        reason: "File upload required by scholarship form"
      });
      continue;
    }

    if (value === null || value === undefined || value === "") {
      manualFields.push({
        fieldName: field.fieldName,
        displayLabel: field.displayLabel,
        mappingReason: field.mappingReason,
        fieldType: field.fieldType,
        acceptedFileTypes: field.acceptedFileTypes,
        essayPrompt: field.essayPrompt,
        reason: "No mapped value available"
      });
      continue;
    }

    if (shouldBlockAutofill({ fieldName: field.fieldName, value: String(value) })) {
      manualFields.push({
        fieldName: field.fieldName,
        displayLabel: field.displayLabel,
        mappingReason: field.mappingReason,
        fieldType: field.fieldType,
        acceptedFileTypes: field.acceptedFileTypes,
        essayPrompt: field.essayPrompt,
        reason: "Sensitive field manual entry required",
        maskedPreview: maskSensitiveValue(String(value))
      });
      continue;
    }

    autofillFields.push({
      fieldName: field.fieldName,
      displayLabel: field.displayLabel,
      mappingReason: field.mappingReason,
      fieldType: field.fieldType,
      essayPrompt: field.essayPrompt,
      value: String(value),
      sourcePath: field.sourcePath
    });
  }

  return {
    scholarshipId: scholarship.id,
    scholarshipName: scholarship.name,
    requiresAccount: scholarship.requiresAccount === true,
    sourceDomain: scholarship.sourceDomain,
    sourceUrl: scholarship.sourceUrl || "",
    essayPrompts: Array.isArray(scholarship.essayPrompts) ? scholarship.essayPrompts : [],
    formMappingMeta: scholarship.formMappingMeta || null,
    autofillFields,
    manualFields,
    readyForReview: true
  };
}
