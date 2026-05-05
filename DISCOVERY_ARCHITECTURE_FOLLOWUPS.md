# Discovery Architecture Follow-Ups

This note preserves implementation questions and follow-up ideas about the scholarship discovery loop. These are not all immediate action items. The goal is to keep the current observations visible so future iterations can revisit them intentionally.

## Query Generation

- Some queries are still hardcoded in ways that appear too applicant-specific or domain-specific.
- In particular, parts of the current query generation path appear to hardcode STEM-oriented language that will not generalize cleanly to other applicants.
- This is not the highest-priority issue right now, but it should be revisited before discovery is treated as broadly profile-agnostic.

## Web Search

- The `scholarship_web_search` step is fully deterministic right now.
- It is still worth evaluating whether that should remain fully deterministic or whether some parts of search ranking/query shaping should become more adaptive.
- The ranking logic around `direct_likely`, `hub_likely`, and related surface types should be revisited and better understood before making larger changes.

## Next Fetch Batch

- The search frontier is compacted before it is handed to the agentic selector.
- That compacted representation relies heavily on heuristics computed earlier in the pipeline rather than preserving more raw search-result evidence.
- This means `select_fetch_batch` is highly sensitive to upstream heuristic quality: if those heuristics are wrong or incomplete, the selection step will also degrade.

## Fetch Page Bundles

- This step is deterministic.
- No major concerns are captured here right now.

## Triage Fetched Pages

- The prompt is large and includes many edge cases.
- It should be reviewed later for prompt quality, redundancy, and whether the complexity is actually helping or just making behavior harder to reason about.
- During prompt compaction we currently keep only the top 5 child links from a page bundle.
- That child-link cap may affect downstream quality and should be evaluated explicitly rather than assumed to be harmless.

## Extract Candidate Leads From Hubs

- This step is deterministic, but the logic currently feels opaque and difficult to reason about.
- It should be revisited with a readability/debuggability lens, not just an output-quality lens.

## Hub Lineage Management

- This step is deterministic, but the scoring and promotion logic currently feels somewhat opaque.
- It should be revisited so it is easier to explain how hubs heat up, how sibling leads are promoted, and why certain lineages receive more budget than others.

## Assess Search Progress

- The prompt here currently feels stronger and more understandable than some of the other prompts.
- Even so, it would be useful to document more clearly how it knows what the available next steps are and what each step is intended to mean in the loop.

## Meta Follow-Up

- More of the discovery system should likely get explicit architecture notes over time:
  - which parts are deterministic
  - which parts are LLM-backed
  - which parts are true orchestration decisions versus local bounded classifications
- That would make future agent-vs-workflow decisions easier to reason about.
