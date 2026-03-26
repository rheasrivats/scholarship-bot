#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs/promises";
import { parseDocumentText } from "../parsers/documentParser.js";
import { extractProfileFromText } from "../profile/extractStudentProfile.js";

function parseArgs(argv) {
  const args = {
    file: null,
    documentId: "debug-doc",
    showRawText: false,
    showFullEssays: false,
    outFile: null
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (token === "--file") {
      args.file = path.resolve(process.cwd(), argv[i + 1]);
      i += 1;
      continue;
    }

    if (token === "--document-id") {
      args.documentId = argv[i + 1];
      i += 1;
      continue;
    }

    if (token === "--show-raw-text") {
      args.showRawText = true;
      continue;
    }

    if (token === "--show-full-essays") {
      args.showFullEssays = true;
      continue;
    }

    if (token === "--out") {
      args.outFile = path.resolve(process.cwd(), argv[i + 1]);
      i += 1;
      continue;
    }
  }

  if (!args.file) {
    throw new Error("Missing required --file argument");
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const rawText = await parseDocumentText(args.file);
  const profile = extractProfileFromText(rawText, args.documentId);

  const output = {
    file: args.file,
    documentId: args.documentId,
    extracted: {
      personalInfo: profile.personalInfo,
      academics: profile.academics,
      activities: profile.activities,
      awards: profile.awards,
      essayCount: profile.essays.length,
      essays: args.showFullEssays
        ? profile.essays.map((essay) => ({ id: essay.id, content: essay.content }))
        : profile.essays.map((essay) => ({
            id: essay.id,
            preview: essay.content.slice(0, 500)
          })),
      extractionConfidence: profile.extractionConfidence,
      fieldProvenance: profile.fieldProvenance
    }
  };

  if (args.showRawText) {
    output.rawTextPreview = rawText.slice(0, 5000);
    output.rawTextLength = rawText.length;
  }

  const serialized = `${JSON.stringify(output, null, 2)}\n`;

  if (args.outFile) {
    await fs.writeFile(args.outFile, serialized, "utf8");
    process.stdout.write(`Wrote parser output to ${args.outFile}\n`);
    return;
  }

  process.stdout.write(serialized);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
