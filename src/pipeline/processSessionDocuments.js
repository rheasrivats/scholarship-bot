import { parseDocumentText, parseDocumentBuffer } from "../parsers/documentParser.js";
import { createSessionDocument } from "../schemas/sessionDocumentSchema.js";
import { extractProfileFromText } from "../profile/extractStudentProfile.js";
import { mergeExtractedProfiles } from "../profile/mergeProfiles.js";
import { enrichProfileWithAi } from "../profile/aiEnrichProfile.js";

function inferDocumentType(filePath) {
  const lower = filePath.toLowerCase();
  if (lower.includes("uc")) {
    return "uc_application";
  }
  if (lower.includes("scholarship")) {
    return "scholarship_application";
  }
  if (lower.includes("private")) {
    return "private_school_application";
  }
  return "other";
}

export async function processSessionDocuments({
  sessionId,
  documents,
  enableAiEnrichment = false,
  aiTimeoutMs = 45000
}) {
  const sessionDocuments = [];
  const extractedProfiles = [];

  for (const document of documents) {
    const sourceName = document.fileName || document.filePath || document.documentId || "document";
    let rawText;

    if (document.rawText) {
      rawText = document.rawText;
    } else if (document.fileBuffer) {
      rawText = await parseDocumentBuffer(document.fileBuffer, sourceName);
    } else if (document.filePath) {
      rawText = await parseDocumentText(document.filePath);
    } else {
      throw new Error("Document must include one of: rawText, fileBuffer, or filePath");
    }

    const documentType = document.documentType || inferDocumentType(sourceName);

    const sessionDoc = createSessionDocument({
      sessionId,
      documentId: document.documentId,
      documentType,
      filePath: document.filePath || sourceName,
      rawText
    });

    const profile = extractProfileFromText(rawText, document.documentId);
    sessionDocuments.push(sessionDoc);
    extractedProfiles.push({ sourceDocumentId: document.documentId, profile });
  }

  const mergedProfile = mergeExtractedProfiles(extractedProfiles);
  const aiEnrichment = enableAiEnrichment
    ? await enrichProfileWithAi({
        mergedProfile,
        documents: sessionDocuments,
        timeoutMs: aiTimeoutMs
      })
    : { profile: mergedProfile, metadata: { mode: "disabled" } };

  return {
    sessionId,
    documents: sessionDocuments,
    mergedProfile: aiEnrichment.profile,
    aiEnrichment: aiEnrichment.metadata
  };
}
