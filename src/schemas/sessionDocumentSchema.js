export function createSessionDocument({ sessionId, documentId, documentType, filePath, rawText }) {
  return {
    sessionId,
    documentId,
    documentType,
    filePath,
    rawText,
    parsedFields: {},
    parseConfidence: {},
    uploadedAt: new Date().toISOString()
  };
}
