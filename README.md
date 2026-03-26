# Scholarship Bot (M0/M1 Scaffold)

This repository includes a runnable AI-agent scholarship copilot implementation.

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
- `GET /scholarships`
- `POST /run-no-account-mvp`
- `POST /run-no-account-mvp-upload` (used by the browser UI)
- `GET /admin/scholarships`
- `POST /admin/scholarships/replace`
- `GET /admin/candidates`
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

- Editable vetted data source: `data/scholarships.vetted.json`
- CSV template for imports: `data/scholarships.vetted.template.csv`
- Current file contains initial sample records; replace with your vetted real sources.
- Candidate review queue file: `data/scholarships.candidates.json`

Import CSV into vetted JSON:

```bash
npm run scholarships:import -- --in data/scholarships.vetted.template.csv
```

Hybrid ingestion/review flow:
1. Import potential scholarships as candidates (`POST /admin/candidates/import`)
2. Review candidate risk score/flags (`GET /admin/candidates`)
3. Approve/reject each candidate (`POST /admin/candidates/review`)
4. Approved candidates are promoted into `data/scholarships.vetted.json`

## Multi-Agent Orchestration (Experimental)

If you want an agentic workflow (finder agent + reviewer + autofill agent), use the scaffold in:

- `agent_orchestration/README.md`
- `agent_orchestration/workflow.py`
- `agent_orchestration/run_workflow.py`

This integrates with current Node endpoints while introducing phased multi-agent orchestration via `iriai-compose`.
