import 'reflect-metadata';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { ClaudeAssistantAgent } from '../src/assistant/agent/claude-assistant.agent';
import { DEFAULT_ASSISTANT_MODEL } from '../src/assistant/agent/llm.gateway';
import { ASSISTANT_AGENT } from '../src/assistant/assistant.types';
import { CASES, CaseRecorder, EvalContext, KarimShared, lead } from './cases';
import { ApiClient } from './lib/api';
import { CaseResult, costUsd, costWithoutCacheUsd, renderReport, renderTable, verdictOf } from './lib/eval-lib';
import { gradeReasons } from './lib/grader';

/**
 * The eval suite: `pnpm -C api eval`, after `pnpm db:reset`.
 *
 * Boots the real AppModule in-process with the real Claude agent, against DATABASE_URL (the seeded
 * dev database), and drives the public HTTP contract like the apps do. Prints a pass/fail table,
 * writes evals/reports/latest.md and one evals/traces/<case>.json per case.
 */

const PASSWORD = 'challenge123';
const CONCURRENCY = Number(process.env.EVAL_CONCURRENCY ?? 3);
const ONLY = (process.env.EVAL_CASES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const EVALS_DIR = __dirname;

const selected = ONLY.length > 0 ? CASES.filter((c) => ONLY.some((o) => c.id.startsWith(o))) : CASES;
const results = new Map<string, CaseResult>();

async function pool<T>(items: readonly T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(size, queue.length)) }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item);
    }),
  );
}

describe('assistant evals (real model)', () => {
  let app: INestApplication;
  const startedAt = new Date().toISOString();
  const model = process.env.ASSISTANT_MODEL?.trim() || DEFAULT_ASSISTANT_MODEL;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
    const api = new ApiClient((await app.getUrl()).replace('[::1]', '127.0.0.1'));
    const agent = app.get<ClaudeAssistantAgent>(ASSISTANT_AGENT, { strict: false });
    if (!(agent instanceof ClaudeAssistantAgent)) throw new Error('Evals must run the Claude agent.');
    if (!agent.faults.enabled) throw new Error('The fault injector is inert: run the evals through jest (NODE_ENV=test).');

    const sara = await api.login('sara@marinabay.test', PASSWORD);
    const omar = await api.login('omar@desertkey.test', PASSWORD);
    let karim: Promise<KarimShared> | null = null;
    const ctx: EvalContext = {
      api,
      sara,
      omar,
      karim: () =>
        (karim ??= (async () => {
          const tasksBefore = await api.tasks(sara, lead('karim'));
          const run = await api.startRun(sara, lead('karim'), 'Karim (shared run)');
          const tasksAfterRun = await api.tasks(sara, lead('karim'));
          return { run, tasksBefore, tasksAfterRun };
        })()),
      armFault: (tool) => agent.faults.arm(tool),
      disarmFaults: () => agent.faults.disarm(),
    };

    const runCase = async (c: (typeof CASES)[number]) => {
      const rec = new CaseRecorder();
      try {
        await c.run(ctx, rec);
      } catch (error) {
        rec.check('the case ran without an exception', false, error instanceof Error ? error.message : String(error));
      }
      const quality = await Promise.all(rec.toGrade.map((g) => gradeReasons(g.message, g.items)));
      const scores = quality.filter((q): q is NonNullable<typeof q> => q !== null);
      const usage = rec.runs.reduce(
        (sum, r) => {
          const u = r.run?.diagnostics?.usage;
          return u
            ? {
                inputTokens: sum.inputTokens + u.inputTokens,
                outputTokens: sum.outputTokens + u.outputTokens,
                totalTokens: sum.totalTokens + u.totalTokens,
                cacheReadTokens: sum.cacheReadTokens + (u.cacheReadTokens ?? 0),
                cacheWriteTokens: sum.cacheWriteTokens + (u.cacheWriteTokens ?? 0),
              }
            : sum;
        },
        { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      );
      const models = [...new Set(rec.runs.map((r) => r.run?.model).filter((m): m is string => typeof m === 'string'))];
      const result: CaseResult = {
        id: c.id,
        title: c.title,
        covers: c.covers,
        verdict: verdictOf(rec.assertions),
        assertions: rec.assertions,
        latencyMs: rec.runs.reduce((s, r) => s + r.latencyMs, 0),
        usage,
        costUsd: costUsd(models[0] ?? model, usage),
        costWithoutCacheUsd: costWithoutCacheUsd(models[0] ?? model, usage),
        models,
        quality:
          scores.length === 0
            ? null
            : {
                meanScore: scores.reduce((s, q) => s + q.meanScore * q.graded, 0) / scores.reduce((s, q) => s + q.graded, 0),
                supported: scores.reduce((s, q) => s + q.supported, 0),
                graded: scores.reduce((s, q) => s + q.graded, 0),
                model: scores[0].model,
                notes: scores.flatMap((q) => q.notes ?? []),
              },
      };
      results.set(c.id, result);
      mkdirSync(join(EVALS_DIR, 'traces'), { recursive: true });
      writeFileSync(
        join(EVALS_DIR, 'traces', `${c.id}.json`),
        `${JSON.stringify({ case: c.id, title: c.title, covers: c.covers, verdict: result.verdict, assertions: rec.assertions, runs: rec.runs }, null, 2)}\n`,
      );
    };

    await pool(selected.filter((c) => !c.serial), CONCURRENCY, runCase);
    for (const c of selected.filter((c) => c.serial)) await runCase(c);
  });

  afterAll(async () => {
    const ordered = selected.map((c) => results.get(c.id)).filter((r): r is CaseResult => r !== undefined);
    if (ordered.length > 0) {
      mkdirSync(join(EVALS_DIR, 'reports'), { recursive: true });
      writeFileSync(join(EVALS_DIR, 'reports', 'latest.md'), `${renderReport({ startedAt, model, results: ordered })}\n`);
      const passed = ordered.filter((r) => r.verdict === 'PASS').length;
      process.stdout.write(`\n${renderTable(ordered)}\n\n${passed}/${ordered.length} cases passed. Report: evals/reports/latest.md\n\n`);
    }
    await app?.close();
  });

  it.each(selected.map((c) => [c.id, c] as const))('%s', (id) => {
    const result = results.get(id);
    const failed = result?.assertions.filter((a) => a.gating && !a.pass).map((a) => `${a.name}${a.detail ? ` (${a.detail})` : ''}`);
    expect({ id, verdict: result?.verdict, failed }).toEqual({ id, verdict: 'PASS', failed: [] });
  });
});
