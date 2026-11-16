/**
 * Pure helpers for the eval suite: expected dates, cost, verdicts and the markdown report.
 * No I/O here, so they are unit-tested (eval-lib.spec.ts) with the normal `pnpm test`.
 */

export interface Assertion {
  name: string;
  pass: boolean;
  /** Gating assertions decide the verdict. Non-gating ones (model-graded quality) are reported only. */
  gating: boolean;
  detail?: string;
}

export type Verdict = 'PASS' | 'FAIL';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
}

export interface QualityScore {
  /** Mean grader score, 1-5. */
  meanScore: number;
  /** Reasons the grader found supported by the listing's numbers, of all graded. */
  supported: number;
  graded: number;
  model: string;
  /** One line per graded reason. */
  notes?: string[];
}

export interface CaseResult {
  id: string;
  title: string;
  covers: string;
  verdict: Verdict;
  assertions: Assertion[];
  /** Wall time of the case's assistant runs (shared runs count in each case that uses them). */
  latencyMs: number;
  usage: Required<Usage>;
  costUsd: number | null;
  models: string[];
  quality: QualityScore | null;
}

export interface Report {
  startedAt: string;
  model: string;
  results: CaseResult[];
}

const DUBAI_OFFSET_MS = 4 * 3_600_000; // Asia/Dubai is UTC+4 all year (no DST).
const DAY_MS = 86_400_000;

/** The calendar date (YYYY-MM-DD) of an instant in Asia/Dubai. */
export function dubaiDate(iso: string): string {
  return new Date(new Date(iso).getTime() + DUBAI_OFFSET_MS).toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function at10(date: string): string {
  return `${date}T10:00:00+04:00`;
}

/** "Tomorrow": the Dubai calendar day after the message was sent, at the default 10:00. */
export function expectedNextDayAt10(sentAt: string): string {
  return at10(addDays(dubaiDate(sentAt), 1));
}

/** "After the weekend" (UAE weekend: Saturday and Sunday): the first Monday strictly after the sent date. */
export function firstMondayAfterAt10(sentAt: string): string {
  let date = addDays(dubaiDate(sentAt), 1);
  while (new Date(`${date}T00:00:00Z`).getUTCDay() !== 1) date = addDays(date, 1);
  return at10(date);
}

/** USD per million tokens, from the Claude pricing table (2026-11). */
const PRICES: Record<string, { input: number; output: number }> = {
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-sonnet-5': { input: 2, output: 10 },
};

export function costUsd(model: string, usage: Usage): number | null {
  const price = PRICES[model];
  if (!price) return null;
  return (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000;
}

export function verdictOf(assertions: readonly Assertion[]): Verdict {
  const gating = assertions.filter((a) => a.gating);
  return gating.length > 0 && gating.every((a) => a.pass) ? 'PASS' : 'FAIL';
}

/**
 * Every percentage written in a reason must be the listing's computed gross yield (to one decimal).
 * With unknown yield (no rent), a reason must not quote a percentage at all.
 */
export function yieldMentionsMatch(reason: string, grossYieldPct: number | null): boolean {
  const mentioned = [...reason.matchAll(/(\d+(?:\.\d+)?)\s*%/g)].map((m) => Number(m[1]));
  if (mentioned.length === 0) return true;
  if (grossYieldPct === null) return false;
  return mentioned.every((p) => Math.abs(p - grossYieldPct) < 0.05 + 1e-9);
}

function fmtInt(n: number): string {
  return n.toLocaleString('en-US');
}

function fmtCost(n: number | null): string {
  return n === null ? 'n/a' : `$${n.toFixed(4)}`;
}

function fmtQuality(q: QualityScore | null): string {
  return q ? `${q.meanScore.toFixed(1)}/5 (${q.supported}/${q.graded} supported)` : '-';
}

export function renderTable(results: readonly CaseResult[]): string {
  const rows = results.map((r) => {
    const gating = r.assertions.filter((a) => a.gating);
    const passed = gating.filter((a) => a.pass).length;
    return `| ${r.id} | ${r.title} | ${r.covers} | ${r.verdict} | ${passed}/${gating.length} | ${(r.latencyMs / 1000).toFixed(1)} s | ${fmtInt(r.usage.totalTokens)} | ${fmtCost(r.costUsd)} | ${r.models.join(', ') || '-'} |`;
  });
  return [
    '| Case | Title | Covers | Verdict | Gating assertions | Latency | Tokens | Cost | Model |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

export function renderReport(report: Report): string {
  const passed = report.results.filter((r) => r.verdict === 'PASS').length;
  const tokens = report.results.reduce((sum, r) => sum + r.usage.totalTokens, 0);
  const lines: string[] = [
    '# Assistant eval report',
    '',
    `- Started: ${report.startedAt}`,
    `- Model: ${report.model}`,
    `- Result: ${passed}/${report.results.length} cases passed`,
    `- Tokens (summed per case; shared runs count once per case that uses them): ${fmtInt(tokens)}`,
    '',
    'Verdicts come only from gating assertions: facts the code guarantees, and subset checks where the model has a choice.',
    'The quality column is a model-graded, non-gating score of whether each reason is supported by the listing data.',
    'Full runs, including each trace, are in `evals/traces/<case>.json`.',
    '',
    renderTable(report.results),
    '',
    '| Case | Reason quality (non-gating) |',
    '| --- | --- |',
    ...report.results.map((r) => `| ${r.id} | ${fmtQuality(r.quality)} |`),
    '',
    '## Assertions',
    '',
  ];
  for (const r of report.results) {
    lines.push(`### ${r.id}: ${r.title} (${r.verdict})`, '');
    for (const a of r.assertions) {
      const tag = a.gating ? (a.pass ? 'PASS' : 'FAIL') : a.pass ? 'info ok' : 'info no';
      lines.push(`- ${tag}: ${a.name}${a.detail ? ` (${a.detail})` : ''}`);
    }
    for (const note of r.quality?.notes ?? []) lines.push(`- grader (${r.quality?.model}): ${note}`);
    lines.push('');
  }
  return lines.join('\n');
}
