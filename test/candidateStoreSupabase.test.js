import test from "node:test";
import assert from "node:assert/strict";
import { __testables } from "../src/data/candidateStoreSupabase.js";

test("mapReviewDecisionToUserStatus maps review actions to persisted statuses", () => {
  assert.equal(__testables.mapReviewDecisionToUserStatus("approve"), "approved");
  assert.equal(__testables.mapReviewDecisionToUserStatus("reject"), "rejected");
  assert.equal(__testables.mapReviewDecisionToUserStatus("pending"), "");
});

test("toSupabaseDeadline does not invent a year for partial dates", () => {
  assert.equal(__testables.toSupabaseDeadline("January 1"), null);
  assert.equal(__testables.toSupabaseDeadline("Nov 8, 2026"), "2026-11-08");
});
