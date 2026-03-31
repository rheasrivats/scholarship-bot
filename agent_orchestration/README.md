# Agent Orchestration (Experimental)

This folder scaffolds a multi-agent workflow using [`iriai-compose`](https://github.com/thedanielzhang/python-iriai-compose).

## What this gives you

- A workflow skeleton with phases:
  1. `ParseStudentPhase`
  2. `DiscoverAndShortlistPhase`
  3. `AutofillPlanPhase`
- Separate actors:
  - planner agent
  - autofill agent
  - human reviewer
- Reuse of the existing Node API for ingestion/queue operations:
  - `POST /run-no-account-mvp-upload`
  - `POST /admin/candidates/import`
  - `GET /admin/candidates`

## Files

- `workflow.py`: workflow + phases + API client + feature builder
- `run_workflow.py`: executable runner scaffold
- `requirements.txt`: Python dependencies

## Setup

```bash
cd /Users/rheasrivats/scholarship
python3.11 -m venv .venv311
source .venv311/bin/activate
pip install -r agent_orchestration/requirements.txt
```

Start the existing Node API in another terminal:

```bash
npm run api
```

## Run

```bash
python agent_orchestration/run_workflow.py \
  --doc /absolute/path/to/student_uc.pdf \
  --doc /absolute/path/to/student_private.docx \
  --student-stage starting_college \
  --agent-runtime codex-cli \
  --interaction-runtime auto \
  --discovery-max-results 8 \
  --discovery-query-budget 6
```

## Important

Runtime modes:

- `--agent-runtime codex-cli`: local Codex CLI runtime (default, uses your Codex login session)
- `--agent-runtime codex`: OpenAI API runtime (requires `OPENAI_API_KEY`)
- `--agent-runtime heuristic`: local no-key runtime for immediate dry runs
- `--agent-runtime human-proxy`: prompts you in terminal for each agent response
- `--interaction-runtime auto`: auto-approves Gate/Choose tasks
- `--interaction-runtime terminal`: interactive Gate/Choose prompts (requires questionary)

For `codex` runtime, set:

```bash
export OPENAI_API_KEY=...
# optional:
# export OPENAI_MODEL=gpt-5
# export OPENAI_BASE_URL=...
```

For `codex-cli` runtime:

- Ensure `codex` CLI is installed and logged in (`codex login`)
- Optional override: `export CODEX_BIN=/path/to/codex`

To keep early runs fast and avoid timeouts:

- `--discovery-max-results 5`
- `--discovery-query-budget 4`
- optionally add domain hints:

```bash
--discovery-domain scholarshipamerica.org \
--discovery-domain hsf.net \
--discovery-domain jkcf.org
```

You can also increase CLI timeout if needed:

```bash
export CODEX_CLI_TIMEOUT_SEC=300
```

For terminal interaction prompts, install:

```bash
source .venv311/bin/activate
pip install "iriai-compose[terminal]"
```
