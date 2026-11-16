import { extractionPrompt, EXTRACTION_SYSTEM } from './prompts';
import { DEFAULT_ASSISTANT_MODEL } from './llm.gateway';

const message = { id: 'm2', direction: 'inbound' as const, channel: 'whatsapp', body: "Thanks. Let me speak to my husband and I'll get back to you by Thursday.", sentAt: new Date('2026-11-13T12:11:55Z') };
const thread = [{ id: 'm1', direction: 'outbound' as const, channel: 'whatsapp', body: 'Hi Sophie, the owner of the Burj Vista unit came back at 3.7M.', sentAt: new Date('2026-11-13T11:41:55Z') }];

describe('Phase A lead context (UAT ruling 8.2)', () => {
  it('gives the model the lead profile (status, notes) as labelled untrusted data', () => {
    const prompt = extractionPrompt({ message, thread, agencyAreas: ['Downtown Dubai'], lead: { status: 'negotiating', notes: 'Buying with her husband. Prefers WhatsApp.' } });
    expect(prompt).toContain('<lead_profile>');
    expect(prompt).toContain('Buying with her husband');
    expect(prompt).toContain('negotiating');
    expect(prompt).toContain('Burj Vista');
  });

  it('tells the model to use the whole conversation and profile to fill gaps, latest message winning on conflicts', () => {
    expect(EXTRACTION_SYSTEM).toMatch(/lead_profile/);
    expect(EXTRACTION_SYSTEM).toMatch(/fill gaps|fill in/i);
    expect(EXTRACTION_SYSTEM).toMatch(/get back to/i);
  });

  it('defaults to Claude Opus 5.5', () => {
    expect(DEFAULT_ASSISTANT_MODEL).toBe('claude-opus-5-5');
  });
});
