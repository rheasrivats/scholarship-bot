# Scholarship Bot - Plan & Implementation Tracker

## Product Goal
Build a student-focused scholarship copilot that:
1. Ingests a UC application upload.
2. Extracts and structures student information.
3. Matches student profiles to scholarship opportunities.
4. Pre-fills scholarship applications and drafts responses.
5. Keeps a human-in-the-loop review flow before any submission.

## Success Criteria (MVP)
- Parse UC application into a structured profile with confidence scores.
- Support multiple uploaded documents in a single user session (UC, private school, prior scholarship forms).
- Match one student profile to a curated scholarship dataset.
- Autofill one target scholarship application end-to-end (draft mode).
- Provide a review UI for users to approve/edit all fields.
- Persist audit logs of extracted data and user edits.

## Scope
### In scope (MVP)
- File upload + parsing pipeline.
- Multi-document session ingestion and profile merge.
- Scholarship matching engine (rules + simple ranking).
- Form mapping + autofill draft generation.
- Human review and approval workflow.
- Basic dashboard for application status tracking.
- Sensitive-field guardrails (never autofill highly sensitive identifiers/payment data).

### Out of scope (MVP)
- Fully autonomous submission to external portals.
- Broad internet scraping at large scale.
- Mobile apps.
- Multi-tenant enterprise controls.

## Architecture (Initial)
- `ingestion-service`: file upload, OCR/text extraction, parsing.
- `profile-service`: canonical student profile schema + storage.
- `session-store`: ephemeral in-memory/session-scoped storage for uploaded docs and extracted fields.
- `matching-service`: eligibility checks and ranking.
- `autofill-service`: field mapping, answer drafting, export.
- `safety-filter`: sensitive-field detection, masking, and autofill blocking.
- `review-ui`: user verification/edit approvals.
- `db`: student profiles, scholarships, mappings, run logs.

## Data Model (Draft)
### StudentProfile
- PersonalInfo
- Academics
- Activities
- Awards
- Essays
- Preferences
- ConsentMetadata
- ExtractionConfidence
- FieldProvenance (which source document provided each field)

### SessionDocument
- SessionId
- DocumentId
- DocumentType (UC, private school app, scholarship app, other)
- ParsedFields
- ParseConfidence
- UploadedAt

### Scholarship
- Source
- EligibilityRules
- Deadlines
- RequiredFields
- EssayPrompts
- AwardAmount

### ApplicationDraft
- ScholarshipId
- StudentProfileId
- FieldMappings
- DraftAnswers
- ReviewStatus
- SubmissionStatus

## Sensitive Data Policy (MVP)
- Never autofill these categories:
  - SSN / ITIN / taxpayer ID
  - Passport number
  - Driver's license / state ID number
  - Credit/debit card numbers
  - Bank account/routing numbers
  - Full medical insurance member IDs
- If detected during parsing, store as masked token only for warning context (example: `***-**-1234`), not raw values.
- Force manual entry in UI for blocked fields with explicit label: "Manual entry required for sensitive information."
- Do not include blocked values in LLM prompts, logs, analytics, or exports.

## Trusted Source Review SOP (MVP)
- Goal: only allow autofill on approved scholarship sources.
- Seed candidate sources from:
  - Official college financial aid pages
  - Federal/state aid portals
  - Established nonprofit/foundation scholarship programs
- Vetting checklist per source:
  - Domain and ownership validation
  - HTTPS/TLS validity and redirect safety
  - Privacy policy and terms review
  - No pay-to-apply requirement
  - Transparent organization identity/contact details
  - Reasonable data collection for stage of application
- Risk tier assignment:
  - Tier 1 (trusted): autofill enabled
  - Tier 2 (caution): manual-review-only mode
  - Tier 3 (blocked): no autofill and warning shown
- Operations:
  - Record reviewer, date, and evidence links for each decision
  - Re-certify approved sources every 90 days
  - Immediately suspend sources on phishing or abuse reports

## Account-Required Application Flow (MVP)
- Objective: bot automates preparation and form-filling, user owns account creation/authentication.
- Standard flow:
  1. Bot pre-fills all non-sensitive fields available before signup/login.
  2. Bot reaches account boundary and enters `handoff_required` state.
  3. User creates account and completes login/2FA/CAPTCHA manually.
  4. User clicks "Resume Autofill" in app.
  5. Bot continues with post-login autofill (trusted Tier 1 sources only), then stops for final user confirmation before submit.
- Hard rules:
  - No password or security-answer capture/storage.
  - No hidden credential replay.
  - Sensitive fields remain manual-only even after login.
  - If auth/session expires, return to `handoff_required` and ask user to re-authenticate.

## Milestones
- [x] M0: Repo scaffolding + baseline architecture docs.
- [ ] M1: UC upload parser -> canonical `StudentProfile` JSON.
- [ ] M2: Scholarship ingestion + matching/ranking.
- [ ] M3: Autofill generator for first scholarship adapter.
- [ ] M4: Review/approval UI and audit logging.
- [ ] M5: Pilot test with sample profiles and scholarships.

## Implementation Checklist
### Foundation
- [ ] Choose stack (backend, frontend, DB, queue).
- [x] Set up project structure and environment config.
- [ ] Add lint/test/format tooling.

### UC Parsing
- [x] Define schema for extracted fields.
- [x] Add parser for UC application artifacts.
- [x] Add confidence scoring and validation checks.
- [x] Add parser pipeline for additional document types.
- [x] Implement field-level merge logic across multiple documents.
- [ ] Add conflict resolution UI for contradictory values.

### Matching
- [x] Define scholarship rule format.
- [x] Implement eligibility evaluator.
- [x] Implement ranking heuristic using priority order: (1) award amount, (2) profile fit, (3) essay-resource similarity.
- [x] Build scholarship source registry with risk tier metadata.

## Matching & Ranking Policy (MVP)
- Primary ranking priority: highest scholarship award amount.
- Secondary ranking priority: strongest profile/eligibility fit.
  - Example: demographics + intended major + background alignment (such as Latinx + STEM-focused awards).
- Tertiary ranking priority: highest essay prompt similarity to user-provided materials (UC essays, personal statements, prior scholarship answers).
- Apply ranking in this order after base eligibility filtering.
- If scores are close, break ties by nearest deadline and lowest estimated application effort.

### Autofill
- [x] Create field-mapping format and adapter interface.
- [x] Implement first scholarship adapter.
- [x] Add essay prompt similarity + draft generation.
- [x] Add sensitive field denylist + pattern detector in autofill pipeline.
- [x] Hard-block autofill for sensitive fields even if mapping exists.
- [x] Gate autofill by trusted source tier (Tier 1 only).
- [ ] Add pause/resume state machine for account-required flows.
- [ ] Add "account boundary detection" per scholarship adapter.

### Review & Safety
- [ ] Build review screen with per-field approvals.
- [ ] Track user edits and provenance.
- [ ] Add explicit consent + retention controls.
- [ ] Keep uploaded documents session-scoped by default (no cross-session persistence).
- [ ] Add UI markers for "manual-only" sensitive fields.
- [ ] Add logging filter to redact any sensitive pattern before write.
- [ ] Add source verification badge and destination-domain confirmation before submit.
- [ ] Add allowlist admin workflow: candidate, review, approve/deny, re-certify.
- [ ] Add "Resume after login" UX checkpoint and explicit submit confirmation checkpoint.

### QA
- [x] Build fixture set of UC application samples.
- [x] Add parser/matching/autofill integration tests.
- [ ] Run pilot dry-runs and log failure cases.
- [x] Add tests proving sensitive fields are never autofilled or logged.
- [ ] Add tests proving non-approved or Tier 2/3 sources cannot be autofilled.
- [ ] Add tests for account handoff transitions (`pre_auth -> handoff_required -> resumed -> review_required`).

## Risks & Mitigations
- Portal ToS restrictions on automation.
  - Mitigation: assistant workflow + manual final submission.
- Data leakage to fake or low-trust scholarship websites.
  - Mitigation: strict allowlist tiers, source verification checks, and submit-time domain confirmation.
- Parsing variability across file formats.
  - Mitigation: robust schema validation + confidence thresholds.
- Incorrect autofill causing bad submissions.
  - Mitigation: mandatory review gate + audit trail.
- Sensitive data exposure.
  - Mitigation: encryption at rest/in transit + strict RBAC.

## Decision Log
- 2026-03-23: Use human-in-the-loop workflow; no blind auto-submit in MVP.
- 2026-03-23: Prioritize one end-to-end scholarship adapter before scaling adapters.
- 2026-03-23: Support multiple uploads per session and merge into one canonical profile.
- 2026-03-23: Default privacy mode is session-only storage unless user opts into persistence.
- 2026-03-23: Sensitive identifiers/payment fields are manual-entry only and excluded from autofill/LLM/logging.
- 2026-03-23: Autofill permitted only for approved Tier 1 scholarship sources.
- 2026-03-23: For account-required scholarships, bot pauses at account boundary and resumes only after user-authenticated handoff.
- 2026-03-23: Scholarship ranking priority is award amount first, profile fit second, essay-resource similarity third.
- 2026-03-23: Current milestone includes both `PDF` and `DOCX` upload support.
- 2026-03-23: Initial scaffold uses Node.js (ESM) with built-in test runner.
- 2026-03-23: MVP implementation sequence prioritizes no-account scholarships before account-required flows.
- 2026-03-23: Missing required profile fields route scholarships to `needs human review` rather than auto-ineligible.

## Open Questions
- Which scholarship sources are approved for ingestion initially?
- Should we support parent/counselor collaborator roles in MVP?

## Next Actions
1. Confirm stack choices.
2. Scaffold services and shared schema package.
3. Implement session document ingestion + merge pipeline.
4. Implement M1 parser pipeline with sample UC and non-UC files (`PDF` + `DOCX` support in this milestone).
