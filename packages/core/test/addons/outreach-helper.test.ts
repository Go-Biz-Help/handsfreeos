/**
 * Social Outreach's AI helper (docs/outreach.md, decision 142): the checks every answer goes through before the tab
 * takes a move, which buttons a step may press, and how learned ways are kept as one.
 */
import { describe, expect, it } from 'vitest';
import {
  buttonFor,
  checkedHelperAnswer,
  HelperLookInput,
  helperPrompt,
  helperSystem,
  mayClear,
  mayPress,
  viewLine,
  viewLines,
  wayFits,
  wayKey,
  type HelperAnswer,
  type WayShape,
} from '../../src/addons/outreach/helper';
import { HELPER_MOVES_MOST } from '../../src/schemas/problem-report';

const VIEW = [
  'Page: profile /{1}',
  'On top:',
  viewLine(1, 1, 'dialog', 'Turn on notifications?'),
  viewLine(2, 2, 'button', 'Not now'),
  viewLine(2, 3, 'button', 'Allow'),
  'The page:',
  viewLine(1, 4, 'h1', '(their name)'),
  viewLine(1, 5, 'button', 'Add friend'),
  viewLine(1, 6, 'button', 'Message'),
  viewLine(1, 7, 'link', 'Friends', '/{1}/friends'),
  viewLine(1, 8, 'button', 'Like'),
  viewLine(1, 9, 'button', 'Remove friend'),
].join('\n');

const input = (over: Partial<HelperLookInput> = {}) =>
  HelperLookInput.parse({
    platform: 'facebook',
    step: 'friend_request',
    button: 'add_friend',
    why: 'couldn’t find “Add friend”',
    view: VIEW,
    moves: [],
    ...over,
  });

const answer = (move: HelperAnswer['move'], verdict: HelperAnswer['verdict'] = 'in_the_way') =>
  ({ verdict, said: 'A box about notifications covers the page.', move }) as HelperAnswer;

describe('the view’s lines', () => {
  it('reads back each numbered line, its words and its link', () => {
    const lines = viewLines(VIEW);
    expect(lines.get(5)).toEqual({ ref: 5, kind: 'button', words: 'Add friend', href: null });
    expect(lines.get(7)?.href).toBe('/{1}/friends');
    expect(lines.has(10)).toBe(false);
  });

  it('keeps words with quotes in them', () => {
    const line = viewLine(0, 3, 'button', 'Say "hi"');
    expect(viewLines(line).get(3)?.words).toBe('Say "hi"');
  });
});

describe('what the helper may clear and press', () => {
  it('never clears with anything that takes a step or changes something', () => {
    expect(mayClear('Not now')).toBe(true);
    expect(mayClear('Close')).toBe(true);
    for (const words of [
      'Like',
      'Send',
      'Message',
      'Remove friend',
      'Follow',
      'Post',
      'Allow notifications',
    ])
      expect(mayClear(words), words).toBe(words === 'Allow notifications');
  });

  it('presses only the step’s own button, never one that undoes or sends', () => {
    expect(mayPress('Add friend', 'add_friend')).toBe(true);
    expect(mayPress('Add Friend (their name)', 'add_friend')).toBe(true);
    expect(mayPress('Invite (their name) to connect', 'connect')).toBe(true);
    expect(mayPress('Follow Back', 'follow')).toBe(true);
    expect(mayPress('Following', 'follow')).toBe(false);
    expect(mayPress('Cancel request', 'add_friend')).toBe(false);
    expect(mayPress('Message', 'add_friend')).toBe(false);
    expect(mayPress('Unlike', 'like')).toBe(false);
    expect(mayPress('Pending', 'connect')).toBe(false);
  });

  it('knows each network’s step button, and none for a message or a like it can’t pick', () => {
    expect(buttonFor('facebook', 'friend_request')).toBe('add_friend');
    expect(buttonFor('facebook', 'confirm')).toBe('confirm');
    expect(buttonFor('linkedin', 'friend_request')).toBe('connect');
    expect(buttonFor('instagram', 'friend_request')).toBe('follow');
    expect(buttonFor('alignable', 'confirm')).toBe('accept');
    expect(buttonFor('facebook', 'message')).toBeNull();
  });
});

describe('checking the AI’s answer', () => {
  it('lets a click that clears the way through', () => {
    expect(checkedHelperAnswer(answer({ do: 'click', ref: 2, dir: null }), input()).move).toEqual({
      do: 'click',
      ref: 2,
      dir: null,
    });
  });

  it('turns a click on something that takes a step into no move', () => {
    for (const ref of [6, 8, 9])
      expect(checkedHelperAnswer(answer({ do: 'click', ref, dir: null }), input()).move.do).toBe(
        'none',
      );
  });

  it('turns a move on a line that isn’t in the view into no move', () => {
    expect(checkedHelperAnswer(answer({ do: 'click', ref: 99, dir: null }), input()).move.do).toBe(
      'none',
    );
  });

  it('presses the step’s own button once, and only when the step may', () => {
    const press = answer({ do: 'press', ref: 5, dir: null }, 'moved');
    expect(checkedHelperAnswer(press, input()).move).toEqual({ do: 'press', ref: 5, dir: null });
    expect(checkedHelperAnswer(press, input({ button: null })).move.do).toBe('none');
    expect(
      checkedHelperAnswer(press, input({ moves: [{ do: 'press', on: 'button', went: false }] }))
        .move.do,
    ).toBe('none');
    expect(checkedHelperAnswer(answer({ do: 'press', ref: 6, dir: null }), input()).move.do).toBe(
      'none',
    );
  });

  it('stops after the last move', () => {
    const moves = Array.from({ length: HELPER_MOVES_MOST }, () => ({
      do: 'scroll' as const,
      on: null,
      went: true,
    }));
    expect(
      checkedHelperAnswer(answer({ do: 'scroll', ref: null, dir: 'down' }), input({ moves })).move
        .do,
    ).toBe('none');
  });

  it('keeps what it said short and plain', () => {
    const said = checkedHelperAnswer(
      { ...answer({ do: 'none', ref: null, dir: null }), said: `Moved — ${'x'.repeat(600)}` },
      input(),
    ).said;
    expect(said.length).toBeLessThanOrEqual(400);
    expect(said).not.toContain('—');
  });
});

describe('what the AI is told', () => {
  it('says which button it may press, or that it may press none', () => {
    expect(helperSystem('facebook', 'add_friend')).toMatch(/You may press .*"Add friend"/);
    expect(helperSystem('facebook', null)).toMatch(/Don’t press the step’s own button/);
  });

  it('sends the view and the moves so far, never a name', () => {
    const prompt = helperPrompt(
      input({ moves: [{ do: 'click', on: 'button "Not now"', went: true }] }),
    );
    // The page is data, quoted so nothing on it reads as an instruction.
    expect(prompt).toContain('[5] button &quot;Add friend&quot;');
    expect(prompt).toContain('Not now');
  });
});

describe('learned ways', () => {
  const way: WayShape = {
    tag: 'div',
    role: 'button',
    label: 'Add Friend (their name)',
    words: 'Add friend',
    inside: 'main',
    menu: null,
  };

  it('is one way however many words a person’s part had', () => {
    const a = {
      ...way,
      menu: { tag: 'div', role: 'button', label: '[2 words] more', words: null },
    };
    const b = {
      ...way,
      menu: { tag: 'div', role: 'button', label: '[3 words] more', words: null },
    };
    expect(wayKey(a)).toBe(wayKey(b));
    expect(wayKey(a)).not.toBe(wayKey(way));
  });

  it('is kept only when it presses the step’s own button with the network’s own words', () => {
    expect(wayFits(way, 'add_friend')).toBe(true);
    expect(wayFits(way, 'follow')).toBe(false);
    expect(wayFits({ ...way, label: '[2 words]', words: '(their name)' }, 'add_friend')).toBe(
      false,
    );
    expect(wayFits({ ...way, label: 'Remove friend', words: null }, 'add_friend')).toBe(false);
  });
});
