/**
 * Social Outreach reads the business's small facts once for a query (src/addons/outreach/ops/common.ts, `readOnce`):
 * its settings and its playbooks, however many parts of the query ask. A command reads them each time it asks, since
 * it may have just changed them.
 */
import { describe, expect, it } from 'vitest';
import { readOnce, type Ctx } from '../../src/addons/outreach/ops/common';

const query = () => ({ tx: {}, scope: { workspaceId: 'w' } }) as unknown as Ctx;
const command = () => ({ ...query(), emit: () => undefined }) as unknown as Ctx;

describe('a small fact of the business', () => {
  it('is read once for a query, each fact its own, and again for the next query', async () => {
    let reads = 0;
    const read = async () => ++reads;
    const first = query();
    expect(
      await Promise.all([readOnce(first, 'settings', read), readOnce(first, 'settings', read)]),
    ).toEqual([1, 1]);
    expect(await readOnce(first, 'settings', read)).toBe(1);
    expect(await readOnce(first, 'playbooks', read)).toBe(2);
    expect(await readOnce(query(), 'settings', read)).toBe(3);
  });

  it('is read every time a command asks', async () => {
    let reads = 0;
    const read = async () => ++reads;
    const saving = command();
    expect(await readOnce(saving, 'settings', read)).toBe(1);
    expect(await readOnce(saving, 'settings', read)).toBe(2);
  });
});
