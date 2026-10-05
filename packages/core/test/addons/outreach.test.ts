/**
 * Social Outreach's manifest and operations, held to the add-on rules (docs/addon-architecture.md), its playbook
 * templates, and how a chat read again joins what was saved before. Pure: no database.
 */
import { describe, expect, it } from 'vitest';
import {
  addonAiIssues,
  addonModuleIssues,
  commands,
  manifestIssues,
  queries,
} from '../../src/server';
import { outreachAddon } from '../../src/addons/outreach/manifest';
import {
  blankPlaybook,
  PLAYBOOK_TEMPLATES,
  PlaybookDetails,
} from '../../src/addons/outreach/playbooks';
import { joinMessages, type ChatMessage, type SavedMessage } from '../../src/addons/outreach/saves';
import { outreachAddonServer } from '../../src/addons/outreach/server';

describe('Social Outreach', () => {
  it('has a valid manifest', () => {
    expect(manifestIssues(outreachAddon)).toEqual([]);
  });

  it('joins core’s operations cleanly', () => {
    const core = {
      commands: commands.filter((c) => c.addon?.id !== 'outreach'),
      queries: queries.filter((q) => q.addon?.id !== 'outreach'),
    };
    expect(addonModuleIssues(core, [outreachAddonServer])).toEqual([]);
  });

  it('declares every event its commands emit, and only those', () => {
    const emitted = (outreachAddonServer.commands ?? [])
      .flatMap((c) => c.emits)
      .filter((e) => e.startsWith('outreach.'));
    expect([...new Set(emitted)].sort()).toEqual([...(outreachAddon.events?.emits ?? [])].sort());
  });

  it('offers the AI only what it may use', () => {
    expect(addonAiIssues([outreachAddonServer])).toEqual([]);
  });
});

describe('playbooks', () => {
  it('starts every template and a blank one as a playbook its editor can save', () => {
    for (const [key, template] of Object.entries(PLAYBOOK_TEMPLATES))
      expect(PlaybookDetails.parse(template.details), key).toEqual(template.details);
    expect(PlaybookDetails.parse(blankPlaybook())).toEqual(blankPlaybook());
  });

  it('starts with the owner’s CRM-demo playbook, with their questions and tags', () => {
    const crm = PLAYBOOK_TEMPLATES.crm_demos;
    expect(crm.details.goal).toBe('demo');
    expect(crm.details.questions).toContain('Do you use a CRM?');
    expect(crm.details.skip).toContain('Group admins and moderators');
    expect(crm.details.tags).toEqual([
      'Business owner',
      'Uses a CRM',
      'Happy with CRM',
      'Unhappy with CRM',
      'Wants a demo',
      'Not a fit',
      'Friend or family',
    ]);
  });

  it('refuses a tag twice, an empty line, and a link that isn’t one', () => {
    const issues = (over: Partial<PlaybookDetails>) =>
      PlaybookDetails.safeParse({ ...blankPlaybook(), ...over }).error?.issues.map((i) =>
        i.path.join('.'),
      );
    expect(issues({ tags: ['Business owner', 'business owner'] })).toEqual(['tags']);
    expect(issues({ signs: ['Owner', '  '] })).toEqual(['signs.1']);
    expect(issues({ link: 'book with me' })).toEqual(['link']);
    expect(issues({ link: 'https://example.com/book' })).toBeUndefined();
  });
});

describe('a chat read again', () => {
  const AT = '2026-10-05T12:00:00.000Z';
  const LATER = '2026-10-06T09:00:00.000Z';
  const them = (text: string): ChatMessage => ({ from: 'them', sender: 'Dana', text, when: null });
  const me = (text: string): ChatMessage => ({ from: 'me', sender: null, text, when: null });
  const saved = (list: ChatMessage[]): SavedMessage[] => list.map((m) => ({ ...m, savedAt: AT }));
  const texts = (list: readonly ChatMessage[]) => list.map((m) => m.text);

  it('saves every message the first time', () => {
    const first = joinMessages([], [them('Hi!'), me('Hey Dana')], AT);
    expect(first.added).toBe(2);
    expect(first.messages.every((m) => m.savedAt === AT)).toBe(true);
  });

  it('adds only what’s new when the chat has moved on', () => {
    const before = saved([them('Hi!'), me('Hey Dana'), them('Do you do demos?')]);
    const read = [me('Hey Dana'), them('Do you do demos?'), me('Yes, Tuesday?'), them('Works')];
    const joined = joinMessages(before, read, LATER);
    expect(joined.added).toBe(2);
    expect(texts(joined.messages)).toEqual([
      'Hi!',
      'Hey Dana',
      'Do you do demos?',
      'Yes, Tuesday?',
      'Works',
    ]);
    expect(joined.messages.map((m) => m.savedAt)).toEqual([AT, AT, AT, LATER, LATER]);
  });

  it('changes nothing for the same messages, or a stretch from the middle', () => {
    const before = saved([them('Hi!'), me('Hey Dana'), them('Do you do demos?'), me('Yes')]);
    expect(joinMessages(before, before, LATER)).toEqual({ messages: before, added: 0 });
    expect(joinMessages(before, [me('Hey Dana'), them('Do you do demos?')], LATER).added).toBe(0);
  });

  it('puts older messages, read by scrolling up, before the ones saved', () => {
    const before = saved([me('Yes, Tuesday?'), them('Works')]);
    const joined = joinMessages(before, [them('Do you do demos?'), me('Yes, Tuesday?')], LATER);
    expect(texts(joined.messages)).toEqual(['Do you do demos?', 'Yes, Tuesday?', 'Works']);
    expect(joined.added).toBe(1);
  });

  it('places a repeated short message where it overlaps the most', () => {
    const before = saved([me('ok'), them('Tuesday?'), me('ok')]);
    const joined = joinMessages(before, [them('Tuesday?'), me('ok'), them('Great')], LATER);
    expect(texts(joined.messages)).toEqual(['ok', 'Tuesday?', 'ok', 'Great']);
    expect(joined.added).toBe(1);
  });

  it('learns who sent a message when the first read couldn’t tell', () => {
    const before = saved([{ from: 'unknown', sender: null, text: 'Hi!', when: null }]);
    const joined = joinMessages(before, [them('Hi!'), me('Hello')], LATER);
    expect(joined.messages[0]).toMatchObject({ from: 'them', sender: 'Dana', savedAt: AT });
    expect(joined.added).toBe(1);
  });

  it('keeps only the most recent', () => {
    const before = saved([them('one'), them('two'), them('three')]);
    const joined = joinMessages(before, [them('three'), them('four')], LATER, 3);
    expect(texts(joined.messages)).toEqual(['two', 'three', 'four']);
    expect(joined.added).toBe(1);
  });
});
