export const TRUSTED_SOURCE_TIERS = {
  TIER_1: "Tier 1",
  TIER_2: "Tier 2",
  TIER_3: "Tier 3"
};

export function createScholarship({
  id,
  name,
  sourceDomain,
  sourceTier,
  requiresAccount = false,
  awardAmount,
  deadline,
  estimatedEffortMinutes,
  eligibility = {},
  essayPrompts = [],
  formFields = [],
  ...metadata
}) {
  return {
    id,
    name,
    sourceDomain,
    sourceTier,
    requiresAccount,
    awardAmount,
    deadline,
    estimatedEffortMinutes,
    eligibility: {
      minGpa: eligibility.minGpa ?? null,
      allowedMajors: eligibility.allowedMajors ?? [],
      allowedEthnicities: eligibility.allowedEthnicities ?? []
    },
    essayPrompts,
    formFields,
    ...metadata
  };
}
