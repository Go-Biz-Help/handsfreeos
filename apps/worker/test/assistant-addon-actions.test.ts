import { toolInputSchema } from '@hfos/core/server';
import { describe, expect, it } from 'vitest';
import { ADDON_WORKER_MODULES } from '../src/addons/modules';
import { addonActionIssues, allAddonActionTools } from '../src/assistant/tools-addons';

/**
 * The add-ons' worker actions in the Assistant (docs/addon-architecture.md, "The AI sees only what it may use"): every
 * button a person presses that the worker answers is a tool, and only what a browser extension asks for isn't. Pure:
 * no database.
 */

/** Worker actions only an add-on's browser extension asks for, with what it read: never the Assistant's. */
const EXTENSION_ONLY = new Set([
  // Social Outreach: the person's own profile as the extension read it, a post to like, a group's join questions.
  'outreach.profile.check',
  'outreach.like.pick',
  'outreach.join.answer',
]);

const actions = ADDON_WORKER_MODULES.flatMap((m) =>
  Object.entries(m.actions ?? {}).map(([name, action]) => ({ name, action })),
);

describe('the add-ons’ worker actions as Assistant tools', () => {
  it('are all well formed: the add-on’s own names, one object each, none taken', () => {
    expect(addonActionIssues(ADDON_WORKER_MODULES)).toEqual([]);
    for (const tool of allAddonActionTools(ADDON_WORKER_MODULES))
      expect(() => toolInputSchema(tool), tool.name).not.toThrow();
  });

  it('cover every button a person presses, and nothing only an extension asks for', () => {
    const tools = new Set(allAddonActionTools(ADDON_WORKER_MODULES).map((t) => t.actionName));
    // A new action is the Assistant's unless it's on the list.
    expect(actions.filter((a) => !tools.has(a.name) && !EXTENSION_ONLY.has(a.name))).toEqual([]);
    expect(actions.filter((a) => EXTENSION_ONLY.has(a.name) && a.action.ai)).toEqual([]);
    expect([...EXTENSION_ONLY].filter((n) => !actions.some((a) => a.name === n))).toEqual([]);
  });

  it('ask first only for what reaches people', () => {
    expect(
      allAddonActionTools(ADDON_WORKER_MODULES)
        .filter((t) => t.autonomy === 'confirm')
        .map((t) => t.actionName),
    ).toEqual(['realestate.esign.remind']);
  });
});
