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
- **Evals**: `api/evals/`, 15 cases on the real model. Plain assertions gate the verdict; a model-graded score of reason quality is reported but does not gate.
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
4. **Approval is a compare-and-set.** Approve runs `UPDATE ... WHERE status = 'pending_approval'` and the task insert in one transaction. A second approve returns the same task. Approving a rejected action, or rejecting an approved one, gives 409. A run itself writes only its own run row and action rows.
5. **Failures say they failed.**
   - Any model error, tool error, schema-invalid output or timeout (110 s deadline, under the 2-minute limit) gives `201` with `status: "failed"`, an `error` and the exact empty shape.
   - The trace keeps the failed call with its `error`.
   - A run cut off by a restart or crash is failed with the error "The API restarted while this run was in progress, so it did not finish." (see "Stretch items").
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

## What is missing or weak

- **Single API process per database** (see above). With two processes, one's startup sweep fails the other's runs in progress.
- Mobile starts runs synchronously, so it shows a spinner rather than live steps. It also ignores `bedroomsRange` and `budgetIsApproximate`, so "studio or 1-bed" shows as "Any" and "around 2M" as "Up to". The web panel uses both fields.
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
