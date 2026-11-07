import { playbooksAnswer } from '@hfos/core/addons/salescoach/ai-answers';
import { describe, expect, it } from 'vitest';
import { ADDON_SERVER_MODULES, allAddonAiTools } from '@hfos/core/server';
import { ADDON_WORKER_MODULES } from '../src/addons/modules';
import {
  allAddonActionTools,
  answerFrom,
  cardFields,
  fittedAnswer,
  MOST,
  ownWhat,
  whatLine,
  WHOLE_MOST,
} from '../src/assistant/tools-addons';

/**
 * An add-on's answer too long to read whole (assistant/tools-addons.ts): its lists cut to their first rows, everything
 * else kept whole, so a long day's list never pushes the counts, the page and why nothing more is on it out of reach.
 * Only an answer that can't be made to fit that way is cut short as it is.
 */

const row = (i: number) => ({ id: `row-${i}`, name: `Person ${i}`, note: 'x'.repeat(80) });
const rows = (n: number) => Array.from({ length: n }, (_, i) => row(i));
const ADDON = { addonName: 'Social Outreach' };

describe('an answer too long to read whole', () => {
  it('keeps everything that isn’t a list, and cuts each list to the first rows that fit', () => {
    const data = {
      goal: 30,
      requestsHeld: 'No new friend requests for now.',
      page: 1,
      pages: 4,
      items: rows(400),
      partners: rows(3),
    };
    const got = answerFrom(ADDON, data) as {
      data: typeof data;
      cutShort: boolean;
      dropped: Record<string, number>;
      note: string;
    };
    expect(JSON.stringify(data).length).toBeGreaterThan(MOST);
    expect(got.cutShort).toBe(true);
    expect(got.data).toMatchObject({
      goal: 30,
      requestsHeld: data.requestsHeld,
      page: 1,
      pages: 4,
    });
    // The short list stays whole; the long one keeps its first rows, in order.
    expect(got.data.partners).toEqual(data.partners);
    expect(got.data.items.length).toBeGreaterThan(10);
    expect(got.data.items).toEqual(data.items.slice(0, got.data.items.length));
    expect(got.dropped).toEqual({ items: 400 - got.data.items.length });
    expect(got.note).toMatch(/dropped says how many/);
    expect(JSON.stringify(got).length).toBeLessThanOrEqual(MOST + 1_000);
  });

  it('is read whole when it fits, and cut short as it is when it can’t be made to fit', () => {
    const small = { items: rows(2) };
    expect(answerFrom(ADDON, small)).toEqual({ from: 'Social Outreach', data: small });
    expect(fittedAnswer('words')).toBeNull();
    expect(fittedAnswer({ text: 'x'.repeat(MOST * 2) })).toBeNull();
    const words = answerFrom(ADDON, { text: 'x'.repeat(MOST * 2) }) as { data: string };
    expect(typeof words.data).toBe('string');
    expect(words.data.endsWith('…')).toBe(true);
  });

  it('reads an answer that is only any use whole up to its own length: a draft to save as it is', () => {
    const draft = { name: 'New lead call', details: { steps: rows(150) } };
    expect(JSON.stringify(draft).length).toBeGreaterThan(MOST);
    expect(JSON.stringify(draft).length).toBeLessThan(WHOLE_MOST);
    expect(answerFrom(ADDON, draft, WHOLE_MOST)).toEqual({ from: 'Social Outreach', data: draft });
    // AI Sales Coach's drafted playbook is one: read whole, then saved with salescoach_playbook_save.
    const tool = allAddonActionTools(ADDON_WORKER_MODULES).find(
      (t) => t.name === 'salescoach_draft_playbook',
    )!;
    expect(tool.action.ai?.whole).toBe(true);
    expect(tool.description).toMatch(/isn't on the Playbooks tab/);
    expect(tool.description).toMatch(/salescoach_playbook_save/);
    const shown = tool.action.ai!.answer!(
      {
        name: 'New lead call',
        details: {
          steps: [{ id: 's1', title: 'Say hello', say: '', stage: null, tip: '' }],
          objections: [],
          points: [],
        },
      },
      { kind: 'new_lead' },
    );
    expect(shown).toEqual({
      name: 'New lead call',
      kind: 'new_lead',
      details: { steps: [{ id: 's1', title: 'Say hello' }], objections: [], points: [] },
      saved: false,
    });
  });

  it('reads one AI Sales Coach playbook too long to read whole by its first rows, never none of it', () => {
    const playbook = {
      id: 'pb-1',
      name: 'Pasted script',
      kind: 'any',
      isDefault: true,
      archivedAt: null,
      details: {
        steps: Array.from({ length: 20 }, (_, i) => ({
          id: `s${i + 1}`,
          title: `Step ${i + 1}`,
          say: 'w'.repeat(500),
        })),
        objections: Array.from({ length: 40 }, (_, i) => ({
          id: `o${i + 1}`,
          objection: `Objection ${i + 1}`,
          answer: 'a'.repeat(700),
        })),
        points: [{ id: 'p1', topic: 'Warranty', fact: 'Ten years on parts.' }],
      },
    };
    const got = answerFrom(
      ADDON,
      playbooksAnswer({ playbooks: [playbook] }, { playbookId: 'pb-1' }),
    ) as {
      data: {
        playbook: { name: string };
        steps: unknown[];
        objections: unknown[];
        points: unknown[];
      };
      dropped: Record<string, number>;
    };
    expect(got.data.playbook.name).toBe('Pasted script');
    expect(got.data.points).toHaveLength(1);
    expect(got.data.steps.length).toBeGreaterThan(0);
    expect(got.data.objections.length).toBeGreaterThan(0);
    expect(got.dropped['objections']).toBe(40 - got.data.objections.length);
  });
});

/**
 * A Confirm card's What line is for the person: the operation's own words when it has them, else the first sentence of
 * what the model reads, never the model's instructions or the names of tools and arguments.
 */
describe('a Confirm card’s What line', () => {
  it('is the first sentence, without the argument names given in brackets', () => {
    expect(
      whatLine(
        'Save to their card: copy a chat onto the customer’s card, or take the one picked (personId). Then read it with outreach_chats.',
      ),
    ).toBe('Save to their card: copy a chat onto the customer’s card, or take the one picked.');
    expect(whatLine('Mark them a client (client true), or not (client false).')).toBe(
      'Mark them a client, or not.',
    );
    // Brackets in the person's words stay.
    expect(whatLine('Cancel them all (People → Friends, Sent).')).toBe(
      'Cancel them all (People → Friends, Sent).',
    );
    expect(whatLine('Cancel a pool visit and tell the customer.')).toBe(
      'Cancel a pool visit and tell the customer.',
    );
    expect(whatLine('Long words for the model.', 'Short words for you')).toBe(
      'Short words for you',
    );
  });

  it('takes the operation’s own words for what it was given', () => {
    const tools = allAddonAiTools(ADDON_SERVER_MODULES);
    const client = tools.find((t) => t.name === 'outreach_mark_client')!;
    expect(ownWhat(client.op.ai, { client: true })).toMatch(/^Mark them as a client/);
    expect(ownWhat(client.op.ai, { client: false })).toMatch(/^Not a client after all/);
    const fields = cardFields(client, { client: false }, ownWhat(client.op.ai, { client: false }));
    expect(fields[0]).toEqual({
      label: 'What',
      value: 'Not a client after all: take the Client tag off them',
    });
    const cancel = tools.find((t) => t.name === 'outreach_cancel_all_requests')!;
    expect(ownWhat(cancel.op.ai, { platform: 'linkedin', on: true })).toContain('on LinkedIn');
  });

  it('names no tool or argument on any add-on’s card', () => {
    const named = /\b[a-z]+_[a-z_]+\b|\b[a-z]+[A-Z][A-Za-z]*\b/;
    const odd = allAddonAiTools(ADDON_SERVER_MODULES)
      .filter((t) => t.autonomy === 'confirm' && typeof t.op.ai?.what !== 'function')
      .map((t) => [t.name, whatLine(t.description, ownWhat(t.op.ai, {}))] as const)
      .filter(([, what]) => named.test(what));
    expect(odd).toEqual([]);
  });
});
