/**
 * Test-only: a scripted LanguageModelV3 for the AI SDK's real generateText loop.
 *
 * Why not `MockLanguageModelV3` from `ai/test`: this project compiles with
 * `moduleResolution: "node"`, which ignores package.json `exports`, so `ai/test` does not resolve
 * for TypeScript. This is the same idea in ~60 lines: each doGenerate call returns the next step.
 */
import type { LanguageModel } from 'ai';
import type { LlmGateway } from '../llm.gateway';

export type LanguageModelV3 = Extract<LanguageModel, { specificationVersion: 'v3' }>;
type CallOptions = Parameters<LanguageModelV3['doGenerate']>[0];
type GenerateResult = Awaited<ReturnType<LanguageModelV3['doGenerate']>>;

export type ScriptedStep =
  | { toolCalls: Array<{ name: string; input: unknown }> }
  | { json: unknown }
  | { text: string }
  | { throws: Error }
  | ((options: CallOptions) => ScriptedStep | Promise<ScriptedStep>);

const USAGE = {
  inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 20, text: 20, reasoning: 0 },
};

export class ScriptedModel implements LanguageModelV3 {
  readonly specificationVersion = 'v3' as const;
  readonly provider = 'scripted';
  readonly supportedUrls = {};
  readonly calls: CallOptions[] = [];
  private callIndex = 0;

  constructor(
    private readonly steps: ScriptedStep[],
    readonly modelId = 'scripted-model',
  ) {}

  /** Tool names offered on call `i`. */
  toolNamesOnCall(i: number): string[] {
    return (this.calls[i]?.tools ?? []).map((t) => t.name);
  }

  get remainingSteps(): number {
    return this.steps.length - this.callIndex;
  }

  doGenerate = async (options: CallOptions): Promise<GenerateResult> => {
    this.calls.push(options);
    let step = this.steps[this.callIndex++];
    if (step === undefined) throw new Error(`ScriptedModel: no step scripted for call ${this.callIndex}`);
    if (typeof step === 'function') step = await step(options);
    if (typeof step === 'function') throw new Error('ScriptedModel: nested step functions are not supported');
    if ('throws' in step) throw step.throws;
    if ('toolCalls' in step) {
      return {
        content: step.toolCalls.map((c, i) => ({
          type: 'tool-call' as const,
          toolCallId: `call-${this.callIndex}-${i}`,
          toolName: c.name,
          input: JSON.stringify(c.input),
        })),
        finishReason: { unified: 'tool-calls', raw: 'tool_use' },
        usage: USAGE,
        warnings: [],
      };
    }
    const text = 'json' in step ? JSON.stringify(step.json) : step.text;
    return {
      content: [{ type: 'text', text }],
      finishReason: { unified: 'stop', raw: 'end_turn' },
      usage: USAGE,
      warnings: [],
    };
  };

  doStream = async (): Promise<never> => {
    throw new Error('ScriptedModel: streaming is not supported');
  };
}

export function scriptedGateway(model: ScriptedModel): LlmGateway {
  return {
    modelId: model.modelId,
    languageModel: () => model,
  };
}
