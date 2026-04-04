import { getSupabaseAdminClient } from "../integrations/supabaseClient.js";
import { normalizeCandidateRecord, normalizeRiskFlags } from "./candidateStore.js";

const USER_STATUS_BY_CANDIDATE_STATUS = {
  pending: "queued",
  approved: "approved",
  rejected: "rejected",
  submitted: "submitted"
};

const CANDIDATE_STATUS_BY_USER_STATUS = {
  queued: "pending",
  approved: "approved",
  rejected: "rejected",
  in_progress: "approved",
  submitted: "submitted"
};

function mapReviewDecisionToUserStatus(decision) {
  if (decision === "approve") {
    return USER_STATUS_BY_CANDIDATE_STATUS.approved;
  }
  if (decision === "reject") {
    return USER_STATUS_BY_CANDIDATE_STATUS.rejected;
  }
  return "";
}

function normalizeMetadata(raw) {
  return raw && typeof raw === "object" ? raw : {};
}

function toSupabaseDeadline(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return null;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return raw;
  }
  if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(raw)) {
    const [month, day, year] = raw.split("/");
    const normalizedYear = year.length === 2 ? `20${year}` : year;
    return `${normalizedYear.padStart(4, "0")}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }
  if (!/\d{4}/.test(raw)) {
    return null;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString().slice(0, 10);
}

function mapJoinedRowToCandidate(row) {
  const scholarship = Array.isArray(row.scholarships) ? row.scholarships[0] : row.scholarships;
  const metadata = normalizeMetadata(scholarship?.metadata);

  return {
    id: scholarship?.id,
    name: scholarship?.title || "Unknown Scholarship",
    sourceDomain: scholarship?.source_domain || "",
    sourceUrl: scholarship?.source_url || "",
    sourceName: metadata.sourceName || "",
    requiresAccount: Boolean(scholarship?.requires_account),
    awardAmount: Number(scholarship?.award_amount || 0),
    deadline: scholarship?.deadline || "",
    estimatedEffortMinutes: Number(metadata.estimatedEffortMinutes || 30),
    eligibility: metadata.eligibility || { minGpa: null, allowedMajors: [], allowedEthnicities: [] },
    inferredRequirements: metadata.inferredRequirements || {
      requiredMajors: [],
      requiredEthnicities: [],
      requiredStates: [],
      minAge: null,
      maxAge: null,
      requirementStatements: []
    },
    essayPrompts: Array.isArray(metadata.essayPrompts) ? metadata.essayPrompts : [],
    formFields: Array.isArray(metadata.formFields) ? metadata.formFields : [],
    userSuggested: metadata.userSuggested === true,
    status: CANDIDATE_STATUS_BY_USER_STATUS[row.status] || "pending",
    reviewNotes: row.notes || "",
    reviewedBy: "",
    reviewedAt: row.status === "queued" ? "" : String(row.last_action_at || ""),
    createdAt: String(row.date_added || new Date().toISOString()),
    riskScore: Number(metadata.riskScore || 0),
    riskFlags: normalizeRiskFlags(metadata.riskFlags),
    recommendedTier: String(metadata.recommendedTier || "Tier 1")
  };
}

async function listJoinedRows(userId) {
  const client = getSupabaseAdminClient();
  if (!client) {
    throw new Error("Supabase is not configured");
  }

  const { data, error } = await client
    .from("user_scholarships")
    .select(`
      user_id,
      scholarship_id,
      status,
      date_added,
      last_action_at,
      notes,
      scholarships!inner(
        id,
        source_url,
        source_domain,
        title,
        award_amount,
        deadline,
        requires_account,
        metadata
      )
    `)
    .eq("user_id", userId);

  if (error) {
    throw new Error(`Supabase candidates read failed: ${error.message}`);
  }

  return data || [];
}

export async function loadCandidatesFromSupabase(userId) {
  const rows = await listJoinedRows(userId);
  return rows.map(mapJoinedRowToCandidate);
}

export async function importCandidatesToSupabase(userId, rawCandidates, existingScholarships = [], options = {}) {
  if (!Array.isArray(rawCandidates)) {
    throw new Error("Candidates payload must be an array");
  }

  const client = getSupabaseAdminClient();
  if (!client) {
    throw new Error("Supabase is not configured");
  }

  const replacePending = Boolean(options.replacePending);
  if (rawCandidates.length === 0 && !replacePending) {
    throw new Error("Candidates payload must be a non-empty array unless replacePending is true");
  }
  const existing = await loadCandidatesFromSupabase(userId);
  const preserved = replacePending
    ? existing.filter((candidate) => candidate.status !== "pending")
    : existing;

  if (replacePending) {
    const { error: deleteError } = await client
      .from("user_scholarships")
      .delete()
      .eq("user_id", userId)
      .eq("status", "queued");
    if (deleteError) {
      throw new Error(`Supabase pending cleanup failed: ${deleteError.message}`);
    }
  }

  const keys = new Set();
  for (const candidate of preserved) {
    keys.add(`id:${candidate.id}`);
    if (candidate.sourceUrl) {
      keys.add(`url:${String(candidate.sourceUrl).toLowerCase()}`);
    }
    keys.add(`name_domain:${String(candidate.name).toLowerCase()}::${String(candidate.sourceDomain).toLowerCase()}`);
  }
  for (const scholarship of existingScholarships) {
    keys.add(`id:${scholarship.id}`);
    if (scholarship.sourceUrl) {
      keys.add(`url:${String(scholarship.sourceUrl).toLowerCase()}`);
    }
    keys.add(`name_domain:${String(scholarship.name).toLowerCase()}::${String(scholarship.sourceDomain).toLowerCase()}`);
  }

  const imported = [];
  for (const rawCandidate of rawCandidates) {
    const normalized = normalizeCandidateRecord(rawCandidate, existingScholarships);
    const dedupeKeys = [
      `id:${normalized.id}`,
      normalized.sourceUrl ? `url:${String(normalized.sourceUrl).toLowerCase()}` : "",
      `name_domain:${String(normalized.name).toLowerCase()}::${String(normalized.sourceDomain).toLowerCase()}`
    ].filter(Boolean);
    if (dedupeKeys.some((key) => keys.has(key))) {
      continue;
    }
    dedupeKeys.forEach((key) => keys.add(key));

    const scholarshipPayload = {
      source_url: normalized.sourceUrl || `https://${normalized.sourceDomain}/scholarship/${normalized.id}`,
      source_domain: normalized.sourceDomain,
      title: normalized.name,
      award_amount: normalized.awardAmount,
      deadline: toSupabaseDeadline(normalized.deadline),
      requires_account: normalized.requiresAccount,
      metadata: {
        sourceName: normalized.sourceName,
        estimatedEffortMinutes: normalized.estimatedEffortMinutes,
        eligibility: normalized.eligibility,
        inferredRequirements: normalized.inferredRequirements,
        essayPrompts: normalized.essayPrompts,
        formFields: normalized.formFields,
        userSuggested: normalized.userSuggested === true,
        riskScore: normalized.riskScore,
        riskFlags: normalizeRiskFlags(normalized.riskFlags),
        recommendedTier: normalized.recommendedTier,
        importedAt: new Date().toISOString()
      }
    };

    const { data: scholarshipData, error: scholarshipError } = await client
      .from("scholarships")
      .upsert(scholarshipPayload, { onConflict: "source_url" })
      .select("id")
      .single();
    if (scholarshipError) {
      throw new Error(`Supabase scholarship upsert failed: ${scholarshipError.message}`);
    }

    const scholarshipId = scholarshipData.id;
    const nowIso = new Date().toISOString();
    const { error: linkError } = await client
      .from("user_scholarships")
      .upsert({
        user_id: userId,
        scholarship_id: scholarshipId,
        status: "queued",
        date_added: nowIso,
        last_action_at: nowIso,
        notes: ""
      }, {
        onConflict: "user_id,scholarship_id",
        ignoreDuplicates: true
      });
    if (linkError) {
      throw new Error(`Supabase user_scholarships upsert failed: ${linkError.message}`);
    }

    imported.push({
      ...normalized,
      id: scholarshipId,
      status: "pending"
    });
  }

  return imported;
}

export async function reviewCandidateInSupabase({
  userId,
  scholarshipId,
  decision,
  reviewer = "",
  notes = "",
  tierOverride = ""
}) {
  if (!["approve", "reject"].includes(decision)) {
    throw new Error("decision must be 'approve' or 'reject'");
  }

  const client = getSupabaseAdminClient();
  if (!client) {
    throw new Error("Supabase is not configured");
  }

  const userStatus = mapReviewDecisionToUserStatus(decision);
  const reviewedAt = new Date().toISOString();
  const reviewNotes = [reviewer ? `[${reviewer}]` : "", notes].filter(Boolean).join(" ").trim();

  const { error: updateError } = await client
    .from("user_scholarships")
    .update({
      status: userStatus,
      notes: reviewNotes,
      last_action_at: reviewedAt
    })
    .eq("user_id", userId)
    .eq("scholarship_id", scholarshipId);
  if (updateError) {
    throw new Error(`Supabase review update failed: ${updateError.message}`);
  }

  if (tierOverride) {
    const { data: scholarshipRow, error: scholarshipReadError } = await client
      .from("scholarships")
      .select("id, metadata")
      .eq("id", scholarshipId)
      .single();
    if (!scholarshipReadError && scholarshipRow) {
      const metadata = normalizeMetadata(scholarshipRow.metadata);
      metadata.recommendedTier = tierOverride;
      const { error: scholarshipWriteError } = await client
        .from("scholarships")
        .update({ metadata })
        .eq("id", scholarshipId);
      if (scholarshipWriteError) {
        throw new Error(`Supabase tier override update failed: ${scholarshipWriteError.message}`);
      }
    }
  }

  const rows = await listJoinedRows(userId);
  const row = rows.find((item) => {
    const scholarship = Array.isArray(item.scholarships) ? item.scholarships[0] : item.scholarships;
    return scholarship?.id === scholarshipId;
  });
  if (!row) {
    throw new Error(`Candidate not found: ${scholarshipId}`);
  }
  return mapJoinedRowToCandidate(row);
}

export async function markCandidateSubmittedInSupabase({
  userId,
  scholarshipId,
  reviewer = "",
  notes = ""
}) {
  const client = getSupabaseAdminClient();
  if (!client) {
    throw new Error("Supabase is not configured");
  }

  const { data: existingRow, error: readError } = await client
    .from("user_scholarships")
    .select("status, notes")
    .eq("user_id", userId)
    .eq("scholarship_id", scholarshipId)
    .single();
  if (readError) {
    throw new Error(`Supabase candidate read failed: ${readError.message}`);
  }

  if (existingRow.status === "rejected") {
    throw new Error("Rejected candidates cannot be marked as submitted");
  }

  const reviewedAt = new Date().toISOString();
  const reviewNotes = [reviewer ? `[${reviewer}]` : "", notes || existingRow.notes || ""]
    .filter(Boolean)
    .join(" ")
    .trim();

  const { error: updateError } = await client
    .from("user_scholarships")
    .update({
      status: USER_STATUS_BY_CANDIDATE_STATUS.submitted,
      notes: reviewNotes,
      last_action_at: reviewedAt
    })
    .eq("user_id", userId)
    .eq("scholarship_id", scholarshipId);
  if (updateError) {
    throw new Error(`Supabase submit update failed: ${updateError.message}`);
  }

  const rows = await listJoinedRows(userId);
  const row = rows.find((item) => {
    const scholarship = Array.isArray(item.scholarships) ? item.scholarships[0] : item.scholarships;
    return scholarship?.id === scholarshipId;
  });
  if (!row) {
    throw new Error(`Candidate not found: ${scholarshipId}`);
  }
  return mapJoinedRowToCandidate(row);
}

export async function refreshCandidateMetadataInSupabase({
  userId,
  scholarshipId,
  name = "",
  deadline = "",
  awardAmount = 0
}) {
  const client = getSupabaseAdminClient();
  if (!client) {
    throw new Error("Supabase is not configured");
  }

  const trimmedUserId = String(userId || "").trim();
  const trimmedScholarshipId = String(scholarshipId || "").trim();
  if (!trimmedUserId) {
    throw new Error("userId is required");
  }
  if (!trimmedScholarshipId) {
    throw new Error("scholarshipId is required");
  }

  const { data: existingLink, error: linkError } = await client
    .from("user_scholarships")
    .select("user_id, scholarship_id")
    .eq("user_id", trimmedUserId)
    .eq("scholarship_id", trimmedScholarshipId)
    .single();
  if (linkError || !existingLink) {
    throw new Error(`Candidate not found: ${trimmedScholarshipId}`);
  }

  const normalizedAward = Number(awardAmount || 0);
  const payload = {
    title: String(name || "").trim() || "Unknown Scholarship",
    deadline: toSupabaseDeadline(String(deadline || "").trim()),
    award_amount: Number.isFinite(normalizedAward) && normalizedAward > 0 ? normalizedAward : 0
  };

  const { error: updateError } = await client
    .from("scholarships")
    .update(payload)
    .eq("id", trimmedScholarshipId);
  if (updateError) {
    throw new Error(`Supabase candidate metadata update failed: ${updateError.message}`);
  }

  const rows = await listJoinedRows(trimmedUserId);
  const row = rows.find((item) => {
    const scholarship = Array.isArray(item.scholarships) ? item.scholarships[0] : item.scholarships;
    return scholarship?.id === trimmedScholarshipId;
  });
  if (!row) {
    throw new Error(`Candidate not found: ${trimmedScholarshipId}`);
  }
  return mapJoinedRowToCandidate(row);
}

export async function markCandidateAsUserSuggestedInSupabase({
  userId,
  scholarshipId
}) {
  const client = getSupabaseAdminClient();
  if (!client) {
    throw new Error("Supabase is not configured");
  }

  const trimmedUserId = String(userId || "").trim();
  const trimmedScholarshipId = String(scholarshipId || "").trim();
  if (!trimmedUserId) {
    throw new Error("userId is required");
  }
  if (!trimmedScholarshipId) {
    throw new Error("scholarshipId is required");
  }

  const { data: existingLink, error: linkError } = await client
    .from("user_scholarships")
    .select("user_id, scholarship_id")
    .eq("user_id", trimmedUserId)
    .eq("scholarship_id", trimmedScholarshipId)
    .single();
  if (linkError || !existingLink) {
    throw new Error(`Candidate not found: ${trimmedScholarshipId}`);
  }

  const { data: scholarshipRow, error: scholarshipReadError } = await client
    .from("scholarships")
    .select("id, metadata")
    .eq("id", trimmedScholarshipId)
    .single();
  if (scholarshipReadError || !scholarshipRow) {
    throw new Error(`Candidate not found: ${trimmedScholarshipId}`);
  }

  const metadata = normalizeMetadata(scholarshipRow.metadata);
  metadata.userSuggested = true;
  const { error: scholarshipWriteError } = await client
    .from("scholarships")
    .update({ metadata })
    .eq("id", trimmedScholarshipId);
  if (scholarshipWriteError) {
    throw new Error(`Supabase userSuggested update failed: ${scholarshipWriteError.message}`);
  }

  const rows = await listJoinedRows(trimmedUserId);
  const row = rows.find((item) => {
    const scholarship = Array.isArray(item.scholarships) ? item.scholarships[0] : item.scholarships;
    return scholarship?.id === trimmedScholarshipId;
  });
  if (!row) {
    throw new Error(`Candidate not found: ${trimmedScholarshipId}`);
  }
  return mapJoinedRowToCandidate(row);
}

export const __testables = {
  mapReviewDecisionToUserStatus,
  toSupabaseDeadline
};
