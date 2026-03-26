import test from "node:test";
import assert from "node:assert/strict";
import { rankScholarships } from "../src/matching/rankScholarships.js";

test("rankScholarships follows amount -> fit -> essay priority", () => {
  const ranked = rankScholarships([
    {
      id: "A",
      awardAmount: 10000,
      profileFitScore: 0.7,
      essaySimilarityScore: 0.7,
      deadline: "2026-09-01",
      estimatedEffortMinutes: 30
    },
    {
      id: "B",
      awardAmount: 5000,
      profileFitScore: 0.99,
      essaySimilarityScore: 0.99,
      deadline: "2026-04-01",
      estimatedEffortMinutes: 30
    },
    {
      id: "C",
      awardAmount: 10000,
      profileFitScore: 0.9,
      essaySimilarityScore: 0.6,
      deadline: "2026-05-01",
      estimatedEffortMinutes: 20
    }
  ]);

  assert.deepEqual(ranked.map((x) => x.id), ["C", "A", "B"]);
});
