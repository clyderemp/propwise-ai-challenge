# NOTES

## What I built

The AI lead assistant described in TASK.md: the API agent, the web panel, the mobile card and an eval suite.

- **API** (`api/src/assistant/`):
  - `POST /leads/:leadId/assistant/runs`, `GET .../runs/:runId`, and `approve` / `reject` on `.../actions/:actionId`, exactly as the contract specifies.
  - Extra endpoint: `GET /leads/:leadId/assistant/runs?limit=N` (1-50, newest first). The panels use it to show the latest run after a reload.
  - Extra fields: `requirements.bedroomsRange`, `budgetIsApproximate`, `prioritiseYield`, plus `dataWarnings`, `diagnostics` (dropped picks with the reason, the budget band applied, `searchSkipped`, token usage) and `model`.
- **Web**: the "AI assistant" panel on the lead page. It starts an analysis and shows the requirements, the ranked recommendations with the listing facts, the summary, the trace and the proposed follow-up with Approve/Reject. An approved task appears in the Tasks list.
- **Mobile**: the "AI assistant" card. It loads the latest run, can start a new one, and has Approve/Reject (the bonus).
- **Evals**: `api/evals/`, 16 cases on the real model (16 checks the self-verification record and every shipped reason against the database). Plain assertions gate the verdict; a model-graded score of reason quality is reported but does not gate.

## Main decisions

1. **Two phases, so third-party text cannot change what the assistant does.**
   - Phase A has no tools. It reads the lead's message (and earlier messages, to resolve "same area") and returns structured requirements and follow-up timing. Those requirements are then frozen.
   - Phase B gets the frozen requirements and three read-only tools that are scoped to the agency: `search_listings` (with an exact `reference` lookup), `get_listing_details` and `get_lead_tasks`. It returns a shortlist, a summary and a task draft.
   - Phase B never sees the raw message body. Listing descriptions only reach it inside tool results that are labelled as untrusted data, and instruction-like text in them is flagged.
2. **Invariants are enforced in code, not left to the prompt.**
   - The model only proposes property ids. The server re-reads every proposed row from Postgres, scoped to the agency.
   - It drops any listing that is from another agency, not `available`, never returned by a tool in this run, invented, a duplicate, not a fit (area, bedrooms, type, budget band) or has a suspect price.
   - It ranks by gross yield (`annualRentAed / priceAed`) when the lead cares about yield, and caps the list at 5.
   - Every dropped pick, with its reason, is stored in `diagnostics`. When picks are dropped, a note is appended to the summary.
3. **Dates are computed in code.**
   - The model only classifies the timing: tomorrow / relative days, a weekday, "after the weekend", an absolute date, unclear or none.
   - `domain/follow-up-date.ts` turns that into a date with `Intl`, from the message's `sentAt` in the logged-in agent's timezone. The server's own timezone plays no part, and the tests pass under both `TZ=UTC` and `TZ=America/Los_Angeles`.
   - Times default to 10:00 local. "After the weekend" means the first Monday strictly after the sent date (the UAE weekend is Saturday and Sunday).
   - Unclear timing gives `dueAt: null` plus `needsClarification`.
4. **Approval is a compare-and-set.** Approve runs `UPDATE ... WHERE status = 'pending_approval'` and the task insert in one transaction. A second approve returns the same task. Approving a rejected action, or rejecting an approved one, gives 409. A run itself writes only its own run row and action rows.
4a. **Self-verification of reasons.** After Phase B, code checks every candidate: the recommendation validation plus `domain/claim-check.ts`, which reads AED amounts (2.05M, 2,050,000, AED 2m), yield percentages (0.15 pp tolerance against the computed gross yield), bedroom counts, area and building names, status words and other listing codes in each reason and compares them with the listing row. If anything is off, the model gets exactly one revision turn in the same conversation, with the issues as data, the same read-only tools, no retries and inside the run deadline. Any reason still wrong is replaced by a code-built factual reason, so a wrong figure is never shipped. The record is in `diagnostics.selfVerification` (`checkedRecommendations`, `issuesFound`, `revised`, `rounds`, `fallbackReasons`, and `revisionError` when the turn produced nothing usable); the trace stays tool calls only.
5. **Failures say they failed.**
   - Any model error, tool error, schema-invalid output or timeout (110 s deadline, under the 2-minute limit) gives `201` with `status: "failed"`, an `error` and the exact empty shape.
   - The trace keeps the failed call with its `error`.
   - Runs orphaned by a restart are failed at startup, and also when they are read once they are past their deadline.
6. **Vercel AI SDK on `claude-sonnet-5-5`** (`ai` + `@ai-sdk/anthropic`), wrapped in an `LlmGateway` seam. The model comes from `ASSISTANT_MODEL` and is stored on every run. No sampling parameters and no forced tool choice are sent: current Claude models reject them. Tests swap in a scripted model; `ASSISTANT_AGENT_IMPL=fake` runs the API without any model.
7. **Interpretations I would defend:**
   - "Around 2M" applies a band of 0.90x to 1.05x (1.8M to 2.1M), while the reported `budgetAed` stays `{min: null, max: 2000000}`. So MBR-1007 (1.65M) is out and MBR-1022 (2.099M) is in.
   - An explicit "under X" is a hard ceiling.
   - A rent enquiry gets no recommendations, because every listing is for sale.
   - When nothing could be extracted ("Hi"), the listing search is skipped in code (`diagnostics.searchSkipped`).
   - A listing code in the message ("Is MBR-1009 available?") is looked up by reference. If the same message also states criteria, the listing must still fit them.
   - The earlier-listed copy of a duplicate is kept (MBR-1001 over MBR-1024).
   - A listing with unknown rent stays eligible, but is ranked after listings with a known yield.
8. **Existing bug fixed:** `GET /properties?q=` used `orWhere`, which leaked other agencies' listings. It is now scoped (commit `f22f568`, test first).

## How I used AI tools

- **Planning.** The plan was written in Claude Code (Opus 5.5) from TASK.md and a read of the seed: every trap listing and lead was mapped to an expected outcome. It was reviewed independently by Codex (gpt-5.6-sol), and the disagreements were settled in writing ("final rulings").
- **Building.** Claude Code ran a workflow script with parallel lanes on separate paths in one tree: API contract, agent, web, and mobile (the mobile lane was Codex gpt-5.6-sol). Each lane worked test-first, committed only its own paths and wrote a progress log. An integration lane then wired the real agent in and built the evals.
- **Review.** Codex and Fable reviewed the integrated branch independently. Each important finding was fixed test-first, meaning a failing test came before the fix:
  - a named listing code bypassed the fit checks;
  - the message body reached Phase B;
  - eval subset checks passed on empty lists;
  - young orphaned runs stayed `running`;
  - NOTES.md was missing.
- **Checking.** No claim was accepted without a command run: `pnpm check` under two timezones, two fresh-database eval runs, and a live curl of the contract against `TZ=UTC pnpm dev:api`.

## How to run the evals

```bash
pnpm db:up && pnpm db:reset
pnpm -C api eval            # about 70 s wall time at concurrency 3, under $0.70 on claude-sonnet-5-5
```

- The suite boots the API in-process against `DATABASE_URL` and drives the HTTP contract with the real model.
- Output: a pass/fail table on stdout, `api/evals/reports/latest.md` and one trace per case in `api/evals/traces/`.
- Options: `EVAL_CASES=01,12` runs only those cases, `EVAL_CONCURRENCY` (default 3), `EVAL_GRADER=0` skips the model-graded check, `ASSISTANT_MODEL=...` picks the model.
- The suite writes runs and tasks to the database, so run `pnpm db:reset` afterwards.
- Last result: 15/15 on two consecutive fresh resets.
- Unit and contract tests: `pnpm check`. It runs the API typecheck, unit tests and e2e tests (scripted model, real Postgres), plus the web and mobile tests.

## What is missing or weak

- **Stretch items: none done.** Runs are synchronous only, and `?async=true` is not supported. Because runs are synchronous, a second run started on the same lead runs independently. The panels show the newest run. No model comparison was made: `ASSISTANT_MODEL=claude-opus-5-5 pnpm -C api eval` would produce one, and the report already prices Opus.
- Recommendation reasons are taken as the model wrote them. They are not cross-checked against the re-read listing. When picks are dropped, the model's summary is kept with a removal note appended, so it can still describe a dropped listing as a good option.
- Mobile ignores `bedroomsRange` and `budgetIsApproximate`, so "studio or 1-bed" shows as "Any" and "around 2M" as "Up to". The web panel uses both fields.
- Free-text injection defence in listing descriptions relies on a regex flag plus the data framing. The injection eval checks the outcome (MBR-1019 is never pushed), not that the model ignored the text for the right reason.
- Nothing in code requires that a listing search actually succeeded before a run completes with no recommendations. A failed search fails the run, but a model that never calls search could return an empty list.
- "Today" resolves to 10:00 on the sent day even when the message arrived later than 10:00, and single-digit hours ("call at 9") are discarded.
- A single schema-invalid tool call from the model fails the whole run, rather than letting the model correct it.
- Phase B decides some judgement calls on the requirements alone. For example, James found the Marina Gate 2 unit "a bit small", and MBR-1009 is that 1BR. Some runs recommend it, and others recommend nothing and say why. The eval accepts either, as long as an empty list is explained.
- An orphaned run (after a restart) shows as `running` for up to the deadline plus 15 s before a read fails it.
- The eval suite leaves the dev database dirty. Run `pnpm db:reset` before handing the API to the test cases.
