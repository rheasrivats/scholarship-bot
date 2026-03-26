import { createEmptyStudentProfile } from "../schemas/studentProfileSchema.js";

function applyCandidate({ merged, fieldPath, value, confidence, sourceDocumentId }) {
  const [root, child] = fieldPath.split(".");
  const existingValue = merged[root][child];
  const existingConfidence = merged.extractionConfidence[fieldPath] ?? -1;

  if (existingValue === null || existingValue === undefined || confidence > existingConfidence) {
    if (existingValue && existingValue !== value) {
      merged.conflicts.push({
        fieldPath,
        previousValue: existingValue,
        incomingValue: value,
        chosenValue: value,
        chosenSourceDocumentId: sourceDocumentId
      });
    }

    merged[root][child] = value;
    merged.extractionConfidence[fieldPath] = confidence;
    merged.fieldProvenance[fieldPath] = sourceDocumentId;
    return;
  }

  if (existingValue !== value) {
    merged.conflicts.push({
      fieldPath,
      previousValue: existingValue,
      incomingValue: value,
      chosenValue: existingValue,
      chosenSourceDocumentId: merged.fieldProvenance[fieldPath]
    });
  }
}

export function mergeExtractedProfiles(extractedProfiles) {
  const merged = createEmptyStudentProfile();

  for (const extracted of extractedProfiles) {
    const { sourceDocumentId, profile } = extracted;

    for (const [fieldPath, confidence] of Object.entries(profile.extractionConfidence)) {
      const [root, child] = fieldPath.split(".");
      const value = profile[root]?.[child];
      if (value === null || value === undefined || value === "") {
        continue;
      }

      applyCandidate({
        merged,
        fieldPath,
        value,
        confidence,
        sourceDocumentId
      });
    }

    merged.activities = Array.from(new Set([...merged.activities, ...profile.activities]));
    merged.awards = Array.from(new Set([...merged.awards, ...profile.awards]));
    merged.essays = [...merged.essays, ...profile.essays];
  }

  return merged;
}
