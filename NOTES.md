# NOTES

## What I built

The AI lead assistant described in TASK.md: the API agent, the web panel, the mobile card and an eval suite.

- **API** (`api/src/assistant/`):
  - `POST /leads/:leadId/assistant/runs`, `GET .../runs/:runId`, and `approve` / `reject` on `.../actions/:actionId`, exactly as the contract specifies.
  - Extra endpoint: `GET /leads/:leadId/assistant/runs?limit=N` (1-50, newest first). The panels use it to show the latest run after a reload.
  - Extra fields: `requirements.bedroomsRange`, `budgetIsApproximate`, `prioritiseYield`, plus `dataWarnings`, `diagnostics` (dropped picks with the reason, the budget band applied, `searchSkipped`, token usage) and `model`.
- **Background runs** (stretch 1): `POST .../runs?async=true` answers `202` with the run in `status: "running"`, and `GET` shows each tool call as it happens. Details under "Stretch items".
- **Web**: the "AI assistant" panel on the lead page. It starts an analysis in the background, shows each tool step live while it runs, then the requirements, the ranked recommendations with the listing facts, the summary, the trace and the proposed follow-up with Approve/Reject. An approved task appears in the Tasks list.
- **Mobile**: the "AI assistant" card. It loads the latest run, can start a new one (synchronously), polls a run that is still running, and has Approve/Reject (the bonus).
- **Evals**: `api/evals/`, 16 cases on the real model (16 checks the self-verification record and every shipped reason against the database). Plain assertions gate the verdict; a model-graded score of reason quality is reported but does not gate.
- **Model comparison** (stretch 2): `api/evals/model-comparison.md`, Sonnet, Opus and Haiku 5.5 on the eval suite. Sonnet ships.

## Main decisions

1. **Two phases, so third-party text cannot change what the assistant does.**
   - Phase A has no tools. It reads the lead's message (and earlier messages, to resolve "same area") and returns structured requirements and follow-up timing. Those requirements are then frozen.
   - Phase B gets the frozen requirements and three read-only tools that are scoped to the agency: `search_listings` (with an exact `reference` lookup), `get_listing_details` and `get_lead_tasks`. It returns a shortlist, a summary and a task draft.
   - Phase B never sees the raw message body, and never sees a listing description either. `get_listing_details` returns a fixed schema read from the description in code (unit number, vacant or tenanted, furnished, views from a fixed list). No sentence of the description is passed on, so an instruction in it cannot reach the model even when the regex flag (`instruction_like_text`) misses it.
2. **Invariants are enforced in code, not left to the prompt.**
   - The model only proposes property ids. The server re-reads every proposed row from Postgres, scoped to the agency.
   - It drops any listing that is from another agency, not `available`, never returned by a tool in this run, invented, a duplicate, not a fit (area, bedrooms, type, budget band) or has a suspect price.
   - It ranks by gross yield (`annualRentAed / priceAed`) when the lead cares about yield, and caps the list at 5.
   - Every dropped pick, with its reason, is stored in `diagnostics`. When picks are dropped, a note is appended to the summary.
   - The model's words are checked too. A reason whose AED amounts, percentages or listing codes do not match the re-read row is replaced by a reason built from the row. When the summary names a listing the server dropped (sold, over budget, invented...), those sentences are removed and the options are restated from the kept rows.
   - "Nothing fits" must come from a search. If Phase A found criteria and the model answers without a successful `search_listings`, the run fails (`invalid_output`) instead of completing empty. A rent enquiry is exempt, because every listing is for sale and code drops them all anyway.
3. **Dates are computed in code.**
   - The model only classifies the timing: tomorrow / relative days, a weekday, "after the weekend", an absolute date, unclear or none.
   - `domain/follow-up-date.ts` turns that into a date with `Intl`, from the message's `sentAt` in the logged-in agent's timezone. The server's own timezone plays no part, and the tests pass under both `TZ=UTC` and `TZ=America/Los_Angeles`.
   - Times default to 10:00 local. "After the weekend" means the first Monday strictly after the sent date (the UAE weekend is Saturday and Sunday).
   - Unclear timing gives `dueAt: null` plus `needsClarification`.
   - The lead's purchase/move timeline is a separate classification (see "Lead timeline" below). With no contact timing, an urgent timeline gives the next working day after `sentAt` at 10:00.
4. **Approval is a compare-and-set.** Approve runs `UPDATE ... WHERE status = 'pending_approval'` and the task insert in one transaction. A second approve returns the same task. Approving a rejected action, or rejecting an approved one, gives 409. A run itself writes only its own run row and action rows.
4a. **Self-verification of reasons.** After Phase B, code checks every candidate: the recommendation validation plus `domain/claim-check.ts`, which reads AED amounts (2.05M, 2,050,000, AED 2m), yield percentages (0.15 pp tolerance against the computed gross yield), bedroom counts, area and building names, status words and other listing codes in each reason and compares them with the listing row. If anything is off, the model gets exactly one revision turn in the same conversation, with the issues as data, the same read-only tools, no retries and inside the run deadline. Any reason still wrong is replaced by a code-built factual reason, so a wrong figure is never shipped. The record is in `diagnostics.selfVerification` (`checkedRecommendations`, `issuesFound`, `revised`, `rounds`, `fallbackReasons`, and `revisionError` when the turn produced nothing usable); the trace stays tool calls only.
5. **Failures say they failed.**
   - Any model error, tool error, schema-invalid output or timeout (110 s deadline, under the 2-minute limit) gives `201` with `status: "failed"`, an `error` and the exact empty shape.
   - The trace keeps the failed call with its `error`.
   - A run cut off by a restart or crash is failed with the error "The API restarted while this run was in progress, so it did not finish." (see "Stretch items").
6. **Vercel AI SDK on `claude-sonnet-5-5`** (`ai` + `@ai-sdk/anthropic`), wrapped in an `LlmGateway` seam. The model comes from `ASSISTANT_MODEL` and is stored on every run. No sampling parameters and no forced tool choice are sent: current Claude models reject them. Tests swap in a scripted model; `ASSISTANT_AGENT_IMPL=fake` runs the API without any model.
7. **Prompt caching, measured.** Tools, both system prompts and the output schemas are constants, so the prefix (tools -> system) is byte-identical for every lead and agency; all per-lead data (name, message, thread, agency areas, requirements) is in the messages. One explicit breakpoint sits on each system prompt; Phase B also uses top-level automatic caching so each tool-loop step reads the previous one. Phase A has no automatic breakpoint, because its prompt ends in the unique message. `diagnostics.usage` records cache read/write tokens, the hit ratio and the estimated cost with and without the cache (`agent/pricing.ts`; Sonnet 5.5 cache read $0.10, write $2.50 per MTok). Live, on claude-sonnet-5-5 with fixture listings: the cached prefix is 3,238 tokens for Phase A and 2,737 for Phase B (minimum cacheable is 512). A repeat run read 97% of its input from cache, costing $0.0130 instead of $0.0327. A different lead at another agency then read 91% of its input from cache on its first run ($0.0100 instead of $0.0268). The eval report shows cache tokens and savings per case and in total.
8. **Interpretations I would defend:**
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
- **Stretch lanes and a final audit.** Background runs and the model comparison were built in separate lanes (the comparison in its own git worktree, so its database resets never touched the main tree). A final audit (Claude, live curl under `TZ=UTC` as two agencies, plus a read-only Codex review) found four more important issues, each fixed test-first: raw listing descriptions still reached Phase B; a run could report "nothing fits" without searching; reasons and the summary were not checked against the data; one failed poll froze the web and mobile panels.
- **Checking.** No claim was accepted without a command run: `pnpm check` under two timezones, two fresh-database eval runs at the final commit, and a live curl of the contract against `TZ=UTC pnpm dev:api` (sync run, background run, second start, double approve, and a `kill -9` mid-run followed by a restart).

## How to run the evals

```bash
pnpm db:up && pnpm db:reset
pnpm -C api eval            # about 70 s wall time at concurrency 3, under $0.70 on claude-sonnet-5-5
```

- The suite boots the API in-process against `DATABASE_URL` and drives the HTTP contract with the real model.
- Output: a pass/fail table on stdout, `api/evals/reports/latest.md` and one trace per case in `api/evals/traces/`.
- Options: `EVAL_CASES=01,12` runs only those cases, `EVAL_CONCURRENCY` (default 3), `EVAL_GRADER=0` skips the model-graded check, `ASSISTANT_MODEL=...` picks the model.
- The suite writes runs and tasks to the database, so run `pnpm db:reset` afterwards.
- Last result: 15/15 on two consecutive fresh resets at the final code (commit `eaa7f25`, `claude-sonnet-5-5`, about 65 s each). The committed report and traces are from the second run.
- Model comparison: `ASSISTANT_MODEL=claude-opus-5-5 EVAL_GRADER_MODEL=claude-sonnet-5-5 pnpm -C api eval` (with a `pnpm db:reset` before each run). Holding the grader fixed keeps the non-gating quality column comparable. The write-up is `api/evals/model-comparison.md`.
- Unit and contract tests: `pnpm check`. It runs the API typecheck, unit tests and e2e tests (scripted model, real Postgres), plus the web and mobile tests.

## Stretch items

Both are done.

### 1. Background runs

- `POST /leads/:leadId/assistant/runs?async=true` checks the request exactly like the synchronous path (404, 400, 422, 401) and then answers `202` at once. The body is the run with `status: "running"` and empty results. Only the exact value `async=true` starts a background run; without it, the endpoint behaves exactly as the contract says (`201` with the finished run).
- The run continues in the same process, in its own database context, with the same 110 s deadline. Each tool call is written to the run row as it finishes, so `GET .../runs/:runId` shows the trace so far. It ends `completed` or `failed` with the same shape as a synchronous run.
- The web panel starts runs in the background and polls every 1.5 s. While the run is in progress it shows "Steps so far": each tool, a short form of its input, the duration, and ok or the error. A failed poll is retried with backoff; only a 401 or leaving the page stops it. Mobile starts runs synchronously but polls any run it finds still running.
- **Second run on the same lead: `409`, and the panel follows the first run.** A background start while that lead has a run in progress answers `409 {statusCode, message, runId}`, where `runId` is the running run. The web panel treats that as "already running" and attaches to `runId`. Concurrent starts are serialised with a per-lead Postgres advisory lock, so exactly one wins. Why: two analyses of the same message would propose two follow-ups for the same lead, and Sara could approve both. Following the running one costs nothing and shows her the same answer sooner. A synchronous `POST` is never blocked, because the graders' test cases use it and the contract has no `409` there.
- **Restart or crash.** Three guards make sure a run never stays `running`:
  - At startup, every run still `running` is marked `failed` with "The API restarted while this run was in progress, so it did not finish." Checked live: `kill -9` of the API mid-run, restart, and the run reads `failed` with that error and the two tool calls it made.
  - On a clean shutdown, runs in progress are aborted and stored as failed with the same error (waiting at most 5 s).
  - When a run is read more than the deadline plus 15 s after it started and is still `running`, it is failed on the spot. This covers the case where the API crashed and has not restarted, or where the startup sweep itself failed.
- **Assumption: one API process per database.** The startup sweep fails every `running` run, whichever process owns it. A second API process booting against the same database (the eval suite boots one in-process) fails the first one's runs in progress. Do not run the evals against the database a demo API is using.

### 2. Picking the model with the evals

`api/evals/model-comparison.md`: the 15-case suite twice on each of `claude-sonnet-5-5`, `claude-opus-5-5` and `claude-haiku-5-5`, each run on a fresh `db:reset`, with the grader held on Sonnet.

| Model | Case runs passed | Median / p90 per assistant run | Cost per assistant run |
| --- | --- | --- | --- |
| Sonnet 5.5 | 30/30 | 8.5 s / 11.5 s | ~$0.027 |
| Opus 5.5 | 30/30 | 10.8 s / 15.4 s | ~$0.056 |
| Haiku 5.5 | 29/30 | 8.7 s / 12.4 s | ~$0.0017 |

**Ship Sonnet 5.5 (the default).** It passed everything, was the fastest, and costs half as much as Opus. Opus showed slightly better judgement (it noticed the only fit for James is the unit he called small) but no gating case needed it. Haiku is 16 times cheaper but failed a run that Sonnet completes: it repeated an empty search four times, then sent a schema-invalid call. On a lead tool, a wrong "failed" costs Sara more than the tokens save. The comparison ran at commit `8680578`, before the final review fixes; Sonnet still passes 15/15 twice at the final commit.

## Observability

- **Structured logs.** `AssistantTelemetry` (api/src/assistant/observability) writes one JSON line per event through the Nest Logger (context `AssistantTelemetry`): `run.started`, `tool.called` (tool, durationMs, ok, and on failure only a coarse error class), `run.completed` / `run.failed` (runId, leadId, agencyId, model, status, failureKind, latencyMs, steps, toolCount, input/output/cache tokens, estimatedCostUsd). Ids only: message bodies, summaries, tool inputs and outputs, and raw tool error text are never logged (unit test asserts it). Cost is an estimate from list prices in `assistant-telemetry.ts`; unknown models give `null`.
- **Run diagnostics.** Every run stores `diagnostics.timings` `{ startedAt, finishedAt, latencyMs, phaseAMs, phaseBMs }`, and failed runs store `diagnostics.failureKind` (`model | tool | timeout | invalid_output | internal`). Token usage now includes `cacheReadTokens` / `cacheWriteTokens` when the provider reports them. No migration: all inside the existing JSON column.
- **`GET /assistant/metrics?sinceHours=168`** (auth, scoped to the caller's agency in the query): totals by status, success rate, nearest-rank p50/p90/max latency, total and average estimated cost, tokens and cache hit ratio, failure-kind histogram (`interrupted` and `unknown` for older rows), tool errors by tool, per-model breakdown, last failure time. Computed in memory from the window's rows; fine at this scale, would move to SQL aggregates with volume.
- **OpenTelemetry.** Both `generateText` calls pass `experimental_telemetry` (`functionId` `assistant.phaseA` / `assistant.phaseB`, metadata `runId`, `model`, `recordInputs`/`recordOutputs` off because prompts hold lead PII). Without a registered tracer provider this is a no-op; no OTel dependency was added. To export spans, add `@opentelemetry/sdk-node` plus an exporter (e.g. `@opentelemetry/exporter-trace-otlp-http`) and start a `NodeSDK({ traceExporter: new OTLPTraceExporter({ url }) })` before `NestFactory.create` in `main.ts`; the AI SDK picks up the global tracer, and spans carry token usage and the `runId` for joining with the JSON logs.

## What is missing or weak

- **Single API process per database** (see above). With two processes, one's startup sweep fails the other's runs in progress.
- Mobile starts runs synchronously, so it shows a spinner rather than live steps. (It now reads `bedroomsRange` and `budgetIsApproximate` like the web panel: "Studio or 1 bed", "Around AED 2,000,000".)
- The reason check covers numbers and listing codes only. A reason that gets a word wrong ("vacant" for a tenanted unit) still passes. When a reason fails the check, Sara sees the plain factual reason instead of the model's.
- The summary check removes sentences that name a dropped listing by its code. A sentence that praises a dropped listing only by building name is not caught (the removal note is still appended).
- The features read from a listing description are a short fixed list. Anything else in the description (a tenancy end date, "open to offers") is invisible to the model.
- A run that answers without searching now fails rather than retrying the search, so a lazy model turn costs Sara a retry.
- "Today" resolves to 10:00 on the sent day even when the message arrived later than 10:00, and single-digit hours ("call at 9") are discarded.
- A single schema-invalid tool call from the model fails the whole run, rather than letting the model correct it. This is what failed Haiku's run in the comparison; `search_listings` could accept missing nullable fields as null.
- Phase B decides some judgement calls on the requirements alone. For example, James found the Marina Gate 2 unit "a bit small", and MBR-1009 is that 1BR. Some runs recommend it, and others recommend nothing and say why. The eval accepts either, as long as an empty list is explained.
- Trace writes during a run are best-effort: a failed write is logged and the run continues. The final write always stores the full trace.
- The injection eval checks the outcome (MBR-1019 is never pushed), not the model's reasoning.
- Cost accounting: the report's per-case cost counts the shared Karim run in every case that reuses it. That is cases 01, 02, 10, 13 and 14; `model-comparison.md` lists only four of them, so its "report sum" figures count that run once more than it says. Its "unique runs" figures are unaffected.
- The eval suite and the live smoke write runs and tasks to the database. Run `pnpm db:reset` before handing the API to the test cases.

## Final changes after UAT (2026-11-16)

- **Default model is Claude Opus 5.5** (`ASSISTANT_MODEL`, Sonnet 5.5 still selectable). The eval comparison scored them equal (30/30 each), but hands-on UAT showed Opus reading context better. Live run of all 11 seed leads on Opus under `TZ=UTC`: every run completed in 9-17 s at $0.03-0.08 each.
- **Phase A reads the whole conversation and the lead profile** (CRM status and the agent's notes, as untrusted data) to fill gaps the analysed message leaves; the latest message still wins on conflicts. Sophie Laurent now comes out as intent buy, Downtown Dubai, MBR-1015 (the Burj Vista unit under negotiation), follow-up Thursday 19 Nov 10:00 +04:00.
- **Expo SDK 58**: current Expo Go is SDK 58, so the mobile app was upgraded (expo ~58.0.25, RN 0.88.1). The README still says SDK 57.
- Merged since the stretch work: prompt caching (repeat run 97% cache hit, $0.0130 vs $0.0327 on Sonnet), agent self-verification of recommendation reasons with one revision turn, and observability (structured JSON telemetry, AI SDK OpenTelemetry hooks, `GET /assistant/metrics` scoped to the caller's agency).
- Not finished in time: a single shared price table (telemetry keeps its own copy), restart-failure labelling in the metrics endpoint, injection warnings shown in the UIs, overdue flags on past due dates, and a re-run of the eval suite and model comparison on Opus with the merged features.

## Lead timeline (2026-11-16, from UAT)

UAT found that "Ready to buy this week" (Lina) came out as "unclear, 'this week' does not name a day" and "moving in next month" (Priya) as "no timing", both with `dueAt: null`. These phrases describe when the lead means to buy or move, not when to call, and they are the strongest urgency signal in the message.

**Decision: timeline and contact timing are two separate concepts.**
- Phase A returns `timeline: { kind, days, month, day, year, quote }` next to `followUp`. The kinds are `asap`, `this_week`, `next_week`, `this_month`, `next_month`, `within_days`, `by_date`, `no_rush` and `none`. The prompt has worked examples (Lina, Priya, "call me after the weekend", "call me Thursday, we are buying next month", "no rush, maybe next year"). The model only classifies the words; it never computes a date.
- `domain/timeline.ts` resolves the timeline to a window of local dates in the agent's zone, anchored on `sentAt`. A week runs Monday to Sunday (UAE work week). `next_month` is the whole next calendar month. `urgent` is true for asap, this/next week, this/next month, `within_days` up to 31 and `by_date` at most 31 days after the sent date. `stale` is true when the analysis's local date is after the window end. That is the only place the analysis time is used.
- `resolveFollowUpDue` (domain/follow-up-date.ts) applies these rules in order:
  1. Explicit contact timing always wins ("call me Thursday" plus "buying next month" gives Thursday).
  2. With no contact timing, an urgent timeline gives the next working day (Monday to Friday) after `sentAt` at 10:00, with `needsClarification: null`. The task notes add "Timeline: this week (16-22 Nov 2026), "Ready to buy this week". Urgent, so follow up on the next working day after the message." A follow-up is proposed even when the lead did not ask to be contacted.
  3. Otherwise behaviour is unchanged: `dueAt: null` plus `needsClarification`. Vague contact timing ("sometime", "later") stays unclear.
- When the model files the same words under both (an `unclear` followUp whose quote overlaps the timeline quote), they count as timeline only.
- `dueAt` stays anchored on `sentAt` even when the window is stale (TASK.md rule). A stale window instead appends "Note: the lead's timeline, ..., had already ended when this message was analysed. Check whether it still applies." to the summary.
- **API:** `requirements.timeline` is an extra field: the resolved object, or `null` when the lead gave no timeline. Failed runs keep the exact empty requirements shape.
- **Web and mobile:** both show a "Timeline" row, for example "Ready to buy this week (16-22 Nov 2026) · urgent", plus "window already passed" when the window is stale.
- **Provider limit found by the evals:** a structured-output schema may have at most 16 nullable (union-typed) parameters. The first version of the timeline took Phase A to 18, and the API rejected every run with HTTP 400. The `by_date` month, day and year are now plain integers, with 0 meaning "not given", and are normalised to null in code. A unit test counts the unions in the JSON schema.

**Evals** (Opus 5.5, fresh `db:reset`, `TZ=UTC`, 20 cases): 19/20 pass.
- Lina (04) and Priya (05) now expect an urgent timeline and a follow-up on the next working day.
- New cases: 17 ("this week" sent on a Friday is due Monday), 18 (a "this week" message 9 days old is stale), 19 ("call me Thursday" wins over "buying next month") and 20 ("no rush, maybe next year" gives no dated follow-up).
- The failure is case 13 (Sophie). Since commit `3ae67b1`, Phase A reads the thread and the lead profile, so Sophie gets Downtown Dubai and a search (MBR-1015). Case 13 still expects no search. This has nothing to do with the timeline (her timeline is `null`), but the eval expectation needs a ruling. The report and traces were not committed for that reason.

Open points:
- `asap` has no window end, so it is never stale.
- "next year" alone is classified as `no_rush`.
- A stale urgent window still proposes a date in the past (the next working day after `sentAt`). It is flagged in the summary rather than moved to the analysis date.
