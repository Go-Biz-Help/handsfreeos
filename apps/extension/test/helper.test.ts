/**
 * The AI helper in a tab and in the runners (docs/outreach.md, decision 142): the view of the page it sends (names
 * hidden, the person as "(their name)", what's on top first), the moves it may and may not take, the learned ways it
 * presses, and the loop that asks the worker's AI a move at a time.
 */
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/hfos/session', () => ({ Refused: class extends Error {} }));
const reports = vi.hoisted(() => ({ sent: [] as unknown[] }));
vi.mock('../src/jobs/report', () => ({
  reporter: () => async (note: unknown) => {
    reports.sent.push(note);
    return '00000000-0000-4000-8000-000000000042';
  },
}));

const { helperView, HelperHands } = await import('../src/networks/helper-view');
const { FACEBOOK_OUTLINE } = await import('../src/networks/facebook/outline');
const { helpAfter, helpWith, stepHelp } = await import('../src/auto/helper');

const THEM = 'Sam Carter';

/** Sam's profile, with a box about notifications over it and someone else suggested beside them. */
function profile(): Document {
  return new JSDOM(
    `<body>
      <div role="banner"><a href="/me">Dana Reyes</a><button>Notifications</button></div>
      <div role="main">
        <h1>Sam Carter</h1>
        <div role="button" aria-label="Add friend">Add friend</div>
        <div role="button">Message</div>
        <div role="button">Like</div>
        <a href="https://www.facebook.com/sam.carter/friends">Friends</a>
        <a href="https://evil.example/connect">Add friend</a>
        <div role="button" aria-label="Add Jordan Lee as a friend">Add friend</div>
        <p>Add friend</p>
      </div>
      <div role="dialog" aria-label="Turn on notifications?">
        <div role="button">Not now</div>
        <div role="button">Allow</div>
      </div>
    </body>`,
    { url: 'https://www.facebook.com/sam.carter' },
  ).window.document;
}

const refOf = (view: string, line: string) => {
  const found = view.split('\n').find((l) => l.includes(line));
  return found ? Number(/\[(\d+)\]/.exec(found)?.[1]) : null;
};

describe('the helper’s view of a page', () => {
  it('shows what’s on top first, names hidden, the person as (their name), the top bar left out', () => {
    const { view, refs } = helperView(
      profile(),
      'https://www.facebook.com/sam.carter',
      FACEBOOK_OUTLINE,
      THEM,
    );
    expect(view.indexOf('On top:')).toBeLessThan(view.indexOf('The page:'));
    // A box's own words are hidden unless they're the network's; its buttons' everyday words are kept.
    expect(view).toContain('dialog "[3 words]"');
    expect(view).toContain('button "Not now"');
    expect(view).toContain('heading "(their name)"');
    expect(view).toContain('button "[6 words]"');
    expect(view).not.toMatch(/Sam|Carter|Jordan|Dana|Reyes/);
    expect(view).not.toContain('Notifications"');
    expect(view).toContain('text "Add friend"');
    expect(view).toContain('link "Add friend" → (another site)');
    expect(refs.length).toBe((view.match(/\[\d+\] /g) ?? []).length);
  });
});

describe('the helper’s hands', () => {
  const ready = () => {
    const doc = profile();
    const hands = new HelperHands(FACEBOOK_OUTLINE, () => THEM);
    const view = hands.look(doc, doc.location.href, true);
    return { doc, hands, view };
  };

  it('clicks what clears the way, never what takes a step', async () => {
    const { doc, hands, view } = ready();
    const notNow = refOf(view, '"Not now"')!;
    let clicked = '';
    doc.addEventListener('click', (e) => (clicked = (e.target as Element).textContent ?? ''));
    expect((await hands.move(doc, { do: 'click', ref: notNow, dir: null }, null)).went).toBe(true);
    expect(clicked).toBe('Not now');
    for (const words of ['"Message"', '"Like"', 'button "Add friend"']) {
      const done = await hands.move(doc, { do: 'click', ref: refOf(view, words), dir: null }, null);
      expect(done.went, words).toBe(false);
    }
    const friends = await hands.move(
      doc,
      { do: 'click', ref: refOf(view, '"Friends"'), dir: null },
      null,
    );
    expect(friends).toMatchObject({
      went: false,
      error: 'It doesn’t follow links to other pages.',
    });
  });

  it('presses the step’s own button for them alone, and gives back how it found it', async () => {
    const { doc, hands, view } = ready();
    const own = await hands.move(
      doc,
      { do: 'press', ref: refOf(view, 'button "Add friend"'), dir: null },
      'add_friend',
    );
    expect(own).toMatchObject({ went: true });
    expect(own.way).toMatchObject({
      tag: 'div',
      role: 'button',
      label: 'Add friend',
      inside: 'main',
    });
    const someoneElse = await hands.move(
      doc,
      { do: 'press', ref: refOf(view, '[6 words]'), dir: null },
      'add_friend',
    );
    expect(someoneElse).toMatchObject({ went: false, error: 'That button is for someone else.' });
    const offSite = await hands.move(
      doc,
      { do: 'press', ref: refOf(view, '(another site)'), dir: null },
      'add_friend',
    );
    expect(offSite.went).toBe(false);
    const notTheStep = await hands.move(
      doc,
      { do: 'press', ref: refOf(view, '"Message"'), dir: null },
      'add_friend',
    );
    expect(notTheStep.went).toBe(false);
    const noButton = await hands.move(
      doc,
      { do: 'press', ref: refOf(view, 'button "Add friend"'), dir: null },
      null,
    );
    expect(noButton.went).toBe(false);
  });

  it('presses a learned way only when exactly one thing fits it', async () => {
    const { doc, hands } = ready();
    const way = {
      tag: 'div',
      role: 'button',
      label: 'Add friend',
      words: 'Add friend',
      inside: 'main',
      menu: null,
    };
    expect(await hands.pressWay(doc, way, 'add_friend')).toBe(true);
    const twice = doc.querySelector('[aria-label="Add friend"]')!.cloneNode(true);
    doc.querySelector('[role="main"]')!.append(twice);
    expect(await hands.pressWay(doc, way, 'add_friend')).toBe(false);
    expect(await hands.pressWay(doc, way, 'follow')).toBe(false);
  });
});

// ---------- the loop ----------

type Asked = { type: string; [key: string]: unknown };

/** A tab that answers the helper's asks, and an HFOS whose AI answers each look in turn. */
function fakes(looks: readonly object[], ways: readonly object[] = []) {
  const tabAsks: Asked[] = [];
  const hfosAsks: Asked[] = [];
  let look = 0;
  const tab = {
    ask: async (message: Asked) => {
      tabAsks.push(message);
      if (message.type === 'hfos-helper-view')
        return { ok: true, view: '[1] button "Not now"\n[2] button "Add friend"' };
      if (message.type === 'hfos-helper-move')
        return {
          ok: true,
          done: {
            went: true,
            on: 'button',
            ...((message.move as { do: string }).do === 'press'
              ? {
                  way: {
                    tag: 'div',
                    role: 'button',
                    label: 'Add friend',
                    words: null,
                    inside: 'main',
                    menu: null,
                  },
                }
              : {}),
          },
        };
      if (message.type === 'hfos-helper-way') return { ok: true, pressed: true };
      return { ok: true };
    },
  };
  const hfos = async (message: Asked) => {
    hfosAsks.push(message);
    if (message.type === 'hfos-helper-ways') return { ok: true, value: { ways } };
    if (message.type === 'hfos-helper-look') return { ok: true, value: looks[look++] };
    return { ok: true, value: { trusted: false, removed: false } };
  };
  return { tab, hfos, tabAsks, hfosAsks };
}

const at = {
  businessId: '00000000-0000-4000-8000-000000000001',
  platform: 'facebook' as const,
  step: 'friend_request',
  why: 'couldn’t find “Add friend”',
  theirName: THEM,
};

describe('the helper’s loop', () => {
  it('clears the way, then presses the step’s button, and says what it did', async () => {
    const { tab, hfos, hfosAsks } = fakes([
      {
        verdict: 'in_the_way',
        said: 'A box covers the page.',
        move: { do: 'click', ref: 1, dir: null },
        asked: true,
      },
      {
        verdict: 'moved',
        said: 'Add friend is lower down now.',
        move: { do: 'press', ref: 2, dir: null },
        asked: true,
      },
    ]);
    const run = await helpWith(tab as never, hfos as never, { ...at, button: 'add_friend' });
    expect(run).toMatchObject({
      pressed: true,
      helper: { verdict: 'moved', looks: 2, result: 'reported' },
    });
    expect(run!.helper.moves.map((m) => m.do)).toEqual(['click', 'press']);
    expect(run!.way).toMatchObject({ label: 'Add friend' });
    // Never their name to the worker.
    expect(JSON.stringify(hfosAsks)).not.toContain('Sam');
  }, 10_000);

  it('tries a trusted learned way first, asking the AI nothing', async () => {
    const way = {
      tag: 'div',
      role: 'button',
      label: 'Add friend',
      words: null,
      inside: 'main',
      menu: null,
    };
    const { tab, hfos, hfosAsks } = fakes([], [{ button: 'add_friend', way }]);
    const run = await helpWith(tab as never, hfos as never, {
      ...at,
      platform: 'linkedin',
      button: 'add_friend',
    });
    expect(run).toMatchObject({
      pressed: true,
      helper: { verdict: 'moved', learned: 'worked', looks: 0 },
    });
    expect(hfosAsks.some((a) => a.type === 'hfos-helper-look')).toBe(false);
  });

  it('notes a way the AI found once the step went, and says it was done by the helper', async () => {
    const { tab, hfos, hfosAsks } = fakes([
      {
        verdict: 'moved',
        said: 'Under More.',
        move: { do: 'press', ref: 2, dir: null },
        asked: true,
      },
    ]);
    const help = stepHelp(tab as never, hfos as never, {
      ...at,
      platform: 'instagram',
      button: 'follow',
    });
    expect(await help.press('couldn’t find Follow', async () => false)).toBe(true);
    // Once a step: a second press asks nothing.
    expect(await help.press('again', async () => true)).toBe(false);
    const helper = await help.end(true);
    expect(helper).toMatchObject({ result: 'done_by_helper', verdict: 'moved' });
    expect(hfosAsks.find((a) => a.type === 'hfos-helper-way')).toMatchObject({
      input: { platform: 'instagram', button: 'follow', worked: true },
    });
  });

  it('reports without a look once the AI can’t be asked, and says why (decision 144)', async () => {
    const { tab, hfos } = fakes([
      {
        verdict: 'unclear',
        said: 'The AI is busy right now. Try again in a minute.',
        move: { do: 'none', ref: null, dir: null },
        asked: false,
      },
    ]);
    const run = await helpWith(tab as never, hfos as never, { ...at, button: null });
    expect(run).toMatchObject({
      pressed: false,
      cleared: false,
      helper: {
        looks: 0,
        verdict: 'unclear',
        notLooked: 'not_asked',
        said: 'The AI is busy right now. Try again in a minute.',
      },
    });
  });

  it('says HandsFreeOS didn’t answer, or the page couldn’t be read, when it never looked', async () => {
    const { tab } = fakes([]);
    const down = async (message: Asked) =>
      message.type === 'hfos-helper-look'
        ? {
            ok: false,
            problem: { message: 'No connection.', rule: null, status: null, recheck: false },
          }
        : { ok: true, value: { ways: [] } };
    expect(
      (await helpWith(tab as never, down as never, { ...at, button: null }))?.helper,
    ).toMatchObject({ looks: 0, notLooked: 'no_answer', said: 'No connection.' });
    const blind = { ask: async () => ({ ok: false, error: 'The tab closed.' }) };
    const { hfos } = fakes([]);
    expect(
      (await helpWith(blind as never, hfos as never, { ...at, button: null }))?.helper,
    ).toMatchObject({ looks: 0, notLooked: 'no_view' });
  });

  it('reports nothing for a step found done already (decision 144)', async () => {
    const { tab, hfos, hfosAsks } = fakes([]);
    reports.sent.length = 0;
    const helped = await helpAfter({
      tab: tab as never,
      hfos: hfos as never,
      businessId: at.businessId,
      platform: 'alignable',
      work: { do: 'step', item: { kind: 'friend_request', name: THEM } },
      job: 'friend_request',
      outcome: { done: false, line: 'Sam Carter: you’re connected already', skip: true as const },
      again: null,
    });
    expect(helped.reportId).toBeNull();
    expect(reports.sent).toEqual([]);
    expect(hfosAsks).toEqual([]);
  });

  it('after a step handed over: clears the way, tries it once more, and reports it fixed itself', async () => {
    const { tab, hfos } = fakes([
      {
        verdict: 'in_the_way',
        said: 'A box covered it.',
        move: { do: 'escape', ref: null, dir: null },
        asked: true,
      },
      {
        verdict: 'in_the_way',
        said: 'It’s clear now.',
        move: { do: 'none', ref: null, dir: null },
        asked: true,
      },
    ]);
    reports.sent.length = 0;
    type Went = { readonly done: boolean; readonly line: string; readonly need?: true };
    const first: Went = {
      done: false,
      line: 'Sam Carter: Facebook showed a different page',
      need: true,
    };
    const again = vi.fn(async (): Promise<Went> => ({
      done: true,
      line: 'Sent Sam Carter a friend request',
    }));
    const helped = await helpAfter({
      tab: tab as never,
      hfos: hfos as never,
      businessId: at.businessId,
      platform: 'facebook',
      work: { do: 'step', item: { kind: 'friend_request', name: THEM } },
      job: 'friend_request',
      outcome: first,
      again,
    });
    expect(again).toHaveBeenCalledOnce();
    expect(helped.outcome).toMatchObject({ done: true, helper: { result: 'fixed_itself' } });
    expect(helped.reportId).toBe('00000000-0000-4000-8000-000000000042');
    expect(reports.sent).toEqual([
      expect.objectContaining({ note: 'Sent (their name) a friend request', outline: true }),
    ]);
  }, 10_000);

  it('never tries a message again, and reports why without their name', async () => {
    const { tab, hfos } = fakes([
      {
        verdict: 'in_the_way',
        said: 'A box covered it.',
        move: { do: 'escape', ref: null, dir: null },
        asked: true,
      },
      {
        verdict: 'in_the_way',
        said: 'Clear.',
        move: { do: 'none', ref: null, dir: null },
        asked: true,
      },
    ]);
    reports.sent.length = 0;
    const helped = await helpAfter({
      tab: tab as never,
      hfos: hfos as never,
      businessId: at.businessId,
      platform: 'facebook',
      work: { do: 'send', item: { kind: 'message', name: THEM } },
      job: 'send',
      outcome: {
        done: false,
        line: 'Sam Carter: couldn’t find the box to write to Sam',
        need: true as const,
      },
      again: null,
    });
    expect(helped.outcome).toMatchObject({
      done: false,
      helper: { verdict: 'in_the_way', result: 'reported' },
    });
    expect(reports.sent).toEqual([
      expect.objectContaining({ note: 'couldn’t find the box to write to (their name)' }),
    ]);
  }, 10_000);
});
