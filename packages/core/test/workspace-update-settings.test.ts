/**
 * `workspace.update` needs only workspace.update, so the parts of the settings that have a command of their own —
 * with its own permission and checks — are refused there. Otherwise someone kept from channels.manage could still
 * show every member every conversation, and someone kept from money.manage could move the invoice numbering back.
 */
import { describe, expect, it } from 'vitest';
import { SETTINGS_WITH_THEIR_OWN_COMMAND, WorkspaceUpdateInput } from '../src';

const workspaceId = '00000000-0000-4000-8000-000000000001';

describe('workspace.update settings', () => {
  it('refuses every setting that has its own command', () => {
    for (const key of Object.keys(SETTINGS_WITH_THEIR_OWN_COMMAND)) {
      const parsed = WorkspaceUpdateInput.safeParse({ workspaceId, settings: { [key]: {} } });
      expect(parsed.success, key).toBe(false);
      expect(parsed.error?.issues.map((i) => i.path.join('.'))).toContain(`settings.${key}`);
    }
  });

  it('refuses the inbox switch alongside an ordinary setting', () => {
    const parsed = WorkspaceUpdateInput.safeParse({
      workspaceId,
      settings: { website: 'https://lonestarhvac.test', inbox: { perPerson: false } },
    });
    expect(parsed.success).toBe(false);
  });

  it('still saves the business’s own details', () => {
    const parsed = WorkspaceUpdateInput.safeParse({
      workspaceId,
      settings: {
        website: 'https://lonestarhvac.test',
        links: { review: 'https://g.page/r/lone-star/review' },
        openHours: [{ day: 1, start: '08:00', end: '17:00' }],
      },
    });
    expect(parsed.success).toBe(true);
  });
});
