import { describe, expect, it } from 'vitest';
import { contextText, lastingText, turnText, type PromptContext } from '../src/assistant/prompt';

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
