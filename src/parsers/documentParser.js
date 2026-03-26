import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { PDFParse } from "pdf-parse";

const execFileAsync = promisify(execFile);

async function extractWithTextutil(filePath) {
  const { stdout } = await execFileAsync("/usr/bin/textutil", ["-convert", "txt", "-stdout", filePath]);
  return stdout.trim();
}

async function extractTextFromTxt(filePath) {
  const content = await fs.readFile(filePath, "utf8");
  return content.trim();
}

async function extractWithTextutilBuffer(buffer, extension) {
  const tempPath = path.join(os.tmpdir(), `scholarship-bot-${randomUUID()}${extension}`);
  await fs.writeFile(tempPath, buffer);
  try {
    return await extractWithTextutil(tempPath);
  } finally {
    await fs.unlink(tempPath).catch(() => {});
  }
}

async function extractTextFromPdf(filePath) {
  const data = await fs.readFile(filePath);
  const parser = new PDFParse({ data });
  try {
    const result = await parser.getText();
    return result.text.trim();
  } finally {
    await parser.destroy();
  }
}

export async function parseDocumentText(filePath) {
  const extension = path.extname(filePath).toLowerCase();

  if (extension === ".docx") {
    return extractWithTextutil(filePath);
  }

  if (extension === ".pdf") {
    return extractTextFromPdf(filePath);
  }

  if (extension === ".txt") {
    return extractTextFromTxt(filePath);
  }

  throw new Error(`Unsupported file extension: ${extension}. Supported: .pdf, .docx, .txt`);
}

export async function parseDocumentBuffer(fileBuffer, fileName) {
  const extension = path.extname(fileName || "").toLowerCase();

  if (extension === ".pdf") {
    const parser = new PDFParse({ data: fileBuffer });
    try {
      const result = await parser.getText();
      return result.text.trim();
    } finally {
      await parser.destroy();
    }
  }

  if (extension === ".docx") {
    return extractWithTextutilBuffer(fileBuffer, extension);
  }

  if (extension === ".txt") {
    return Buffer.from(fileBuffer).toString("utf8").trim();
  }

  throw new Error(`Unsupported file extension: ${extension}. Supported: .pdf, .docx, .txt`);
}
