import { ClaudeAssistantAgent } from './agent/claude-assistant.agent';
import { FakeAssistantAgent } from './assistant.fake-agent';
import { assistantAgentClass } from './assistant.module';

describe('assistantAgentClass', () => {
  it('uses the Claude agent by default', () => {
    expect(assistantAgentClass(undefined)).toBe(ClaudeAssistantAgent);
    expect(assistantAgentClass('')).toBe(ClaudeAssistantAgent);
    expect(assistantAgentClass('claude')).toBe(ClaudeAssistantAgent);
  });

  it('uses the scripted agent only when ASSISTANT_AGENT_IMPL=fake', () => {
    expect(assistantAgentClass('fake')).toBe(FakeAssistantAgent);
  });

  it('refuses an unknown implementation instead of silently picking one', () => {
    expect(() => assistantAgentClass('gpt')).toThrow(/ASSISTANT_AGENT_IMPL/);
  });
});
