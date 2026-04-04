import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { extractProfileFromText } from "../src/profile/extractStudentProfile.js";
import { parseDocumentText } from "../src/parsers/documentParser.js";

test("extractProfileFromText infers hispanic/latino ethnicity from UC-style prompt", () => {
  const text = `
Demographics
Do you consider yourself Hispanic or Latino?
Yes
Hispanic / Latino
Latin American / Latino
`;

  const profile = extractProfileFromText(text, "uc-doc");
  assert.equal(profile.personalInfo.ethnicity, "hispanic/latino");
});

test("extractProfileFromText extracts UC major from Choose majors and avoids plural heading false positives", () => {
  const text = `
Contact information
State
California

Campuses & Majors
Choose majors
Campus Major School Alternate Major
UC Davis Mechanical Engineering, B.S. College of Engineering Undeclared — College of Engineering
UC Riverside Mechanical Engineering, B.S. Bourns College of Engineering Not selected
`;

  const profile = extractProfileFromText(text, "uc-major-sample");
  assert.equal(profile.personalInfo.state, "California");
  assert.match(String(profile.personalInfo.intendedMajor || ""), /mechanical engineering/i);
  assert.notEqual(profile.personalInfo.intendedMajor, "s");
});

test("extractProfileFromText pulls ethnicity and major from noe_uc_app.pdf", async () => {
  const filePath = "/Users/rheasrivats/Downloads/noe_uc_app.pdf";
  assert.equal(fs.existsSync(filePath), true, "Expected test PDF at /Users/rheasrivats/Downloads/noe_uc_app.pdf");

  const text = await parseDocumentText(filePath);
  const profile = extractProfileFromText(text, "noe-uc-app");

  assert.equal(profile.personalInfo.ethnicity, "hispanic/latino");
  assert.equal(profile.personalInfo.fullName, "Noe Ezequiel Zuleta");
  assert.equal(profile.personalInfo.addressLine1, "1346 Vermont St");
  assert.equal(profile.personalInfo.city, "San Francisco");
  assert.equal(profile.personalInfo.state, "California");
  assert.equal(profile.personalInfo.postalCode, "94110");
  assert.equal(profile.personalInfo.country, "United States");
  assert.match(String(profile.personalInfo.intendedMajor || ""), /engineering/i);
  assert.equal(profile.academics.schoolName, "MISSION SENIOR HIGH SCHOOL");
  assert.equal(profile.academics.gradeLevel, "12th grade");
  assert.ok(profile.activities.length >= 8);
  assert.ok(profile.awards.length >= 4);
  assert.ok(profile.activities.some((entry) => /Varsity Baseball MHS Team/i.test(entry)));
  assert.ok(profile.activities.some((entry) => /School-Wide Event Volunteer/i.test(entry)));
  assert.ok(profile.awards.some((entry) => /Logan Webb/i.test(entry)));
  assert.ok(profile.awards.some((entry) => /CPR/i.test(entry)));
  assert.ok(profile.essays.length >= 4);
  assert.match(profile.essays[0].content, /Baseball has shaped me over the past four years/i);
  assert.ok(!/Application ID:/i.test(profile.essays[0].content));
  assert.match(String(profile.essays[0].prompt || ""), /leadership experience/i);
});
