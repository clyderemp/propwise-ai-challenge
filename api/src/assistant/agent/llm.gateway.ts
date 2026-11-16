import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModel } from 'ai';
import { AgentRunError } from '../assistant.types';

/** Nest injection token for an LlmGateway override (tests, evals). */
export const ASSISTANT_LLM_GATEWAY = 'ASSISTANT_LLM_GATEWAY' as const;

export const DEFAULT_ASSISTANT_MODEL = 'claude-sonnet-5-5';
export const NOT_CONFIGURED_MESSAGE = 'The assistant is not configured (ANTHROPIC_API_KEY is not set).';

/**
 * The seam between the agent and the model provider. The agent drives the Vercel AI SDK's
 * generateText loop itself; the gateway only decides which LanguageModel it talks to, so tests can
 * swap in a scripted model and still exercise the real loop, tool execution and output parsing.
 */
export interface LlmGateway {
  readonly modelId: string;
  /** Throws AgentRunError('model', ...) when the provider cannot be used (e.g. no API key). */
  languageModel(): LanguageModel;
}

type Env = Readonly<Record<string, string | undefined>>;

export class AnthropicLlmGateway implements LlmGateway {
  readonly modelId: string;

  constructor(private readonly env: Env = process.env) {
    this.modelId = env.ASSISTANT_MODEL?.trim() || DEFAULT_ASSISTANT_MODEL;
  }

  languageModel(): LanguageModel {
    const apiKey = this.env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) throw new AgentRunError('model', NOT_CONFIGURED_MESSAGE);
    return createAnthropic({ apiKey })(this.modelId);
  }
}
