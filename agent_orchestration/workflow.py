from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, List

import httpx
from pydantic import BaseModel, Field

from iriai_compose import (
    AgentActor,
    Ask,
    Choose,
    Feature,
    Gate,
    InteractionActor,
    Phase,
    Role,
    Workflow,
)


class ScholarshipWorkflowState(BaseModel):
    student_profile: dict[str, Any] = Field(default_factory=dict)
    discovered_candidates: list[dict[str, Any]] = Field(default_factory=list)
    shortlisted_candidates: list[dict[str, Any]] = Field(default_factory=list)
    approved_ids: list[str] = Field(default_factory=list)
    autofill_plan: list[dict[str, Any]] = Field(default_factory=list)
    agent_discovered_count: int = 0
    imported_candidate_count: int = 0
    discovery_errors: list[str] = Field(default_factory=list)


class DiscoveryEligibility(BaseModel):
    minGpa: float | None = None
    allowedMajors: list[str] = Field(default_factory=list)
    allowedEthnicities: list[str] = Field(default_factory=list)


class DiscoveryInferredRequirements(BaseModel):
    requiredMajors: list[str] = Field(default_factory=list)
    requiredEthnicities: list[str] = Field(default_factory=list)
    requiredStates: list[str] = Field(default_factory=list)
    minAge: int | None = None
    maxAge: int | None = None
    requirementStatements: list[str] = Field(default_factory=list)


class DiscoveryCandidate(BaseModel):
    name: str
    sourceDomain: str
    sourceUrl: str = ""
    sourceName: str = ""
    awardAmount: float = 0
    deadline: str = ""
    requiresAccount: bool = False
    estimatedEffortMinutes: int = 30
    eligibility: DiscoveryEligibility = Field(default_factory=DiscoveryEligibility)
    inferredRequirements: DiscoveryInferredRequirements = Field(default_factory=DiscoveryInferredRequirements)
    essayPrompts: list[str] = Field(default_factory=list)


class DiscoverySearchResult(BaseModel):
    candidates: list[DiscoveryCandidate] = Field(default_factory=list)


@dataclass
class ScholarshipApiClient:
    base_url: str = "http://localhost:3000"

    async def healthcheck(self) -> None:
        async with httpx.AsyncClient(timeout=8) as client:
            try:
                response = await client.get(f"{self.base_url}/health")
            except httpx.HTTPError as exc:
                raise RuntimeError(
                    f"Scholarship API is unreachable at {self.base_url}. "
                    "Start it with `npm run api` (or pass --api-base for a different port)."
                ) from exc

            if response.status_code != 200:
                raise RuntimeError(
                    f"Scholarship API health check failed at {self.base_url}/health "
                    f"(status {response.status_code})."
                )

    async def run_profile_extraction(self, session_id: str, documents: list[dict[str, Any]]) -> dict[str, Any]:
        payload = {
            "sessionId": session_id,
            "documents": documents,
            "maxDrafts": 1,
            "overrides": {},
        }
        async with httpx.AsyncClient(timeout=120) as client:
            response = await client.post(f"{self.base_url}/run-no-account-mvp-upload", json=payload)
            response.raise_for_status()
            return response.json()

    async def import_candidates(
        self,
        candidates: list[dict[str, Any]],
        replace_pending: bool = True,
    ) -> dict[str, Any]:
        payload = {
            "candidates": candidates,
            "replacePending": replace_pending,
        }
        async with httpx.AsyncClient(timeout=120) as client:
            response = await client.post(f"{self.base_url}/admin/candidates/import", json=payload)
            response.raise_for_status()
            return response.json()

    async def get_candidates(self) -> list[dict[str, Any]]:
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.get(f"{self.base_url}/admin/candidates")
            response.raise_for_status()
            payload = response.json()
            return payload.get("candidates", [])


def _encode_documents_b64(document_paths: list[str]) -> list[dict[str, Any]]:
    import base64
    from pathlib import Path

    payload = []
    for index, path in enumerate(document_paths):
        file_path = Path(path).expanduser().resolve()
        content = base64.b64encode(file_path.read_bytes()).decode("utf-8")
        payload.append(
            {
                "documentId": f"student-doc-{index + 1}",
                "fileName": file_path.name,
                "contentBase64": content,
            }
        )
    return payload


def _feature_meta(feature: Feature) -> dict[str, Any]:
    metadata = getattr(feature, "metadata", None)
    if isinstance(metadata, dict):
        return metadata
    return {}


# Actors: one orchestrator/planner, one autofill specialist, and one human reviewer.
planner_agent = AgentActor(
    name="planner",
    role=Role(
        name="scholarship-planner",
        prompt=(
            "You are a scholarship matching planner. "
            "Given student profile and candidate scholarships, produce concise rationale, "
            "reject weak fits, and prioritize high-fit opportunities."
        ),
        tools=["Read", "Grep"],
    ),
)

autofill_agent = AgentActor(
    name="autofill",
    role=Role(
        name="autofill-specialist",
        prompt=(
            "You prepare safe autofill plans. Never include blocked sensitive values "
            "(ssn/passport/payment numbers)."
        ),
        tools=["Read"],
    ),
)

human_reviewer_terminal = InteractionActor(name="human-reviewer", resolver="terminal")
human_reviewer_auto = InteractionActor(name="human-reviewer", resolver="auto")


def _interaction_actor_for(feature: Feature) -> InteractionActor:
    meta = _feature_meta(feature)
    resolver = meta.get("interaction_resolver", "auto")
    return human_reviewer_terminal if resolver == "terminal" else human_reviewer_auto


class ParseStudentPhase(Phase):
    name = "parse-student"

    async def execute(self, runner, feature, state: ScholarshipWorkflowState):
        print("[workflow] Phase: parse-student", flush=True)
        meta = _feature_meta(feature)
        docs: list[dict[str, Any]] = meta.get("documents", [])
        api_base = meta.get("api_base_url", "http://localhost:3000")
        client = ScholarshipApiClient(base_url=api_base)

        ingestion = await client.run_profile_extraction(session_id=feature.id, documents=docs)
        state.student_profile = ingestion.get("mergedProfile", {})
        print("[workflow] Parsed student profile", flush=True)

        if bool(meta.get("discovery_only")):
            return state

        summary = await runner.run(
            Ask(
                actor=planner_agent,
                prompt=(
                    "Summarize this student profile in <=8 bullets for scholarship matching:\n"
                    f"{json.dumps(state.student_profile, indent=2)}"
                ),
            ),
            feature,
        )
        await runner.artifacts.put("student_profile_summary", str(summary), feature=feature)
        return state


class DiscoverAndShortlistPhase(Phase):
    name = "discover-and-shortlist"

    async def execute(self, runner, feature, state: ScholarshipWorkflowState):
        print("[workflow] Phase: discover-and-shortlist", flush=True)
        meta = _feature_meta(feature)
        api_base = meta.get("api_base_url", "http://localhost:3000")
        client = ScholarshipApiClient(base_url=api_base)
        discovery_max_results = int(meta.get("discovery_max_results", 8) or 8)
        discovery_query_budget = int(meta.get("discovery_query_budget", 6) or 6)
        discovery_domains = meta.get("discovery_domains") or []
        student_stage = str(meta.get("student_stage") or "").strip()
        student_age = meta.get("student_age")

        compact_profile = _compact_student_profile_for_discovery(state.student_profile)
        if student_stage:
            compact_profile["studentStage"] = student_stage
        if student_age is not None:
            compact_profile["studentAgeHint"] = student_age
        discovered = []
        state.discovery_errors = []
        attempts = _build_discovery_attempts(
            discovery_max_results=discovery_max_results,
            discovery_query_budget=discovery_query_budget,
            discovery_domains=discovery_domains,
            compact_profile=compact_profile,
        )

        for attempt_index, attempt in enumerate(attempts, start=1):
            print(
                "[workflow] Discovery attempt "
                f"{attempt_index}/{len(attempts)}: results<={attempt['max_results']} "
                f"queries<={attempt['query_budget']}",
                flush=True,
            )
            try:
                discovered_result = await runner.run(
                    Ask(
                        actor=planner_agent,
                        prompt=attempt["prompt"],
                        output_type=DiscoverySearchResult,
                    ),
                    feature,
                )
                await runner.artifacts.put(
                    f"agent_discovered_attempt_{attempt_index}",
                    discovered_result.model_dump_json(indent=2),
                    feature=feature,
                )
                discovered = [candidate.model_dump() for candidate in discovered_result.candidates]
                if discovered:
                    break
                state.discovery_errors.append(f"attempt_{attempt_index}:empty_result")
                print(f"[workflow] Discovery attempt {attempt_index} returned 0 candidates", flush=True)
            except Exception as exc:
                error_summary = _summarize_discovery_exception(exc)
                state.discovery_errors.append(f"attempt_{attempt_index}:{error_summary}")
                print(
                    f"[workflow] Discovery attempt {attempt_index} failed: {error_summary}",
                    flush=True,
                )
                if _looks_like_timeout(exc) or attempt_index == len(attempts):
                    raise

        state.agent_discovered_count = len(discovered)
        await runner.artifacts.put("agent_discovered_count", str(len(discovered)), feature=feature)
        print(f"[workflow] Agent discovered candidates: {len(discovered)}", flush=True)

        import_result = await client.import_candidates(discovered, replace_pending=True)
        state.imported_candidate_count = len(import_result.get("imported", []))
        print(
            f"[workflow] Imported into queue: {state.imported_candidate_count} "
            f"(source: {import_result.get('sourceFile', 'n/a')})",
            flush=True,
        )
        candidates = await client.get_candidates()
        pending = [c for c in candidates if c.get("status") == "pending"]
        state.discovered_candidates = pending
        print(f"[workflow] Pending candidates discovered: {len(pending)}", flush=True)

        if bool(meta.get("discovery_only")):
            return state

        shortlist = await runner.run(
            Ask(
                actor=planner_agent,
                prompt=(
                    "Given this student profile and pending scholarships, return JSON array of top 10 ids "
                    "ranked by (1) money, (2) fit, (3) essay alignment. Include reason per id.\n\n"
                    f"Student profile:\n{json.dumps(state.student_profile, indent=2)}\n\n"
                    f"Candidates:\n{json.dumps(pending, indent=2)}"
                ),
            ),
            feature,
        )
        await runner.artifacts.put("shortlist_reasoning", str(shortlist), feature=feature)

        # Let human pick from agent shortlist.
        choice = await runner.run(
            Choose(
                chooser=_interaction_actor_for(feature),
                prompt="Select scholarships to proceed with autofill planning.",
                options=[f"{c.get('id')} | {c.get('name')}" for c in pending[:15]],
            ),
            feature,
        )

        selected = choice if isinstance(choice, list) else [choice]
        selected_ids = [str(line).split("|")[0].strip() for line in selected if str(line).strip()]
        state.approved_ids = selected_ids
        state.shortlisted_candidates = [c for c in pending if c.get("id") in selected_ids]
        return state


class AutofillPlanPhase(Phase):
    name = "autofill-plan"

    async def execute(self, runner, feature, state: ScholarshipWorkflowState):
        print("[workflow] Phase: autofill-plan", flush=True)
        if not state.shortlisted_candidates:
            print("[workflow] No shortlisted candidates selected; skipping autofill-plan", flush=True)
            return state

        plan = await runner.run(
            Ask(
                actor=autofill_agent,
                prompt=(
                    "Create a JSON autofill execution plan for the selected scholarships. "
                    "For each scholarship include: id, required_manual_fields, safe_autofill_fields, "
                    "and whether account handoff is required.\n\n"
                    f"Student profile:\n{json.dumps(state.student_profile, indent=2)}\n\n"
                    f"Selected scholarships:\n{json.dumps(state.shortlisted_candidates, indent=2)}"
                ),
            ),
            feature,
        )
        await runner.artifacts.put("autofill_execution_plan", str(plan), feature=feature)

        approval = await runner.run(
            Gate(
                approver=_interaction_actor_for(feature),
                prompt="Approve this autofill plan and continue to implementation?",
            ),
            feature,
        )
        if not approval:
            return state

        state.autofill_plan = [{"raw_plan": str(plan)}]
        return state


class ScholarshipAgentWorkflow(Workflow):
    name = "scholarship-agent-workflow"

    def build_phases(self) -> List[type[Phase]]:
        return [ParseStudentPhase, DiscoverAndShortlistPhase, AutofillPlanPhase]


def _build_discovery_attempts(
    *,
    discovery_max_results: int,
    discovery_query_budget: int,
    discovery_domains: list[str],
    compact_profile: dict[str, Any],
) -> list[dict[str, Any]]:
    primary_max_results = max(1, discovery_max_results)
    primary_query_budget = max(1, discovery_query_budget)
    attempts = [
        {
            "max_results": primary_max_results,
            "query_budget": primary_query_budget,
        }
    ]

    fallback_max_results = min(primary_max_results, 4)
    fallback_query_budget = min(primary_query_budget, 3)
    if fallback_max_results < primary_max_results or fallback_query_budget < primary_query_budget:
        attempts.append(
            {
                "max_results": max(1, fallback_max_results),
                "query_budget": max(1, fallback_query_budget),
            }
        )

    for attempt in attempts:
        attempt["prompt"] = _build_discovery_prompt(
            max_results=attempt["max_results"],
            query_budget=attempt["query_budget"],
            discovery_domains=discovery_domains,
            compact_profile=compact_profile,
        )
    return attempts


def _build_discovery_prompt(
    *,
    max_results: int,
    query_budget: int,
    discovery_domains: list[str],
    compact_profile: dict[str, Any],
) -> str:
    domain_instruction = (
        f"Prefer these domains when they have matching opportunities: {', '.join(discovery_domains)}.\n"
        if discovery_domains
        else ""
    )
    return (
        f"Use web search to find up to {max_results} currently-open U.S. scholarships that match this student. "
        f"Use at most {query_budget} search queries total.\n\n"
        "Be selective: prefer high-fit, currently-open scholarships with clear eligibility details. "
        "Exclude clearly closed scholarships, sweepstakes, and generic scholarship listing pages unless the page itself is the application source.\n\n"
        "Return a JSON object with a single key `candidates`, whose value is an array of scholarships matching the schema. "
        "Use empty strings, false, 0, null, or [] when data is unavailable. Do not include commentary.\n\n"
        f"{domain_instruction}"
        f"Student profile:\n{json.dumps(compact_profile, indent=2)}"
    )


def _looks_like_timeout(exc: Exception) -> bool:
    text = _summarize_discovery_exception(exc).lower()
    return "timed out" in text or "timeout" in text


def _summarize_discovery_exception(exc: Exception) -> str:
    text = str(exc).strip()
    if not text:
        return exc.__class__.__name__
    return " ".join(text.split())


def _compact_student_profile_for_discovery(profile: dict[str, Any]) -> dict[str, Any]:
    personal = profile.get("personalInfo", {}) if isinstance(profile, dict) else {}
    academics = profile.get("academics", {}) if isinstance(profile, dict) else {}
    activities = profile.get("activities", []) if isinstance(profile, dict) else []
    awards = profile.get("awards", []) if isinstance(profile, dict) else []

    return {
        "personalInfo": {
            "intendedMajor": personal.get("intendedMajor"),
            "ethnicity": personal.get("ethnicity"),
            "state": personal.get("state"),
            "age": personal.get("age"),
        },
        "academics": {
            "gpa": academics.get("gpa"),
            "graduationYear": academics.get("graduationYear"),
        },
        "activitiesTop": activities[:6] if isinstance(activities, list) else [],
        "awardsTop": awards[:6] if isinstance(awards, list) else [],
    }


def build_feature(
    feature_id: str,
    document_paths: list[str],
    api_base_url: str = "http://localhost:3000",
    student_stage: str | None = None,
    student_age: int | None = None,
    interaction_resolver: str = "auto",
    discovery_max_results: int = 8,
    discovery_query_budget: int = 6,
    discovery_domains: list[str] | None = None,
    discovery_only: bool = False,
) -> Feature:
    return Feature(
        id=feature_id,
        name="Scholarship Agent Workflow",
        slug="scholarship-agent-workflow",
        workflow_name=ScholarshipAgentWorkflow.name,
        workspace_id="scholarship-workspace",
        metadata={
            "api_base_url": api_base_url,
            "documents": _encode_documents_b64(document_paths),
            "student_stage": student_stage,
            "student_age": student_age,
            "interaction_resolver": interaction_resolver,
            "discovery_max_results": discovery_max_results,
            "discovery_query_budget": discovery_query_budget,
            "discovery_domains": discovery_domains or [],
            "discovery_only": discovery_only,
        },
    )
