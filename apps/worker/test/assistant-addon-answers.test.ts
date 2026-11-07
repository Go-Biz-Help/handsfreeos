import { describe, expect, it } from 'vitest';
import { ADDON_SERVER_MODULES, allAddonAiTools } from '@hfos/core/server';
import {
  answerFrom,
  cardFields,
  fittedAnswer,
  MOST,
  ownWhat,
  whatLine,
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
