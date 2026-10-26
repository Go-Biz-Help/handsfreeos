import type { AiToolDefinition } from '@hfos/ai';
import { ADDON_SERVER_MODULES, allAddonAiTools, assistantTools } from '@hfos/core/server';
import { describe, expect, it } from 'vitest';
import { contextText, lastingText, turnText, type PromptContext } from '../src/assistant/prompt';
import { assistantRequest } from '../src/assistant/runtime';

const PROMPT: PromptContext = {
  businessName: 'Lone Star HVAC',
  personName: 'Dale',
  role: 'Owner',
  timezone: 'America/Chicago',
  now: new Date('2026-09-27T14:16:00Z'),
  pipelines: [{ name: 'Sales', stages: [{ id: 's1', name: 'New', kind: 'open' }] }],
  team: [{ userId: 'u1', fullName: 'Dale', role: 'owner' }],
  calendars: [],
  services: [],
  page: null,
  workflows: [],
  approvals: [{ id: 'a1', workflow: 'Follow-up', customer: 'Mike', what: 'a text' }],
  knowledge: { brief: 'What they do: HVAC.', rules: 'State only facts.' },
  attention: null,
};

describe('Assistant context (PERF-M20)', () => {
  it('keeps what stays the same apart from what changes each question, so it can be cached', () => {
    const later: PromptContext = {
      ...PROMPT,
      now: new Date('2026-09-27T18:40:00Z'),
      page: { type: 'person', id: 'p1', label: 'Mike Johnson', next: null },
      approvals: [],
      spoken: true,
    };
    expect(lastingText(later)).toBe(lastingText(PROMPT));
    expect(lastingText(PROMPT)).toContain('Business: Lone Star HVAC.');
    expect(lastingText(PROMPT)).toContain('<business_profile>');
    expect(lastingText(PROMPT)).not.toContain('It is ');
    expect(turnText(PROMPT)).toMatch(/^It is Sunday, September 27, 2026/);
    expect(turnText(PROMPT)).toContain('(approval id a1)');
    expect(turnText(later)).toContain('On screen now: Mike Johnson');
    expect(contextText(PROMPT)).toBe(`${lastingText(PROMPT)}\n${turnText(PROMPT)}`);
  });
});

describe('what every question sends (assistantRequest)', () => {
  const addonTools = allAddonAiTools(ADDON_SERVER_MODULES);
  const inView = (tools: readonly AiToolDefinition[]) =>
    tools.filter((t) => !t.deferred).map((t) => t.name);

  it('keeps the same short list in view however many add-on tools come with it', () => {
    const searching = { toolSearch: true };
    const core = assistantRequest(assistantTools, searching);
    const all = assistantRequest([...assistantTools, ...addonTools], searching);
    expect(addonTools.filter((t) => t.addonId === 'outreach').length).toBeGreaterThan(60);
    expect(inView(all.tools)).toEqual(inView(core.tools));
    expect(inView(core.tools).length).toBeLessThan(30);
    expect(all.system).toBe(core.system);
    expect(all.tools.filter((t) => t.name.startsWith('outreach_')).every((t) => t.deferred)).toBe(
      true,
    );
  });

  it('works out each tool once, so the next question sends the very same definitions', () => {
    const offered = [...assistantTools, ...addonTools];
    const first = assistantRequest(offered, { toolSearch: true });
    const next = assistantRequest(offered, { toolSearch: true });
    expect(next).toEqual(first);
    next.tools.forEach((t, i) => expect(t.inputSchema).toBe(first.tools[i]!.inputSchema));
  });

  it('sends every core tool in view when the model can’t search, and add-ons’ tools still deferred', () => {
    const plain = assistantRequest([...assistantTools, ...addonTools], { toolSearch: false });
    expect(inView(plain.tools)).toEqual(assistantTools.map((t) => t.name));
  });
});
