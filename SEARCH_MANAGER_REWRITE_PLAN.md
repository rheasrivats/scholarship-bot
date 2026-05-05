# Search Manager Rewrite Plan

## Summary

This document captures the current plan for rewriting scholarship discovery as a search-first, manager-led system.

Current direction:

- Scope: search-first rewrite
- Search source for v1: web only
- Agent shape: one manager with tools
- Search stack: hybrid
- Primary iteration surface: backend debug endpoint, outside the UI
- Rollout target: direct replacement of the old discovery flow after iteration is satisfactory
- Output contract: queue-ready scholarship candidates
- Evidence level: strong evidence on accepted candidates
- Extraction authority: backend finalizer
- Agent autonomy: bounded loops

## Why This Rewrite

The current discovery pipeline is deterministic-first with a few narrow AI assists. The new design flips that balance:

- The manager makes bounded exploration decisions:
  - query choice
  - frontier triage
  - whether a page is worth fetching
  - whether a hub/list page is worth expanding
  - when to replan or stop
- Deterministic backend code remains the authority for:
  - fetch behavior
  - URL normalization
  - dedupe
  - extraction acceptance
  - eligibility checks
  - final ranking

This keeps search flexible while preserving product consistency and debuggability.

## High-Level Architecture

### Flow

1. Extract and merge the student profile using the existing profile pipeline.
2. Start a manager-led search run with explicit budgets.
3. Search the web with profile-aware query batches.
4. Select a small fetch batch from the current search frontier.
5. Fetch selected pages through deterministic backend fetchers.
6. Triage fetched pages into next-step actions.
7. Expand promising hubs/list pages only when the manager approves and budget remains.
8. Finalize direct scholarship candidates through a deterministic backend finalizer.
9. If too few acceptable scholarships have been found and budget remains, repeat fetch-and-triage rounds from the remaining frontier.
10. Run deterministic eligibility checks, dedupe, and ranking.
11. Return queue-ready candidates plus a full trace.

### Budget Defaults

Initial defaults for the debug endpoint:

- Max search rounds: 3
- Max total queries: 6
- Max fetched pages: 25
- Max fetches per round: 6
- Max expansion depth: 2
- Max recovery replans: 1
- Initial target accepted scholarships: 5

These are debug-endpoint knobs, but v1 should ship with safe defaults.

## Tool Philosophy

The manager should not micromanage plumbing. It should receive meaningful tools that map to search decisions.

Good manager questions:

- What should I search next?
- Which results deserve fetch budget?
- Is this page one scholarship, a hub, or junk?
- Should I expand this hub?
- Do I already have enough good candidates to stop?

Bad manager responsibilities:

- raw retry logic
- URL normalization
- exact dedupe mechanics
- final schema acceptance
- final ranking policy

## Tool-By-Tool Implementation Workflow

We will build the system incrementally, one tool at a time, rather than implementing the full manager loop first.

Each tool will go through the same sequence:

1. review the tool contract
2. build the tool
3. evaluate the tool in isolation
4. lock behavior and contract
5. move to the next tool

The manager loop should only be implemented after the first-pass toolset is built and evaluated.

### Recommended build order

1. `scholarship_web_search`
2. `batch_fetch_page_bundles`
3. `select_fetch_batch`
4. `triage_frontier`
5. `decide_hub_expansion`
6. `assess_search_progress`
7. `finalize_candidate_from_page`
8. `postprocess_final_candidates`

### Evaluation gate for each tool

No tool is done until:

- the input/output shape feels stable
- the behavior is understandable from the debug trace
- failure behavior is clear
- we have at least a minimal fixture or regression harness for it
- we still agree it should remain a standalone tool rather than being split or merged

## Concrete Tool Spec

### 1. `scholarship_web_search`

Purpose:
- Open new frontier from one query batch using a scholarship-oriented search contract.
- This is a custom backend tool contract, not the raw provider tool.
- In v1, it may be implemented on top of OpenAI built-in `web_search`, but the manager should only see the normalized contract below.

Non-goals:

- It does not fetch full pages.
- It does not finalize scholarship candidates.
- It does not decide the final ranking.
- It does not expose raw provider-specific response shapes to the manager.

Provider behavior hidden behind this tool:

- provider selection
- provider request syntax
- provider-specific metadata
- provider-specific filtering quirks
- raw source/citation formatting

Required behavior:

- accept a batch of search queries
- return normalized search hits
- annotate each hit with scholarship-specific heuristics
- annotate institution-specific and school-specific caution signals so pre-fetch selection can prefer broader opportunities when the frontier is mixed
- preserve enough provider metadata for debugging without coupling the manager to the provider
- support domain allow/deny hints
- participate in the run trace

Input:

```json
{
  "queries": ["mechanical engineering scholarship incoming freshman"],
  "maxResultsPerQuery": 8,
  "domainAllowHints": ["scholarshipamerica.org"],
  "domainDenyHints": ["reddit.com"],
  "queryFamily": "specific_fit",
  "runContext": {
    "studentStage": "starting_college",
    "round": 1
  }
}
```

Field notes:

- `queries`
  1 to N search strings for one manager-selected batch
- `maxResultsPerQuery`
  backend-enforced cap; manager hint only
- `domainAllowHints`
  soft preference list, not a hard guarantee
- `domainDenyHints`
  soft exclusion hints unless the provider/backend can enforce them
- `queryFamily`
  optional trace label like `specific_fit`, `broad_fit`, or `generic_widening`
- `runContext`
  trace-only context for debugging and evaluation

Output:

```json
{
  "provider": {
    "name": "openai_web_search",
    "requestCount": 1
  },
  "results": [
    {
      "query": "mechanical engineering scholarship incoming freshman",
      "title": "Future Engineers Scholarship",
      "url": "https://example.org/future-engineers-scholarship",
      "normalizedUrl": "https://example.org/future-engineers-scholarship",
      "snippet": "Scholarship for incoming engineering students.",
      "sourceDomain": "example.org",
      "providerRank": 1,
      "queryFamily": "specific_fit",
      "fitScore": 7.25,
      "heuristics": {
        "surfaceType": "direct_likely",
        "majorMatch": true,
        "ethnicityMatch": false,
        "stateMatch": true,
        "stageMatch": true,
        "negativeGraduateSignal": false,
        "negativeBlogSignal": false,
        "negativeDirectorySignal": false,
        "staleCycleSignal": false,
        "indirectContentSignal": false,
        "sameDomainAsPriorHit": false,
        "seenRecently": false,
        "noveltyScore": 0.9
      },
      "traceMeta": {
        "round": 1
      }
    }
  ],
  "skippedQueries": [],
  "notes": []
}
```

Minimum required output fields per result:

- `query`
- `title`
- `url`
- `normalizedUrl`
- `snippet`
- `sourceDomain`
- `providerRank`
- `fitScore`
- `heuristics.surfaceType`
- `heuristics.majorMatch`
- `heuristics.ethnicityMatch`
- `heuristics.stateMatch`
- `heuristics.stageMatch`
- `heuristics.negativeGraduateSignal`
- `heuristics.negativeBlogSignal`
- `heuristics.negativeDirectorySignal`
- `heuristics.institutionSpecificSignal`
- `heuristics.specificSchoolSignal`
- `heuristics.staleCycleSignal`
- `heuristics.indirectContentSignal`
- `heuristics.noveltyScore`

Allowed `surfaceType` values:

- `direct_likely`
- `hub_likely`
- `list_likely`
- `other`

`surfaceType` should be treated as a structural page-shape hint only.
It is not a proxy for scholarship quality, openness, or likely expansion yield.
In particular, `hub_likely` should not automatically outrank `list_likely`; later tools should weigh freshness, specificity, evidence, and likely yield more heavily than this field.

Heuristic meanings:

- `surfaceType`
  weak structural hint about what kind of page this appears to be:
  `direct_likely` for likely single-scholarship pages,
  `hub_likely` for focused organization/program gateways,
  `list_likely` for broader collection or roundup pages,
  `other` when structure is unclear
- `majorMatch`
  title/snippet/domain/path contains strong signals for the student major or a close umbrella field
- `ethnicityMatch`
  title/snippet contains a relevant demographic/background signal
- `stateMatch`
  title/snippet contains the student state or state-restricted wording
- `stageMatch`
  title/snippet aligns with the target stage such as incoming freshman, undergraduate, transfer
- `negativeGraduateSignal`
  result looks graduate-, masters-, PhD-, or fellowship-oriented
- `negativeBlogSignal`
  result looks article-like, advice-like, or content-marketing-heavy
- `negativeDirectorySignal`
  result looks like a broad scholarship directory or low-specificity roundup
- `staleCycleSignal`
  result snippet/title appears to reference an older scholarship cycle or past-year deadline without a current/future cycle signal
- `indirectContentSignal`
  result looks like editorial or explanatory content discussing scholarships rather than being an official scholarship page or strong gateway
- `noveltyScore`
  backend-computed score incorporating recent history and domain saturation

Ranking expectations inside this tool:

- this tool may sort results by provider rank and lightweight backend heuristics
- `surfaceType` may influence ordering only as a weak prior
- this tool does not perform final candidate ranking
- this tool only returns a frontier that the manager will triage further

Backend responsibility:
- Search provider integration
- normalization of titles, URLs, domains
- lightweight heuristic annotation
- run-trace metadata attachment
- history-aware novelty annotation
- provider abstraction

Manager responsibility:
- Decide which query batch to run
- Interpret the returned frontier
- Decide which results deserve fetch budget

### 2. `batch_fetch_page_bundles`

Purpose:
- Fetch a small set of URLs and return normalized page bundles for reasoning and finalization.
- Keep page-inspection output bounded enough for agent use without flooding context.

Required caps:

- `maxUrlsPerBatch`: clamp to `6`
- `maxTextCharsPerPage`: clamp to `4000`
- `maxSnippetChars`: clamp to `400`
- `maxChildLinksPerPage`: clamp to `15`
- `maxChildLinksReturnedTotal`: clamp to `50`
- `maxResponseChars`: target `60000` total response characters in debug mode

Cap philosophy:

- Return the highest-signal material first.
- Never return raw HTML.
- Never return full-page text.
- Never return every extracted child link.
- If truncation happens, expose that fact in metadata rather than silently expanding the payload.

Input:

```json
{
  "urls": [
    "https://example.org/future-engineers-scholarship",
    "https://example.org/engineering-scholarships"
  ],
  "maxTextCharsPerPage": 4000,
  "maxSnippetChars": 400,
  "maxChildLinksPerPage": 15,
  "runContext": {
    "round": 1,
    "depth": 0
  }
}
```

Field notes:

- `urls`
  manager-selected URLs to inspect; backend clamps to `maxUrlsPerBatch`
- `maxTextCharsPerPage`
  caller hint only; backend clamps to `4000`
- `maxSnippetChars`
  caller hint only; backend clamps to `400`
- `maxChildLinksPerPage`
  caller hint only; backend clamps to `15`
- `runContext`
  trace-only metadata for debugging and evaluation

Output:

```json
{
  "pages": [
    {
      "requestedUrl": "https://example.org/future-engineers-scholarship",
      "canonicalUrl": "https://example.org/future-engineers-scholarship",
      "fetchStatus": "ok",
      "httpStatus": 200,
      "contentType": "text/html",
      "sourceDomain": "example.org",
      "title": "Future Engineers Scholarship",
      "textExcerpt": "Applicants must be incoming college freshmen...",
      "evidenceSnippets": {
        "deadlineSnippet": "Applications close on March 1, 2027.",
        "eligibilitySnippet": "Applicants must be incoming college freshmen enrolled in engineering.",
        "amountSnippet": "Award amount: $5,000.",
        "stageRestrictionSnippet": "Open to incoming college freshmen only.",
        "closedSnippet": null
      },
      "blockers": {
        "closedSignal": false,
        "pastCycleSignal": false,
        "explicitStageMismatchSignal": false,
        "accessBlockedSignal": false
      },
      "fitSignals": {
        "majorMatchSignal": true,
        "ethnicityMatchSignal": false,
        "stateMatchSignal": false,
        "stageMatchSignal": true,
        "institutionSpecificSignal": false,
        "specificSchoolSignal": false
      },
      "pageSignals": {
        "directScholarshipSignal": true,
        "hubSignal": false,
        "listSignal": false,
        "deadlineSignal": true,
        "awardAmountSignal": true,
        "eligibilitySignal": true,
        "applicationSignal": true,
        "indirectContentSignal": false
      },
      "childLinks": [
        {
          "url": "https://example.org/other-scholarship",
          "anchorText": "Other Scholarship",
          "sourceDomain": "example.org",
          "sameDomain": true,
          "detailPathLikely": true,
          "seenRecently": false
        }
      ],
      "traceMeta": {
        "round": 1,
        "depth": 0,
        "textCharsReturned": 46,
        "childLinksReturned": 1,
        "truncatedText": false,
        "truncatedChildLinks": false
      }
    }
  ],
  "meta": {
    "requestedUrlCount": 2,
    "returnedPageCount": 2,
    "truncatedPages": false,
    "truncatedChildLinksTotal": false,
    "responseCharBudgetApplied": true
  },
  "notes": []
}
```

Minimum required output fields per page:

- `requestedUrl`
- `canonicalUrl`
- `fetchStatus`
- `httpStatus`
- `contentType`
- `sourceDomain`
- `title`
- `textExcerpt`
- `evidenceSnippets.deadlineSnippet`
- `evidenceSnippets.eligibilitySnippet`
- `evidenceSnippets.amountSnippet`
- `evidenceSnippets.stageRestrictionSnippet`
- `evidenceSnippets.closedSnippet`
- `blockers.closedSignal`
- `blockers.pastCycleSignal`
- `blockers.explicitStageMismatchSignal`
- `blockers.accessBlockedSignal`
- `fitSignals.majorMatchSignal`
- `fitSignals.ethnicityMatchSignal`
- `fitSignals.stateMatchSignal`
- `fitSignals.stageMatchSignal`
- `fitSignals.institutionSpecificSignal`
- `fitSignals.specificSchoolSignal`
- `pageSignals.directScholarshipSignal`
- `pageSignals.hubSignal`
- `pageSignals.listSignal`
- `pageSignals.deadlineSignal`
- `pageSignals.awardAmountSignal`
- `pageSignals.eligibilitySignal`
- `pageSignals.applicationSignal`
- `pageSignals.indirectContentSignal`
- `childLinks`
- `traceMeta.truncatedText`
- `traceMeta.truncatedChildLinks`

Snippet rules:

- `textExcerpt` is a bounded fallback context field, not full page text.
- Each evidence snippet should be omitted or `null` when not found.
- Each evidence snippet should be clipped to `maxSnippetChars`.
- The tool should prefer explicit scholarship evidence over generic surrounding prose.

`childLinks` v1 contract:

- Return only the top bounded child links after filtering obvious junk, nav links, anchors, mailto/tel links, and duplicates.
- Child links may be same-domain or off-domain.
- Include off-domain links when they appear promising, but always mark `sameDomain`.
- Do not include child-link snippets in v1.
- Do not include a child-link score in v1.
- Prefer a compact, inspection-oriented shape.

Minimum required fields per child link:

- `url`
- `anchorText`
- `sourceDomain`
- `sameDomain`
- `detailPathLikely`
- `seenRecently`

Child-link field meanings:

- `url`
  normalized absolute URL for the extracted child link
- `anchorText`
  cleaned visible anchor text, truncated if needed
- `sourceDomain`
  normalized domain of the child link target
- `sameDomain`
  whether the child link target stays on the same domain as the fetched page
- `detailPathLikely`
  whether the child link path/text looks like it may lead to a scholarship detail page rather than generic navigation
- `seenRecently`
  whether the child link target appears in recent URL history or earlier in the current run

Signal priority tiers:

- `blockers`
  Highest-priority signals.
  These are the strongest reasons to avoid spending more budget on a page, such as explicit closure, stale cycles, explicit stage mismatch, or inaccessible content.
- `pageSignals`
  Structural and value-oriented signals about what is on the page.
  These help later tools decide whether the page appears direct, indirect, list-like, rich in scholarship evidence, or likely to yield useful children.
- `fitSignals`
  Student-specific relevance signals derived from the actual fetched page text.
  These matter a lot, but should still be interpreted after hard blockers.

Grouped signal meanings:

- `blockers.closedSignal`
  page explicitly says closed, expired, or not accepting applications
- `blockers.pastCycleSignal`
  page references an older scholarship cycle or stale year in a way that likely invalidates the opportunity
- `blockers.explicitStageMismatchSignal`
  page explicitly indicates the scholarship is for the wrong student stage, such as junior-only, third/fourth-year only, or graduate-only, without also clearly including an allowed stage for the student
- `blockers.accessBlockedSignal`
  page is unusable due to fetch failure, login wall, access restriction, or extremely thin unavailable content
- `fitSignals.majorMatchSignal`
  fetched page text explicitly aligns with the student major or a close umbrella field
- `fitSignals.ethnicityMatchSignal`
  fetched page text explicitly aligns with the student ethnicity/background
- `fitSignals.stateMatchSignal`
  fetched page text explicitly aligns with the student state or a state-specific restriction
- `fitSignals.stageMatchSignal`
  fetched page text explicitly aligns with the student stage
- `fitSignals.institutionSpecificSignal`
  page appears narrowly tied to a particular school, department, or institution
- `fitSignals.specificSchoolSignal`
  page appears tied to attendance, admission, or enrollment at a specific school or campus; this should lower priority for broad discovery but not automatically exclude the page
- `pageSignals.directScholarshipSignal`
  page appears to describe one scholarship or a tightly bounded application target
- `pageSignals.hubSignal`
  page appears to be a focused organization/program gateway into scholarships
- `pageSignals.listSignal`
  page appears to be a broader collection or roundup page
- `pageSignals.deadlineSignal`
  page contains deadline-like language
- `pageSignals.awardAmountSignal`
  page contains amount/funding language
- `pageSignals.eligibilitySignal`
  page contains explicit requirements/eligibility language
- `pageSignals.applicationSignal`
  page contains explicit apply/application/common-app language
- `pageSignals.indirectContentSignal`
  page appears to discuss scholarships or point elsewhere rather than host the opportunity directly

Signals deferred beyond v1:

- `fitSignals.gpaConstraintSignal`
- `pageSignals.editorialSignal`
- `pageSignals.thinContentSignal`
- `pageSignals.navigationHeavySignal`
- `pageSignals.childLinkDensitySignal`
- `pageSignals.sameDomainChildLinkDensitySignal`

Backend responsibility:
- fetch/retry/timeout/content-type handling
- HTML cleanup and text extraction
- child link extraction
- heuristic feature extraction
- output-size enforcement and truncation metadata

Manager responsibility:
- Decide which URLs deserve fetch budget
- Reason over the returned page bundles

### 3. `select_fetch_batch`

Purpose:
- Select the next small batch of search results to fetch from the remaining unfetched frontier.
- Prevent the run from overcommitting to one weak first batch.
- Support iterative fetch rounds until enough promising scholarship candidates are found or budget is exhausted.

Non-goals:

- It does not inspect full page content.
- It does not finalize, expand, or drop fetched pages.
- It does not decide final scholarship acceptance.

Input:

```json
{
  "profile": {
    "personalInfo": {
      "intendedMajor": "Mechanical Engineering",
      "ethnicity": "Hispanic/Latino",
      "state": "CA"
    },
    "academics": {
      "gradeLevel": "12th grade",
      "gpa": 3.8
    }
  },
  "searchResults": [
    {
      "url": "https://example.org/future-engineers-scholarship",
      "title": "Future Engineers Scholarship",
      "sourceDomain": "example.org",
      "fitScore": 7.25,
      "heuristics": {
        "surfaceType": "direct_likely",
        "majorMatch": true,
        "ethnicityMatch": false,
        "stateMatch": true,
        "stageMatch": true,
        "negativeGraduateSignal": false,
        "negativeBlogSignal": false,
        "negativeDirectorySignal": false,
        "staleCycleSignal": false,
        "indirectContentSignal": false,
        "sameDomainAsPriorHit": false,
        "seenRecently": false,
        "noveltyScore": 0.9
      }
    }
  ],
  "alreadyFetchedUrls": [
    "https://example.org/already-fetched"
  ],
  "remainingBudget": {
    "pages": 20,
    "fetchesThisRound": 6,
    "depth": 2
  },
  "runState": {
    "acceptedCount": 1,
    "targetAcceptedCount": 5,
    "round": 1
  }
}
```

Output:

```json
{
  "selectedUrls": [
    "https://example.org/future-engineers-scholarship"
  ],
  "rationale": "Selected the highest-signal unfetched results while preserving domain diversity and avoiding stale or indirect pages.",
  "notes": []
}
```

Selection guidance:

- Choose a small batch, not the whole frontier.
- Prefer results with strong fit and fewer negative signals.
- Preserve some domain diversity when several results look similar.
- Avoid spending the full fetch batch on pages that are obviously stale, indirect, or likely duplicates.
- Keep enough remaining frontier for later rounds if the first batch underperforms.
- The run should continue fetching in rounds until either:
  - enough acceptable scholarship candidates are found
  - the frontier is exhausted
  - or the budget is spent

Required output fields:

- `selectedUrls`
- `rationale`
- `notes`

Backend responsibility:
- validate that selected URLs come from the current unfetched frontier
- enforce per-round and total fetch caps
- prevent re-fetching already fetched URLs unless explicitly allowed by policy

Manager responsibility:
- choose the next best fetch batch from the available frontier
- avoid brittle overcommitment to one domain or one result type

### 4. `triage_frontier`

Purpose:
- Use bounded manager judgment to turn fetched page bundles into actionable next-step decisions.
- Interpret fetched-page evidence after a single fetch round.
- Decide which items should move toward finalization, which should be kept for later expansion, and which should be dropped.

Non-goals:

- It does not fetch pages itself.
- It does not finalize scholarship records.
- It does not make the final eligibility or ranking decision.
- It should not over-trust any one signal such as `specificSchoolSignal` or `explicitStageMismatchSignal` in isolation.

Input:

```json
{
  "pageBundles": [
    {
      "requestedUrl": "https://example.org/future-engineers-scholarship",
      "canonicalUrl": "https://example.org/future-engineers-scholarship",
      "title": "Future Engineers Scholarship",
      "sourceDomain": "example.org",
      "evidenceSnippets": {
        "deadlineSnippet": "Applications due March 1, 2027.",
        "eligibilitySnippet": "Open to incoming engineering freshmen.",
        "amountSnippet": "$2,500 scholarship award.",
        "stageRestrictionSnippet": "Incoming first-year students only.",
        "closedSnippet": null
      },
      "blockers": {
        "closedSignal": false,
        "pastCycleSignal": false,
        "explicitStageMismatchSignal": false,
        "accessBlockedSignal": false
      },
      "fitSignals": {
        "majorMatchSignal": true,
        "ethnicityMatchSignal": false,
        "stateMatchSignal": true,
        "stageMatchSignal": true,
        "institutionSpecificSignal": false,
        "specificSchoolSignal": false
      },
      "pageSignals": {
        "directScholarshipSignal": true,
        "hubSignal": false,
        "listSignal": false,
        "deadlineSignal": true,
        "awardAmountSignal": true,
        "eligibilitySignal": true,
        "applicationSignal": true,
        "indirectContentSignal": false
      }
    }
  ],
  "remainingBudget": {
    "pages": 20,
    "depth": 2
  }
}
```

Output:

```json
{
  "decisions": [
    {
      "url": "https://example.org/future-engineers-scholarship",
      "action": "advance_to_finalize",
      "rationale": "Fetched page looks like a direct scholarship page with clear eligibility and award evidence and no hard blockers."
    },
    {
      "url": "https://example.org/engineering-scholarships",
      "action": "hold_for_expansion",
      "rationale": "Fetched page looks like a promising gateway with scholarship-oriented child links, but not a single direct scholarship."
    },
    {
      "url": "https://example.org/old-roundup",
      "action": "drop",
      "rationale": "Fetched page looks stale or indirect and is not worth more attention in this run."
    }
  ],
  "queue": {
    "advanceToFinalize": [
      "https://example.org/future-engineers-scholarship"
    ],
    "holdForExpansion": [
      "https://example.org/engineering-scholarships"
    ],
    "dropped": []
  },
  "notes": []
}
```

Allowed `action` values:

- `advance_to_finalize`
  fetched page looks strong enough to send to deterministic candidate finalization now
- `hold_for_expansion`
  page is not finalizable yet, but is promising enough to keep for later hub/list expansion
- `drop`
  page/result is stale, blocked, clearly mismatched, or otherwise low-value enough to discard for this run

Required output fields per decision:

- `url`
- `action`
- `rationale`

Priority / decision guidance:

- Prefer `advance_to_finalize` when a fetched page has:
  - `pageSignals.directScholarshipSignal = true`
  - multiple strong evidence signals such as deadline, amount, eligibility, or application text
  - no hard blockers
- Prefer `hold_for_expansion` when a fetched page has:
  - `pageSignals.hubSignal = true` or `pageSignals.listSignal = true`
  - useful child links
  - no hard blockers
  - enough remaining page/depth budget to justify later expansion
- Use `drop` when:
  - `blockers.closedSignal = true`
  - `blockers.pastCycleSignal = true` with no stronger contradictory evidence
  - `blockers.accessBlockedSignal = true`
  - `blockers.explicitStageMismatchSignal = true` and the page is not otherwise ambiguous

Manager reasoning principles:

- Treat `specificSchoolSignal` as a caution hint, not an auto-drop.
- Prefer explicit blocker and evidence-snippet signals over generic structural heuristics.
- Prefer `hold_for_expansion` over `drop` when a page looks genuinely expandable and remaining page/depth budget still makes expansion realistic.

Backend responsibility:
- validate the output schema
- enforce that decisions only reference known fetched page bundles from the current round/frontier state

Manager responsibility:
- decide how the current fetched batch should be spent
- convert fetched evidence into next-step actions
- provide short, reviewable rationales that make the decision understandable in the trace

Agentic implementation plan:

- Keep the `triage_frontier` tool contract the same.
- Replace the current deterministic routing engine with a bounded `codex exec` step.
- Keep deterministic validation and fallback in the backend.
- Continue treating `batch_fetch_page_bundles` as the source of truth for hard facts such as:
  - closed/expired status
  - parsed deadlines
  - explicit stage mismatch
  - evidence snippets
- Let the model decide only the routing action and short rationale.

Suggested default model:

- `gpt-5.3-codex-spark`
- configurable via `TRIAGE_FRONTIER_AI_MODEL`

Suggested runtime shape:

- compact the fetched page bundles before sending them to the model
- include only:
  - `pageId`
  - `canonicalUrl`
  - `title`
  - `sourceDomain`
  - `blockers`
  - `fitSignals`
  - `pageSignals`
  - `evidenceSnippets`
  - top `childLinks`
  - `remainingBudget`
- enforce one decision per input page
- derive grouped queues in backend code after validation instead of trusting model-produced queues
- if the model times out or returns invalid output, fall back to deterministic `triageFrontier`

Suggested model prompt:

```text
You are triaging fetched scholarship pages inside a scholarship search system.
Return JSON only matching the provided schema.

Your job:
- For each fetched page, choose exactly one action:
  - advance_to_finalize
  - hold_for_expansion
  - drop
- Use the provided pageId exactly as written when returning each decision.
- Provide one short rationale grounded only in the provided evidence.

Important rules:
- Use only the supplied page bundle data. Do not invent facts.
- Treat blocker signals as strong evidence.
- Treat closed or expired pages as drop unless the supplied data clearly contradicts that blocker.
- Treat explicit student-stage mismatch as strong evidence against continuing.
- Treat specificSchoolSignal as a caution signal, not an automatic drop.
- Prefer hold_for_expansion when a page is not a final scholarship itself but has clearly useful scholarship-oriented child links and remaining budget makes expansion realistic.
- Prefer advance_to_finalize only when the page looks like a real scholarship page with enough concrete evidence to justify deterministic finalization now.
- Every input page must receive exactly one decision.
- Keep rationales concise and specific.
```

Suggested JSON schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "decisions": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "pageId": { "type": "string" },
          "action": {
            "type": "string",
            "enum": ["advance_to_finalize", "hold_for_expansion", "drop"]
          },
          "rationale": { "type": "string" }
        },
        "required": ["pageId", "action", "rationale"]
      }
    }
  },
  "required": ["decisions"]
}
```

Backend validation rules:

- every `pageId` must match an input page bundle
- every input page bundle must have exactly one decision
- only the 3 allowed actions are accepted
- rationale must be non-empty and short enough for trace readability
- backend maps validated `pageId` values back to canonical URLs after validation
- grouped `queue` fields are derived after validation:
  - `advanceToFinalize`
  - `holdForExpansion`
  - `dropped`

### 4. `decide_hub_expansion`

Purpose:
- Use bounded manager judgment to decide whether a fetched `hold_for_expansion` page should actually be expanded now.
- If expansion is warranted, choose the best child links to fetch next.
- This is the step that turns extracted `childLinks` into real next-round fetch candidates.

Role in the loop:

1. `triage_frontier` marks a fetched page as `hold_for_expansion`.
2. `decide_hub_expansion` inspects that one held page plus its extracted child links.
3. The tool either:
   - declines expansion for that page, or
   - selects a bounded child-link subset to fetch next

Non-goals:

- It does not fetch the child pages itself.
- It does not finalize scholarships.
- It does not decide whether the overall search run should stop.
- It does not act on raw search results; it only acts on already-fetched hub/list pages.

Recommended implementation shape:

- Agentic judgment with deterministic validation and fallback
- Same pattern as `triage_frontier`
- Use stable internal child IDs in the agent prompt/schema to avoid URL-copy mismatch
- Return URL-based output after backend validation

Input:

```json
{
  "hubPageBundle": {
    "url": "https://example.org/engineering-scholarships",
    "title": "Engineering Scholarships for Incoming Freshmen",
    "blockers": {
      "closedSignal": false,
      "pastCycleSignal": false,
      "explicitStageMismatchSignal": false,
      "accessBlockedSignal": false
    },
    "fitSignals": {
      "majorMatchSignal": true,
      "ethnicityMatchSignal": false,
      "stateMatchSignal": true,
      "stageMatchSignal": true,
      "institutionSpecificSignal": false,
      "specificSchoolSignal": false
    },
    "pageSignals": {
      "directScholarshipSignal": false,
      "hubSignal": true,
      "listSignal": true,
      "deadlineSignal": false,
      "awardAmountSignal": true,
      "eligibilitySignal": true,
      "applicationSignal": true,
      "indirectContentSignal": false
    },
    "evidenceSnippets": {
      "eligibilitySnippet": "Incoming engineering students may apply...",
      "amountSnippet": "$2,500 scholarships available..."
    },
    "childLinks": [
      {
        "childId": "child_1",
        "url": "https://example.org/future-engineers-scholarship",
        "anchorText": "Future Engineers Scholarship",
        "sourceDomain": "example.org",
        "sameDomain": true,
        "detailPathLikely": true,
        "seenRecently": false
      }
    ]
  },
  "remainingBudget": {
    "pages": 12,
    "depth": 1
  },
  "maxChildrenToSelect": 4
}
```

Field notes:

- `hubPageBundle`
  one fetched page bundle previously marked `hold_for_expansion`
- `childLinks`
  the bounded child-link set extracted from `batch_fetch_page_bundles`
- `remainingBudget`
  only the budget needed to judge whether expansion is realistic
- `maxChildrenToSelect`
  backend-enforced cap; manager hint only

Output:

```json
{
  "expand": true,
  "selectedChildren": [
    {
      "url": "https://example.org/future-engineers-scholarship",
      "reason": "Looks like a likely scholarship-detail child and fits the current fetch budget."
    }
  ],
  "rejectedChildren": [
    {
      "url": "https://example.org/donate",
      "reason": "Looks navigational or unrelated to scholarship detail."
    }
  ],
  "selectedChildUrls": [
    "https://example.org/future-engineers-scholarship"
  ],
  "rationale": "Hub looks worth expanding and contains promising scholarship-detail child links.",
  "notes": []
}
```

Output rules:

- `expand: false` must return an empty `selectedChildUrls` array and empty `selectedChildren` array
- `selectedChildUrls` must be a subset of input `childLinks`
- `rejectedChildren` must be a subset of input `childLinks` that were considered but not selected
- no duplicates
- backend clamps the selection count to `maxChildrenToSelect` and remaining page budget
- `selectedChildUrls` is the orchestration-friendly field; `selectedChildren` and `rejectedChildren` are debug-friendly fields for early iteration and can be removed or slimmed down later
- `rejectedChildren` should be limited to the top few most relevant rejected links for debugging rather than every rejected child link

Recommended action heuristics:

- Prefer `expand: false` when:
  - the held page has a hard blocker
  - child links look weak, generic, navigational, or already seen
  - remaining page/depth budget makes expansion unrealistic

- Prefer `expand: true` when:
  - the held page still looks promising as a gateway
  - there are multiple scholarship-oriented child links
  - at least some child links look like likely detail pages
  - budget supports another bounded fetch round

- Treat `specificSchoolSignal` as a caution signal, not an automatic block
- Prefer a small, high-signal subset over expanding every child link
- Do not select obvious nav/junk children such as donation links, unrelated programs, or generic application portals unless the evidence strongly suggests they are the only path to scholarship detail

Backend responsibility:
- enforce depth/page budgets no matter what the manager asks
- validate that selected child links came from the provided `childLinks`
- normalize output URLs
- fall back deterministically if agent output fails validation

Manager responsibility:
- choose whether expansion is worth it
- choose the best subset of child links

### 5. `assess_search_progress`

Purpose:
- Decide what the overall search loop should do next after one fetch/triage/expansion cycle.
- This is the place where run-level sufficiency, widening, and stopping decisions live.
- It should answer:
  - do we already have enough acceptable scholarships to stop?
  - should we keep going with the current strategy?
  - should the next round favor held hubs or remaining search frontier?
  - should we widen/replan because current results are too narrow, too school-specific, or too weak?

Role in the loop:

1. Search + fetch + triage + hub-expansion produce the current round state.
2. `assess_search_progress` looks at run-level summary, remaining frontier, held hubs, and budgets.
3. It returns the next run-level action:
   - continue with current strategy
   - replan / widen
   - stop

Recommended implementation shape:

- Agentic judgment with deterministic validation and fallback
- This should be the main place where the target of at least 5 acceptable scholarships is considered
- Keep the output small and orchestration-oriented
- Same pattern as `triage_frontier` and `decide_hub_expansion`
- Backend must still enforce hard stop conditions when budgets are exhausted even if the agent suggests continuing

Input:

```json
{
  "runSummary": {
    "round": 2,
    "queriesUsed": 4,
    "pagesFetched": 15,
    "acceptedCandidates": 2,
    "strongEvidenceCandidates": 2,
    "targetAcceptedCandidates": 5
  },
  "currentRound": {
    "fetchedPages": 6,
    "advancedToFinalize": 1,
    "heldForExpansion": 2,
    "dropped": 3
  },
  "frontierState": {
    "remainingUnfetchedSearchResults": 8,
    "heldHubsReadyForExpansion": 2,
    "selectedExpansionChildrenAvailable": 5,
    "schoolSpecificPressure": 0.6,
    "broadOpportunityPressure": 0.3
  },
  "remainingBudget": {
    "searchRounds": 1,
    "queries": 2,
    "pages": 10,
    "depth": 1,
    "replans": 1
  }
}
```

Field notes:

- `runSummary.acceptedCandidates`
  count of acceptable candidates currently found
- `runSummary.strongEvidenceCandidates`
  count of acceptable candidates with especially strong evidence
- `runSummary.targetAcceptedCandidates`
  early-run target; default is 5 unless overridden
- `currentRound`
  summary of what the just-finished round produced
- `frontierState.remainingUnfetchedSearchResults`
  search results still available to fetch
- `frontierState.heldHubsReadyForExpansion`
  pages held by `triage_frontier` that can still be expanded
- `frontierState.selectedExpansionChildrenAvailable`
  concrete child URLs already chosen by `decide_hub_expansion` and ready to fetch
- `frontierState.schoolSpecificPressure`
  rough ratio or score showing how dominated the remaining opportunity set is by institution-locked pages
- `frontierState.broadOpportunityPressure`
  rough ratio or score showing how much broader, non-school-specific opportunity remains

Output:

```json
{
  "action": "replan",
  "nextStep": "widen_queries",
  "rationale": "Current accepted count is below target and the remaining opportunity set is too school-specific to keep repeating the same search pattern.",
  "suggestedDirections": [
    "broaden to no-essay undergraduate scholarships",
    "try state-specific freshman STEM organizations"
  ]
}
```

Allowed actions:

- `continue`
- `replan`
- `stop`

Allowed `nextStep` values:

- `fetch_remaining_frontier`
- `expand_held_hubs`
- `widen_queries`
- `stop_now`

Output rules:

- `action: "stop"` should use `nextStep: "stop_now"`
- `action: "continue"` should use one of:
  - `fetch_remaining_frontier`
  - `expand_held_hubs`
- `action: "replan"` should use `nextStep: "widen_queries"`
- `suggestedDirections` should usually be empty unless `action` is `replan`

Recommended action heuristics:

- Prefer `stop` when:
  - accepted candidates have reached or exceeded the target and quality is acceptable
  - or all meaningful budgets are exhausted
  - or the remaining opportunity set is too weak to justify more rounds

- Prefer `continue` with `expand_held_hubs` when:
  - there are concrete selected child links ready to fetch
  - held hubs look stronger than remaining unfetched search results
  - remaining page/depth budget still supports bounded expansion

- Prefer `continue` with `fetch_remaining_frontier` when:
  - there are still decent unfetched search results
  - and hub expansion is weak, exhausted, or too school-specific

- Prefer `replan` when:
  - accepted count remains below target
  - current strategy is producing mostly weak, stale, closed, or school-specific results
  - and there is still query/replan budget to widen the search

- Treat the target of at least 5 acceptable scholarships as a strong early-run goal, not an absolute guarantee
- Avoid repeating the same narrow pattern when the remaining opportunity set is dominated by institution-specific pages
- Use `schoolSpecificPressure` as a caution signal that may justify widening toward broader opportunities

Backend responsibility:
- enforce final hard stop when budgets are exhausted
- validate the output action / nextStep combination
- fall back deterministically if agent output fails validation

Manager responsibility:
- use evidence from the run to make bounded loop decisions

## Backend Finalizers

These are not optional manager behavior. They run as deterministic backend gates.

### `finalize_candidate_from_page`

Purpose:
- Produce the official candidate record from a fetched page bundle.
- This is the main end-stage extraction step.
- It should also include the authoritative profile-vs-candidate eligibility assessment rather than requiring a separate standalone eligibility tool in v1.

Output responsibilities:

- normalized candidate shape compatible with the existing queue
- extracted name
- source URL and domain
- deadline
- award amount
- inferred and checked eligibility
- evidence snippets by field
- extraction completeness / confidence
- explicit eligibility status
- eligibility reason list
- reject reason if invalid

Why this stays separate:

- upstream tools only make routing judgments
- this step is where the product-authoritative candidate record is created
- this is the right place to make the final eligibility call for the student against the extracted scholarship record

### `postprocess_final_candidates`

Purpose:
- Apply deterministic post-processing to the set of finalized candidates before returning the final queue.
- This is a backend stage, not a manager-facing reasoning tool.

Responsibilities:

- dedupe:
  - duplicates within the run
  - already reviewed queue items
  - candidates matching the canonical scholarship catalog
- final deterministic ranking after discovery is done
- final acceptance filtering if needed

Initial ranking order:

1. explicit eligibility status
2. evidence completeness
3. profile fit
4. valid / sooner deadline
5. award amount
6. lower estimated effort

## Heuristic Features

The manager should reason over backend-computed signals instead of raw HTML whenever possible.

### Search-result heuristics

- likely page surface:
  - `direct_likely`
  - `hub_likely`
  - `list_likely`
  - `other`
- profile-match flags:
  - major
  - ethnicity/background
  - state
  - stage
- negative signals:
  - graduate-only
  - blog/article
  - broad directory
- novelty/history:
  - recently seen
  - domain saturation
  - recent yield quality

### Page heuristics

- direct scholarship signals
- hub/list signals
- closed/expired signals
- field-presence signals:
  - deadline
  - award amount
  - requirement statements
  - essay prompt
- extraction completeness

### Hub expansion heuristics

- profile specificity
- promising child-link count
- direct-path likelihood of child URLs
- duplicate/seen status
- domain yield quality

## Debug Endpoint

Recommended first integration surface:

- `POST /admin/search-manager/debug`

Purpose:
- iterate on the search manager outside of the UI
- inspect the full search trace before replacing the old discovery flow

Response should include:

- merged profile used for the run
- budget settings
- all query rounds
- returned search results
- manager triage decisions
- fetched page bundles
- hub expansion decisions
- finalization attempts
- reject/skip reasons
- accepted candidates
- evidence bundles
- stop reason

## Replacement Plan

Phase 1:
- build and iterate on the debug endpoint
- implement tools one at a time
- review, build, and evaluate each tool before moving to the next

Phase 2:
- once the full toolset is satisfactory, implement the manager loop on top of the finished tools

Phase 3:
- compare the new manager-driven system against the current discovery system on the same inputs

Phase 4:
- once behavior is satisfactory, replace the internals of the existing discovery endpoint with the new search-manager core

Phase 5:
- remove or retire the old deterministic discovery implementation after the new flow is stable

## Current Open Questions

- Exact JSON wire shapes for each tool
- Whether `scholarship_web_search` supports provider-specific filters in v1 or only generic hints
- Whether candidate evidence should store one snippet per field or a list of snippets per field
- Exact ranking weights after we start testing against real runs
