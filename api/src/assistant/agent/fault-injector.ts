import { Injectable } from '@nestjs/common';

/** Nest injection token for the FaultInjector (evals arm it in-process; there is no HTTP surface). */
export const ASSISTANT_FAULT_INJECTOR = 'ASSISTANT_FAULT_INJECTOR' as const;

export class InjectedFaultError extends Error {
  constructor(readonly tool: string) {
    super(`Injected fault: ${tool} is unavailable.`);
    this.name = 'InjectedFaultError';
  }
}

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Makes a named tool throw, to prove "a failing tool fails the run" (eval 6).
 * Inert unless NODE_ENV=test or ASSISTANT_FAULTS_ENABLED=1: in any other process, arming does
 * nothing and ASSISTANT_FAULT_TOOLS is ignored. Tools are armed in-process with arm(), or for an
 * API process started by an eval runner, with ASSISTANT_FAULT_TOOLS=search_listings,... read on
 * every check.
 */
@Injectable()
export class FaultInjector {
  readonly enabled: boolean;
  private readonly armed = new Set<string>();
  private readonly env: Env;

  constructor(env: Env = process.env) {
    this.env = env;
    this.enabled = env.NODE_ENV === 'test' || env.ASSISTANT_FAULTS_ENABLED === '1';
  }

  arm(tool: string): void {
    if (this.enabled) this.armed.add(tool);
  }

  disarm(tool?: string): void {
    if (tool === undefined) this.armed.clear();
    else this.armed.delete(tool);
  }

  /** Throws InjectedFaultError when `tool` is armed and faults are enabled. */
  check(tool: string): void {
    if (!this.enabled) return;
    if (this.armed.has(tool) || this.envTools().has(tool)) throw new InjectedFaultError(tool);
  }

  private envTools(): Set<string> {
    const raw = this.env.ASSISTANT_FAULT_TOOLS ?? '';
    return new Set(
      raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    );
  }
}
