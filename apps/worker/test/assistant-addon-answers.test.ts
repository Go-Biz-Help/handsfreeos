import { describe, expect, it } from 'vitest';
import { ADDON_WORKER_MODULES } from '../src/addons/modules';
import {
  allAddonActionTools,
  answerFrom,
  fittedAnswer,
  MOST,
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
});
