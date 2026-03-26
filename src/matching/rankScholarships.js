function parseDeadline(deadline) {
  const parsed = Date.parse(deadline);
  return Number.isNaN(parsed) ? Number.MAX_SAFE_INTEGER : parsed;
}

export function rankScholarships(candidates) {
  return [...candidates].sort((a, b) => {
    if (b.awardAmount !== a.awardAmount) {
      return b.awardAmount - a.awardAmount;
    }

    if (b.profileFitScore !== a.profileFitScore) {
      return b.profileFitScore - a.profileFitScore;
    }

    if (b.essaySimilarityScore !== a.essaySimilarityScore) {
      return b.essaySimilarityScore - a.essaySimilarityScore;
    }

    const deadlineDiff = parseDeadline(a.deadline) - parseDeadline(b.deadline);
    if (deadlineDiff !== 0) {
      return deadlineDiff;
    }

    return a.estimatedEffortMinutes - b.estimatedEffortMinutes;
  });
}
