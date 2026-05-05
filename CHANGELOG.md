# Changelog

This file tracks notable changes to the project going forward.

The history before this file was not recorded release-by-release, so the initial entry below is a baseline snapshot of the current system as of 2026-04-08.

## [Unreleased]

### Added

- Started a project-level changelog for tracking future architectural, product, and implementation changes.
- Added a dedicated discovery architecture follow-up note in [DISCOVERY_ARCHITECTURE_FOLLOWUPS.md](/Users/rheasrivats/src/scholarship/DISCOVERY_ARCHITECTURE_FOLLOWUPS.md) to preserve open questions and future investigation areas across the search loop.
- Added a dedicated search-manager rewrite planning document in [SEARCH_MANAGER_REWRITE_PLAN.md](/Users/rheasrivats/scholarship/SEARCH_MANAGER_REWRITE_PLAN.md).
- Captured a tool-by-tool implementation workflow for the search-manager rewrite: review, build, and evaluate each tool before implementing the full manager loop.
- Implemented the first search-manager tool, `scholarship_web_search`, as a standalone module with a dedicated debug endpoint at `POST /admin/search-manager/debug/web-search`.
- Implemented the second search-manager tool, `batch_fetch_page_bundles`, as a standalone module with a dedicated debug endpoint at `POST /admin/search-manager/debug/page-bundles`.
- Implemented the third search-manager tool, `select_fetch_batch`, as a standalone module with a dedicated debug endpoint at `POST /admin/search-manager/debug/select-fetch-batch`.
- Added an agentic `select_fetch_batch` implementation with `gpt-5.3-codex-spark` as the default model, strict schema validation, stable result IDs, and deterministic fallback on model failure.
- Implemented the fourth search-manager tool, `triage_frontier`, as a standalone module with a dedicated debug endpoint at `POST /admin/search-manager/debug/triage-frontier`.
- Added an agentic `triage_frontier` implementation with `gpt-5.3-codex-spark` as the default model, strict schema validation, and deterministic fallback on model failure.
- Implemented the fifth search-manager tool, `decide_hub_expansion`, as a standalone module with a dedicated debug endpoint at `POST /admin/search-manager/debug/decide-hub-expansion`.
- Added an agentic `decide_hub_expansion` implementation with `gpt-5.3-codex-spark` as the default model, strict schema validation, stable child IDs, and deterministic fallback on model failure.
- Implemented the sixth search-manager tool, `assess_search_progress`, as a standalone module with a dedicated debug endpoint at `POST /admin/search-manager/debug/assess-search-progress`.
- Added an agentic `assess_search_progress` implementation with `gpt-5.3-codex-spark` as the default model, strict schema validation, and deterministic fallback on model failure.
- Replaced the rough `decide_hub_expansion` stub with a concrete v1 contract covering purpose, loop position, bounded input/output shape, child-link selection rules, and the planned agentic-with-deterministic-validation implementation pattern.
- Expanded the `decide_hub_expansion` draft output for early debugging so it can return both selected and rejected child links with short reasons, while preserving a simple `selectedChildUrls` orchestration field.
- Relaxed page-bundle stage extraction so mixed-audience language like “current and incoming students” no longer creates a false explicit mismatch for starting-college students, which in turn allows valid scholarship hubs like UH to expand into their named child scholarship pages.
- Added search-time institution-specific and school-specific caution signals in `scholarship_web_search` and used them in `select_fetch_batch` so early fetch rounds prefer broader opportunities when comparable non-school-specific results exist.
- Replaced the rough `assess_search_progress` stub with a concrete run-level contract covering stop/continue/replan decisions, next-step routing (`fetch_remaining_frontier`, `expand_held_hubs`, `widen_queries`, `stop_now`), the early target of 5 acceptable scholarships, and stronger handling of school-specific pressure in loop decisions.
- Explicitly marked `assess_search_progress` as an agentic-with-deterministic-fallback orchestration step, with backend-enforced hard stops even when the model suggests continuing.
- Simplified the planned `assess_search_progress` output by dropping `notes`, keeping only the decision fields needed to drive the loop plus optional replan directions.
- Simplified the remaining end-stage tool plan by folding final eligibility checking into `finalize_candidate_from_page` and replacing separate `dedupe_candidates` / `rank_final_candidates` tools with one deterministic backend `postprocess_final_candidates` stage.
- Added isolated tool tests covering normalized results, heuristic annotations, denied-domain filtering, and history-aware signals.
- Added isolated tool tests covering fetched-page evidence snippets, explicit stage mismatch detection, stale/indirect content flags, and bounded child-link extraction.
- Added `extract_candidate_leads_from_hubs` as a deterministic held-hub lead extractor with a dedicated debug endpoint, so mixed hub pages can produce named candidate leads without blindly expanding generic advice/search links.
- Added hot-hub lineage orchestration helpers so productive hub families can reserve sibling leads, heat up when one child converts, and promote additional siblings for follow-up fetches.

### Changed

- Promoted the successful non-school-bias experiment into the default `scholarship_web_search` ranking behavior by strengthening the baseline penalties for institution-specific and school-specific results, so university-locked opportunities are deprioritized earlier even without enabling an experiment variant.
- Reworked deterministic discovery query generation for `starting_college` students so broad and generic query families widen major/ethnicity/geography while staying anchored to incoming-freshman and high-school-senior language, instead of drifting into generic undergraduate phrasing.
- Tightened the AI search-expansion prompt so fallback query suggestions preserve student-stage constraints and only broaden other dimensions first when deterministic search needs supplemental options.
- Tightened `scholarship_web_search` heuristics so obvious roundup pages are less likely to be misclassified as direct scholarship pages, scholarship program landing pages can be labeled as `hub_likely`, blog-style domains contribute to `negativeBlogSignal`, and debug responses now expose `fitScore`.
- Revised `scholarship_web_search` so `surfaceType` is treated as a weak structural hint rather than a strong quality signal, and reduced its influence on `fitScore` accordingly.
- Added `staleCycleSignal` and `indirectContentSignal` to `scholarship_web_search` so older-cycle snippets and editorial roundup content are easier to down-rank during frontier generation.
- Added explicit output-size caps to the draft `batch_fetch_page_bundles` contract, including limits for URLs per batch, text excerpt size, evidence snippet size, child-link count, and overall debug response size.
- Refined the draft `batch_fetch_page_bundles` contract to group fetched-page signals by priority and role: `blockers`, `fitSignals`, and `pageSignals`.
- Trimmed the draft `batch_fetch_page_bundles` v1 signal set to the core blockers, fit signals, and page signals needed for triage, deferring lower-priority refinements like GPA constraints and link-density signals.
- Tightened the draft `batch_fetch_page_bundles` child-link contract for v1 to a compact bounded shape: `url`, `anchorText`, `sourceDomain`, `sameDomain`, `detailPathLikely`, and `seenRecently`.
- Refined `batch_fetch_page_bundles` so mixed-stage scholarship pages are less likely to be flagged as hard stage mismatches, and added `specificSchoolSignal` to surface school-tied opportunities without auto-excluding them.
- Replaced the rough `triage_frontier` draft with a concrete action-oriented contract aligned to the implemented `scholarship_web_search` and `batch_fetch_page_bundles` outputs, including explicit decision labels, rationale requirements, and weighting guidance for weak priors versus fetched-page evidence.
- Updated the search-manager flow to fetch in rounds, added a new `select_fetch_batch` planning step ahead of `triage_frontier`, and documented an initial target of returning at least 5 acceptable scholarships when possible during early runs.
- Simplified the draft `select_fetch_batch` output for v1 so it only returns the chosen fetch URLs plus trace rationale, leaving unselected frontier items implicitly deferred.
- Simplified the draft `triage_frontier` contract for v1 so it operates on fetched page bundles only, uses only small remaining-budget context, and returns explicit per-page `advance_to_finalize`, `hold_for_expansion`, or `drop` decisions with concise rationales.
- Simplified the draft `triage_frontier` output shape further by dropping `confidence` from v1 and keeping only `url`, `action`, and `rationale` per decision, plus grouped queues for orchestration.
- Hardened `batch_fetch_page_bundles` deadline extraction so `application closes` wording is parsed as an expired deadline blocker, which fixes pages like SHPE being dropped for the correct closed/expired reason instead of a generic fallback rationale.
- Hardened `batch_fetch_page_bundles` against aggregator false positives by adding `aggregatorSummarySignal` and `originalSourceLinkSignal`, preventing directory summary pages like AccessScholarships scholarship mirrors from being treated as direct scholarship pages before their original source is fetched.
- Improved `batch_fetch_page_bundles` page-title selection so a noisy non-scholarship H1 no longer overrides a cleaner scholarship document title, fixing HACU-style pages whose visible heading can point at unrelated site chrome.
- Hardened `batch_fetch_page_bundles` partial-deadline handling so current-cycle month/day deadlines like “Application Deadline March 15” can still create an expired blocker without inventing a stored full deadline date.
- Added the concrete prompt, schema, model choice, and validation plan for converting `triage_frontier` into a bounded agentic step with deterministic backend fallback.
- Hardened the agentic `triage_frontier` contract to use stable `pageId` keys instead of raw URLs, reducing fallback risk from model-side URL rewriting while preserving URL-based output after backend validation.
- Updated `triage_frontier` and `decide_hub_expansion` to consume `aggregatorSummarySignal` and `originalSourceLinkSignal`, so aggregator mirror pages are expanded toward offsite original-source links instead of being finalized directly or expanded deeper into same-domain directory pages.
- Updated the core search-flow runner to use extracted candidate leads from held hubs as the next expansion frontier, preserving compatibility with the previous `selectedChildUrls` debug surface.
- Tightened `extract_candidate_leads_from_hubs` metadata so aggregator-derived leads are marked as needing eligibility verification and no longer inherit parent-page fit signals as if child eligibility were already verified.
- Hardened `extract_candidate_leads_from_hubs` against provider/referral/winner/rules/navigation links and obvious later-college child pages, and deduplicated queued hub-expansion URLs in the core-flow runner.
- Added triage-frontier experiment support for trusted aggregator detail pages and a replay CLI, enabling side-by-side evaluation of when strong aggregator detail pages should advance directly instead of consuming extra expansion hops.
- Reworked `select_fetch_batch` to use a quality floor and conversion-oriented slotting, so weak second-wave frontier pages no longer fill fetch slots by default while one trusted aggregator exploration path can still survive.
- Updated the core search-flow runner to keep reserve sibling leads for held hubs, heat hub lineages when one child advances or nearly converts, and prioritize promoted sibling fetches from productive hubs in later expansion rounds.

## [Baseline Snapshot] - 2026-04-08

### Added

- Multi-document upload and parsing pipeline for `PDF`, `DOCX`, and `TXT`.
- Student profile extraction, merge logic, confidence tracking, and provenance tracking.
- Optional AI enrichment for missing or low-confidence profile fields.
- Scholarship matching, eligibility evaluation, and deterministic ranking.
- Candidate queue workflow with approve/reject/review states.
- Discovery pipeline with query generation, web search, fetch, extraction, list-page expansion, URL history, and diagnostics.
- Discovery-side AI assists for query expansion, borderline page classification, and ambiguous candidate refinement.
- Guided submission workflow with account handoff and resume support.
- Autofill draft generation, essay drafting, and form mapping support.
- Supabase-backed candidate persistence with local JSON fallback.
- Browser UI for upload, review, discovery, candidate queue management, and submission progress.
- Automated test coverage for parsing, matching, discovery, candidate storage, autofill, and safety checks.

### Notes

- This entry is a starting snapshot, not a complete reconstruction of all prior incremental changes.
- Future entries should be appended to `Unreleased` and grouped under clear headings such as `Added`, `Changed`, `Fixed`, and `Removed`.
