import { describeOutreach, loadOutreachNames, NO_OUTREACH_NAMES } from '../describe-outreach';
import type { SqlRunner } from '../outbox';

/** Social Outreach's changes in Changes on this phone (decision 44): who a message is to, from the phone's copy. */

const A = '00000000-0000-4000-8000-000000000001';
const B = '00000000-0000-4000-8000-000000000002';

describe('Social Outreach’s changes, in words', () => {
  it('names who a message OK’d or skipped is to', async () => {
    const runner = {
      getAll: jest.fn(async () => [
        { id: `sends:${A}`, data: JSON.stringify({ name: 'Dana Reyes' }) },
      ]),
    } as unknown as SqlRunner;
    const names = await loadOutreachNames(runner, [{ sends: [{ sendId: A }] }, { sendId: B }]);
    expect(
      describeOutreach('outreach.send.approve', { sends: [{ sendId: A }] }, names)?.title,
    ).toBe('OK’d message to Dana Reyes');
    expect(
      describeOutreach(
        'outreach.send.approve',
        { sends: [{ sendId: A, text: 'Hi Dana!' }] },
        names,
      ),
    ).toMatchObject({ title: 'Changed and OK’d message to Dana Reyes', quote: 'Hi Dana!' });
    expect(describeOutreach('outreach.send.skip', { sendId: B }, names)?.title).toBe(
      'Skipped a message',
    );
    expect(
      describeOutreach('outreach.send.approve', { sends: [{ sendId: A }, { sendId: B }] }, names)
        ?.title,
    ).toBe('OK’d 2 messages');
  });

  it('says the day pressed, and leaves other add-ons’ changes alone', () => {
    expect(describeOutreach('outreach.day.start', {}, NO_OUTREACH_NAMES)?.title).toBe(
      'Start my day',
    );
    expect(describeOutreach('outreach.day.stop', {}, NO_OUTREACH_NAMES)?.heldUntil).toBe(
      'stop for today goes through',
    );
    expect(describeOutreach('realestate.duty.done', {}, NO_OUTREACH_NAMES)).toBeNull();
  });
});
