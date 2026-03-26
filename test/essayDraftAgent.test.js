import test from "node:test";
import assert from "node:assert/strict";
import { __testables } from "../src/autofill/essayDraftAgent.js";

test("parseEssayWordConstraints detects minimum words", () => {
  const parsed = __testables.parseEssayWordConstraints("Write a response (Minimum 500 words).");
  assert.equal(parsed.minWords, 500);
  assert.equal(parsed.maxWords, null);
});

test("parseEssayWordConstraints detects ranges", () => {
  const parsed = __testables.parseEssayWordConstraints("Please write between 300 and 500 words.");
  assert.equal(parsed.minWords, 300);
  assert.equal(parsed.maxWords, 500);
});

test("chooseTargetWords prefers midpoint for ranges", () => {
  const target = __testables.chooseTargetWords({ minWords: 300, maxWords: 500 });
  assert.equal(target, 400);
});

