from __future__ import annotations

import argparse
import asyncio
import json
import shutil
from pathlib import Path
from typing import Sequence

from iriai_compose import (
    AgentRuntime,
    DefaultContextProvider,
    DefaultWorkflowRunner,
    InMemoryArtifactStore,
    Role,
    Workspace,
)
from iriai_compose.runtimes import AutoApproveRuntime, TerminalInteractionRuntime

from codex_cli_runtime import CodexCliAgentRuntime
from codex_runtime import CodexAgentRuntime
from workflow import ScholarshipAgentWorkflow, ScholarshipApiClient, ScholarshipWorkflowState, build_feature


class HeuristicAgentRuntime(AgentRuntime):
    """Simple local runtime for quick end-to-end testing without model keys."""

    name = "heuristic"

    async def invoke(
        self,
        role: Role,
        prompt: str,
        *,
        output_type=None,
        workspace: Workspace | None = None,
        session_key: str | None = None,
    ):
        lowered = prompt.lower()
        if "summarize this student profile" in lowered:
            return (
                "- Student profile parsed from uploaded docs.\n"
                "- Use this as source-of-truth for filtering scholarships.\n"
                "- Prioritize high-award, high-fit, open opportunities.\n"
                "- Keep sensitive fields manual."
            )
        if "return json array of top 10 ids" in lowered:
            return json.dumps(
                [
                    {"id": "pending-1", "reason": "High potential fit and award."},
                    {"id": "pending-2", "reason": "Likely profile match and current deadline."},
                ],
                indent=2,
            )
        if "create a json autofill execution plan" in lowered:
            return json.dumps(
                {
                    "steps": [
                        "Open scholarship application page",
                        "Autofill safe profile fields",
                        "Prompt human for sensitive/manual fields",
                        "Pause for account creation if required",
                    ]
                },
                indent=2,
            )
        return "No-op response from heuristic runtime."


class HumanProxyAgentRuntime(AgentRuntime):
    """Runs agent tasks by asking the human in terminal, useful before model wiring."""

    name = "human-proxy"

    async def invoke(
        self,
        role: Role,
        prompt: str,
        *,
        output_type=None,
        workspace: Workspace | None = None,
        session_key: str | None = None,
    ):
        def _ask() -> str:
            print("\n" + "=" * 80)
            print(f"[Agent Role] {role.name}")
            print(f"[Session] {session_key or 'n/a'}")
            print("-" * 80)
            print(prompt)
            print("-" * 80)
            return input("Agent response> ").strip()

        return await asyncio.to_thread(_ask)


def build_agent_runtime(mode: str) -> AgentRuntime:
    if mode == "codex-cli":
        return CodexCliAgentRuntime()
    if mode == "codex":
        return CodexAgentRuntime()
    if mode == "human-proxy":
        return HumanProxyAgentRuntime()
    return HeuristicAgentRuntime()


def parse_args(argv: Sequence[str] | None = None):
    parser = argparse.ArgumentParser(description="Run scholarship multi-agent workflow (iriai-compose scaffold).")
    parser.add_argument(
        "--doc",
        action="append",
        required=True,
        help="Absolute path to student document (.pdf/.docx/.txt). Can be repeated.",
    )
    parser.add_argument("--feature-id", default="feature-scholarship-1")
    parser.add_argument("--api-base", default="http://localhost:3000")
    parser.add_argument(
        "--student-stage",
        choices=["starting_college", "in_college", "transfering_college"],
        default=None,
    )
    parser.add_argument("--student-age", type=int, default=None)
    parser.add_argument("--discovery-max-results", type=int, default=8)
    parser.add_argument("--discovery-query-budget", type=int, default=6)
    parser.add_argument(
        "--discovery-domain",
        action="append",
        default=[],
        help="Optional domain allowlist hint for agent discovery (repeatable).",
    )
    parser.add_argument(
        "--agent-runtime",
        choices=["codex-cli", "codex", "heuristic", "human-proxy"],
        default="codex-cli",
        help="Runtime for AgentActor tasks.",
    )
    parser.add_argument(
        "--interaction-runtime",
        choices=["terminal", "auto"],
        default="auto",
        help="Runtime for human interaction tasks (Gate/Choose).",
    )
    parser.add_argument(
        "--discovery-only",
        action="store_true",
        help="Run parse + agent discovery/import only (skip shortlist + autofill planning phases).",
    )
    parser.add_argument(
        "--out",
        default="",
        help="Optional path to write full workflow result JSON.",
    )
    return parser.parse_args(argv)


async def main(argv: Sequence[str] | None = None):
    args = parse_args(argv)

    print("[runner] Starting scholarship workflow", flush=True)
    print(f"[runner] Agent runtime: {args.agent_runtime}", flush=True)
    print(f"[runner] Interaction runtime: {args.interaction_runtime}", flush=True)
    print(f"[runner] API base: {args.api_base}", flush=True)
    print(f"[runner] Discovery-only: {args.discovery_only}", flush=True)

    if args.agent_runtime == "codex-cli":
      codex_path = shutil.which("codex")
      if not codex_path:
        raise RuntimeError("codex binary not found in PATH. Install codex CLI or set CODEX_BIN.")
      print(f"[runner] codex binary: {codex_path}", flush=True)

    api_client = ScholarshipApiClient(base_url=args.api_base)
    print("[runner] Checking API health...", flush=True)
    await api_client.healthcheck()
    print("[runner] API is reachable", flush=True)

    artifacts = InMemoryArtifactStore()
    interaction_runtimes = {"auto": AutoApproveRuntime()}
    if args.interaction_runtime == "terminal":
        try:
            interaction_runtimes["terminal"] = TerminalInteractionRuntime()
        except Exception:
            raise RuntimeError(
                "Terminal interaction requires questionary. "
                "Install it with: .venv311/bin/pip install 'iriai-compose[terminal]'"
            )

    runner = DefaultWorkflowRunner(
        agent_runtime=build_agent_runtime(args.agent_runtime),
        interaction_runtimes=interaction_runtimes,
        artifacts=artifacts,
        context_provider=DefaultContextProvider(artifacts=artifacts),
    )

    feature = build_feature(
        feature_id=args.feature_id,
        document_paths=args.doc,
        api_base_url=args.api_base,
        student_stage=args.student_stage,
        student_age=args.student_age,
        interaction_resolver=args.interaction_runtime,
        discovery_max_results=args.discovery_max_results,
        discovery_query_budget=args.discovery_query_budget,
        discovery_domains=args.discovery_domain,
        discovery_only=args.discovery_only,
    )

    final_state = await runner.execute_workflow(
        ScholarshipAgentWorkflow(),
        feature,
        ScholarshipWorkflowState(),
    )
    student = final_state.student_profile or {}
    personal = student.get("personalInfo", {}) if isinstance(student, dict) else {}
    summary = {
        "featureId": feature.id,
        "student": {
            "name": personal.get("fullName"),
            "major": personal.get("intendedMajor"),
            "ethnicity": personal.get("ethnicity"),
            "state": personal.get("state"),
            "stage": feature.metadata.get("student_stage"),
            "age": personal.get("age"),
        },
        "counts": {
            "discoveredCandidates": int(final_state.agent_discovered_count),
            "importedCandidates": int(final_state.imported_candidate_count),
            "shortlistedCandidates": len(final_state.shortlisted_candidates),
            "approvedIds": len(final_state.approved_ids),
            "autofillPlans": len(final_state.autofill_plan),
        },
        "discoveryOnly": args.discovery_only,
        "approvedIds": final_state.approved_ids,
        "discoveryErrors": list(final_state.discovery_errors),
        "shortlistPreview": [
            {
                "id": c.get("id"),
                "name": c.get("name"),
                "awardAmount": c.get("awardAmount"),
                "deadline": c.get("deadline"),
                "sourceDomain": c.get("sourceDomain"),
            }
            for c in final_state.shortlisted_candidates[:10]
        ],
    }

    print("[runner] Workflow finished", flush=True)
    print("[runner] Result summary:", flush=True)
    print(json.dumps(summary, indent=2), flush=True)

    if args.out:
        out_path = Path(args.out).expanduser().resolve()
        out_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "summary": summary,
            "state": final_state.model_dump(),
        }
        out_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        print(f"[runner] Wrote result JSON to {out_path}", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
