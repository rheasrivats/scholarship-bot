function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function includesNormalized(collection, target) {
  const normalizedTarget = normalize(target);
  const normalizedRules = collection.map(normalize);

  return normalizedRules.some((rule) => (
    normalizedTarget === rule
    || normalizedTarget.includes(rule)
    || rule.includes(normalizedTarget)
  ));
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function evaluateScholarshipEligibility({ scholarship, profile }) {
  const failedRules = [];
  const missingRequiredInfo = [];
  const { eligibility } = scholarship;

  const gpa = toNumber(profile?.academics?.gpa);
  if (eligibility.minGpa !== null && eligibility.minGpa !== undefined) {
    if (gpa === null) {
      missingRequiredInfo.push(`Missing GPA (minimum required is ${eligibility.minGpa})`);
    } else if (gpa < eligibility.minGpa) {
      failedRules.push(`GPA below minimum (${eligibility.minGpa})`);
    }
  }

  if (eligibility.allowedMajors.length > 0) {
    const intendedMajor = profile?.personalInfo?.intendedMajor;
    if (!intendedMajor) {
      missingRequiredInfo.push("Missing intended major");
    } else if (!includesNormalized(eligibility.allowedMajors, intendedMajor)) {
      failedRules.push("Intended major does not match scholarship requirements");
    }
  }

  if (eligibility.allowedEthnicities.length > 0) {
    const ethnicity = profile?.personalInfo?.ethnicity;
    if (!ethnicity) {
      missingRequiredInfo.push("Missing ethnicity/background information");
    } else if (!includesNormalized(eligibility.allowedEthnicities, ethnicity)) {
      failedRules.push("Ethnicity/background requirement not matched");
    }
  }

  const status = failedRules.length > 0
    ? "ineligible"
    : missingRequiredInfo.length > 0
      ? "needs_human_review"
      : "eligible";

  return {
    status,
    isEligible: status === "eligible",
    failedRules,
    missingRequiredInfo,
    reasons: [...failedRules, ...missingRequiredInfo]
  };
}
