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
- Match one student profile to a curated scholarship dataset.
- Autofill one target scholarship application end-to-end (draft mode).
- Provide a review UI for users to approve/edit all fields.
- Persist audit logs of extracted data and user edits.

## Scope
### In scope (MVP)
- File upload + parsing pipeline.
- Scholarship matching engine (rules + simple ranking).
- Form mapping + autofill draft generation.
- Human review and approval workflow.
- Basic dashboard for application status tracking.

### Out of scope (MVP)
- Fully autonomous submission to external portals.
- Broad internet scraping at large scale.
- Mobile apps.
- Multi-tenant enterprise controls.

## Architecture (Initial)
- `ingestion-service`: file upload, OCR/text extraction, parsing.
- `profile-service`: canonical student profile schema + storage.
- `matching-service`: eligibility checks and ranking.
- `autofill-service`: field mapping, answer drafting, export.
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

## Milestones
- [ ] M0: Repo scaffolding + baseline architecture docs.
- [ ] M1: UC upload parser -> canonical `StudentProfile` JSON.
- [ ] M2: Scholarship ingestion + matching/ranking.
- [ ] M3: Autofill generator for first scholarship adapter.
- [ ] M4: Review/approval UI and audit logging.
- [ ] M5: Pilot test with sample profiles and scholarships.

## Implementation Checklist
### Foundation
- [ ] Choose stack (backend, frontend, DB, queue).
- [ ] Set up project structure and environment config.
- [ ] Add lint/test/format tooling.

### UC Parsing
- [ ] Define schema for extracted fields.
- [ ] Add parser for UC application artifacts.
- [ ] Add confidence scoring and validation checks.

### Matching
- [ ] Define scholarship rule format.
- [ ] Implement eligibility evaluator.
- [ ] Implement ranking heuristic (fit, amount, deadline, effort).

### Autofill
- [ ] Create field-mapping format and adapter interface.
- [ ] Implement first scholarship adapter.
- [ ] Add essay prompt similarity + draft generation.

### Review & Safety
- [ ] Build review screen with per-field approvals.
- [ ] Track user edits and provenance.
- [ ] Add explicit consent + retention controls.

### QA
- [ ] Build fixture set of UC application samples.
- [ ] Add parser/matching/autofill integration tests.
- [ ] Run pilot dry-runs and log failure cases.

## Risks & Mitigations
- Portal ToS restrictions on automation.
  - Mitigation: assistant workflow + manual final submission.
- Parsing variability across file formats.
  - Mitigation: robust schema validation + confidence thresholds.
- Incorrect autofill causing bad submissions.
  - Mitigation: mandatory review gate + audit trail.
- Sensitive data exposure.
  - Mitigation: encryption at rest/in transit + strict RBAC.

## Decision Log
- 2026-03-23: Use human-in-the-loop workflow; no blind auto-submit in MVP.
- 2026-03-23: Prioritize one end-to-end scholarship adapter before scaling adapters.

## Open Questions
- Which scholarship sources are approved for ingestion initially?
- What file formats must UC upload support on day one (PDF, DOCX, both)?
- Should we support parent/counselor collaborator roles in MVP?

## Next Actions
1. Confirm stack choices.
2. Scaffold services and shared schema package.
3. Implement M1 parser pipeline with sample UC files.
