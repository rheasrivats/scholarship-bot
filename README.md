# Scholarship Bot (M0/M1 Scaffold)

This repository includes a runnable AI-agent scholarship copilot implementation.

## Product Demo

- Loom walkthrough: https://www.loom.com/share/b3842d181bcc460fadccf6c62fa916fa

## What is implemented

- Multi-document session processing (`PDF`, `DOCX`, `TXT`)
- Basic profile extraction from parsed text
- Field-level merge with confidence and provenance tracking
- Scholarship eligibility evaluation + ranking pipeline
- Sensitive-field autofill blocking helpers
- Scholarship ranking policy implementation
- Autofill adapter for mapped form fields
- Agent discovery workflow integration (Codex CLI)
- Guided submission flow with account handoff

## Key files

- `src/parsers/documentParser.js`: document text extraction
- `src/profile/extractStudentProfile.js`: baseline extractor
- `src/profile/mergeProfiles.js`: merge + conflict tracking
- `src/autofill/safetyFilter.js`: sensitive field/value blocking
- `src/autofill/noAccountAutofillAdapter.js`: draft generator with manual-only sensitive fields
- `src/matching/rankScholarships.js`: amount -> fit -> essay ranking
- `src/matching/eligibilityEvaluator.js`: scholarship eligibility checks
- `src/matching/matchScholarships.js`: matching and ranking
- `src/pipeline/processSessionDocuments.js`: end-to-end ingestion pipeline
- `src/pipeline/runNoAccountMvp.js`: end-to-end upload/match/draft flow

## Run tests

```bash
npm test
```

## Run Matching (CLI)

```bash
npm run mvp:cli -- \
  --session-id demo-1 \
  --doc uc=test/fixtures/uc_sample.txt \
  --doc private=test/fixtures/private_school_sample.txt
```

CLI output includes:
- Ranked scholarships
- Excluded scholarships with reasons
- Needs-human-review scholarships when required profile fields are missing
- Draft summary (autofill/manual counts per scholarship)

## Debug Document Parsing

Use this to inspect exactly what the parser extracted (personal info, academics, activities, awards, essay previews).

```bash
npm run debug:parse -- --file /absolute/path/to/file.pdf
```

Optional flags:
- `--document-id your-id`
- `--show-full-essays`
- `--show-raw-text`
- `--out /absolute/path/to/parser-output.txt`

## Run Local API

Optional Supabase env (local file supported):

```bash
cp .env.example .env.local
# fill SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY
# optional for local dev fallback: SUPABASE_DEV_USER_ID
# optional cost controls for autofill/guided AI:
# AUTOFILL_AI_MODEL=gpt-5.3-codex-spark
# AUTOFILL_AI_ENABLE_SEARCH=0
# AUTOFILL_FIELD_MAPPER_MODEL=gpt-5.4-mini
# AUTOFILL_FIELD_MAPPER_REASONING_EFFORT=low
# GUIDED_AI_MODEL=gpt-5.4-mini
# GUIDED_AI_REASONING_EFFORT=low
# GUIDED_AI_ENABLE_SEARCH=0
```

```bash
npm run api
```

Open the UI at:

```text
http://localhost:3000
```

From the UI:
- Upload one or more `.pdf`, `.docx`, or `.txt` files and click `Run Matching`.
- Review `Top Scholarships`, `Needs Human Review`, `Excluded`, and detailed `Autofill Drafts`.
- Use the `Human Review Edits` form (GPA, major, ethnicity, contact info) and click `Apply Edits & Rerun`.

Endpoints:
- `GET /health`
- `GET /admin/supabase/status` (connection/config check + candidate store mode)
- `GET /admin/logs/discovery?limit=30` (recent discovery run diagnostics)
- `POST /auth/signup`
- `POST /auth/signin`
- `GET /auth/me`
- `POST /admin/dev/auth/bootstrap` (create/use a dev user quickly)
- `GET /scholarships`
- `POST /run-no-account-mvp`
- `POST /run-no-account-mvp-upload` (used by the browser UI)
- `GET /admin/scholarships`
- `POST /admin/scholarships/replace`
- `GET /admin/candidates`
- `POST /candidates/suggest` (signed-in users can add a scholarship URL to their queue)
- `POST /admin/candidates/import`
- `POST /admin/candidates/review`
- `POST /admin/agent-discovery` (AI-agent discovery and import)
- `POST /admin/scholarships/generate-form-mapping` (Playwright first, agent fallback)
- `POST /admin/essay-draft`
- `POST /admin/submission/start`
- `POST /admin/submission/account-ready`
- `POST /admin/submission/refill`
- `POST /admin/submission/next`
- `POST /admin/submission/upsert-payload`
- `POST /admin/submission/stop`

Example request:

```json
{
  "sessionId": "api-demo",
  "documents": [
    { "documentId": "uc", "filePath": "/absolute/path/to/uc.pdf" },
    { "documentId": "private", "filePath": "/absolute/path/to/private.docx" }
  ],
  "maxDrafts": 3,
  "overrides": {
    "academics.gpa": "3.8",
    "personalInfo.intendedMajor": "Mechanical Engineering, B.S."
  }
}
```

## Notes

- PDF extraction uses `pdf-parse`; DOCX extraction uses macOS `textutil`.
- Sensitive fields should never be autofilled; use `shouldBlockAutofill` during form mapping.
- This is a scaffold and should be extended with stronger parsers, allowlist source checks, and account handoff UI states.

## Scholarship Data Ingestion

- Canonical source is per-user candidate state:
  - Supabase-backed when configured (recommended)
  - local fallback `data/scholarships.candidates.json` when Supabase is not configured
- `/admin/scholarships/replace` is deprecated and returns `410`.

Current ingestion/review flow:
1. Import potential scholarships as candidates (`POST /admin/candidates/import`)
2. Review candidate risk score/flags (`GET /admin/candidates`)
3. Approve/reject each candidate (`POST /admin/candidates/review`)
4. Queue/approval state is stored per user (Supabase) or in local candidate cache fallback

## Multi-Agent Orchestration (Experimental)

If you want an agentic workflow (finder agent + reviewer + autofill agent), use the scaffold in:

- `agent_orchestration/README.md`
- `agent_orchestration/workflow.py`
- `agent_orchestration/run_workflow.py`

This integrates with current Node endpoints while introducing phased multi-agent orchestration via `iriai-compose`.
Supabase candidate persistence notes:
- Candidate endpoints use Supabase when these are set:
  - `SUPABASE_URL`
  - `SUPABASE_SECRET_KEY` (or `SUPABASE_SERVICE_ROLE_KEY`)
  - user identity via one of:
    - `Authorization: Bearer <supabase_access_token>` (preferred)
    - request header `x-user-id` (dev/internal use)
    - `SUPABASE_DEV_USER_ID` (fallback dev mode)
- If any are missing, API falls back to local JSON files in `data/`.

Agent discovery run logs:
- Backend writes structured JSONL logs to `data/discovery-runs.log.jsonl`.
- Each entry includes run mode (`fresh`/`cached`), user store mode, discovered/imported counts, and reason codes such as:
  - `imported_new_candidates`
  - `agent_returned_zero_candidates`
  - `all_discovered_candidates_skipped_or_deduped`
  - `cached_mode_reused_existing_queue`
  - `discovery_process_failed`

Deterministic discovery notes:
- `POST /admin/agent-discovery` now uses a deterministic pipeline: profile-aware query generation, search-result URL collection, parallel page fetches, and rule-based extraction before import.
- Search endpoint is configurable via `DISCOVERY_SEARCH_ENDPOINT`.
  - Code fallback (if unset): Brave Web Search endpoint
  - `.env.example` currently sets DuckDuckGo HTML for local/dev defaults
- Optional narrow AI ambiguity resolution is gated by `DISCOVERY_ENABLE_AI_ASSIST=1`.
- Discovery diagnostics returned by the API include generated queries, fetched-page counts, and extraction errors in the log tails.
