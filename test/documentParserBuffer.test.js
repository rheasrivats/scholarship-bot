import test from "node:test";
import assert from "node:assert/strict";
import { parseDocumentBuffer } from "../src/parsers/documentParser.js";

test("parseDocumentBuffer parses txt buffer", async () => {
  const text = "Name: Alex Rivera\nEmail: alex@example.com\nIntended Major: engineering";
  const parsed = await parseDocumentBuffer(Buffer.from(text, "utf8"), "sample.txt");
  assert.equal(parsed.includes("Intended Major"), true);
});
