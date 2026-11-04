/**
 * "Add tasks from what you say", for messages, without a database: what the AI is shown (the new messages marked, the
 * open tasks, today where the business is), how its due dates are read, and the scripted stand-in the database tests
 * lean on.
 */
import { localInstant } from '@hfos/core/server';
import { describe, expect, it } from 'vitest';
import { scriptedConversationTasks } from '../src/ai/scripted';
import {
  CONVERSATION_TASKS_ASK,
  conversationTasksPrompt,
  taskDueFrom,
} from '../src/automations/conversation-tasks';

const CHI = 'America/Chicago';
// Wednesday 4 November 2026, 3 PM in Chicago.
const NOW = Date.parse('2026-11-04T21:00:00Z');

const prompt = (
  lines: { who: string; words: string; isNew?: boolean }[],
  openTasks: string[] = [],
) =>
  conversationTasksPrompt({
    business: 'Lone Star HVAC',
    customer: 'Mike Johnson',
    writer: 'Dale Owner',
    now: NOW,
    timeZone: CHI,
    openTasks,
    lines: lines.map((l, i) => ({
      at: new Date(NOW - (lines.length - i) * 60_000),
      who: l.who,
      words: l.words,
      isNew: !!l.isNew,
    })),
  });

describe('what the AI is shown', () => {
  it('marks the new messages, says today where the business is, and lists the open tasks', () => {
    const p = prompt(
      [
        { who: 'Customer', words: 'Can you send <b>the</b> quote?' },
        { who: 'Dale Owner (team)', words: 'Sure, will do', isNew: true },
      ],
      ['Book the tune-up (due Nov 6)'],
    );
    expect(p).toContain('Today is Wednesday 2026-11-04 (America/Chicago).');
    expect(p).toContain('Customer: Mike Johnson');
    expect(p).toContain('Open tasks for this customer already:\n- Book the tune-up (due Nov 6)');
    expect(p).toMatch(
      /^\[Nov 4, 2:58\sPM\] Customer: Can you send &lt;b&gt;the&lt;\/b&gt; quote\?$/m,
    );
    expect(p).toMatch(/^NEW \[Nov 4, 2:59\sPM\] Dale Owner \(team\): Sure, will do$/m);
    expect(p.endsWith(CONVERSATION_TASKS_ASK)).toBe(true);
  });
});

describe('when a task is due', () => {
  it('reads a date alone as all day, and a time as that time, where the business is', () => {
    expect(taskDueFrom('2026-11-05', CHI, NOW)).toEqual({
      dueAt: new Date(localInstant('2026-11-05', '00:00', CHI)).toISOString(),
      allDay: true,
    });
    expect(taskDueFrom('2026-11-06T10:00', CHI, NOW)).toEqual({
      dueAt: '2026-11-06T16:00:00.000Z',
      allDay: false,
    });
  });

  it('gives no date for words it can’t read, long gone, or more than a year off', () => {
    expect(taskDueFrom(null, CHI, NOW)).toBeNull();
    expect(taskDueFrom('next Friday', CHI, NOW)).toBeNull();
    expect(taskDueFrom('2026-10-01', CHI, NOW)).toBeNull();
    expect(taskDueFrom('2028-01-01', CHI, NOW)).toBeNull();
    // Earlier today still reads: it's due now.
    expect(taskDueFrom('2026-11-04', CHI, NOW)?.allDay).toBe(true);
  });
});

describe('the scripted reader', () => {
  it('makes a task of each promise in the new messages, named for the customer', () => {
    const p = prompt([
      { who: 'Dale Owner (team)', words: 'I’ll call you back Monday.' },
      { who: 'Customer', words: 'Can you come out this week?' },
      {
        who: 'Dale Owner (team)',
        words: 'Yes, I’ll swing by Friday at 10. I’ll send the quote tonight.',
        isNew: true,
      },
    ]);
    expect(scriptedConversationTasks(p)).toEqual({
      tasks: [
        { title: 'Visit Mike', notes: null, due: '2026-11-06T10:00' },
        { title: 'Send Mike the quote', notes: null, due: '2026-11-04' },
      ],
    });
    // The earlier line promised too, but it isn't new; and a line that promises nothing makes nothing.
    expect(
      scriptedConversationTasks(
        prompt([{ who: 'Dale Owner (team)', words: 'Thanks!', isNew: true }]),
      ),
    ).toEqual({ tasks: [] });
  });

  it('reads a quick yes to the customer’s ask as a task, due whenever', () => {
    const p = prompt([
      { who: 'Customer', words: 'Can you check if the part came in?' },
      { who: 'Dale Owner (team)', words: 'Will do!', isNew: true },
    ]);
    expect(scriptedConversationTasks(p)).toEqual({
      tasks: [{ title: 'Do what they asked for Mike', notes: null, due: null }],
    });
  });
});
