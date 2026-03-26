import test from "node:test";
import assert from "node:assert/strict";
import { mergeExtractedProfiles } from "../src/profile/mergeProfiles.js";

test("mergeExtractedProfiles chooses higher-confidence field values", () => {
  const merged = mergeExtractedProfiles([
    {
      sourceDocumentId: "uc-app",
      profile: {
        personalInfo: { fullName: "Alex Rivera", email: "alex@oldmail.com" },
        academics: { gpa: "3.7" },
        activities: ["Robotics"],
        awards: [],
        essays: [],
        extractionConfidence: {
          "personalInfo.fullName": 0.9,
          "personalInfo.email": 0.4,
          "academics.gpa": 0.8
        }
      }
    },
    {
      sourceDocumentId: "private-school-app",
      profile: {
        personalInfo: { fullName: "Alex Rivera", email: "alex@gmail.com" },
        academics: { gpa: "3.8" },
        activities: ["Robotics", "Math Club"],
        awards: ["STEM Prize"],
        essays: [],
        extractionConfidence: {
          "personalInfo.fullName": 0.6,
          "personalInfo.email": 0.95,
          "academics.gpa": 0.6
        }
      }
    }
  ]);

  assert.equal(merged.personalInfo.fullName, "Alex Rivera");
  assert.equal(merged.personalInfo.email, "alex@gmail.com");
  assert.equal(merged.academics.gpa, "3.7");
  assert.deepEqual(merged.activities, ["Robotics", "Math Club"]);
  assert.deepEqual(merged.awards, ["STEM Prize"]);
  assert.equal(merged.fieldProvenance["personalInfo.email"], "private-school-app");
  assert.ok(merged.conflicts.length >= 1);
});
