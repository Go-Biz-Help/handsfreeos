/**
 * AI Social Media Content Creator's manifest and operations, held to the add-on rules (docs/addon-architecture.md). Pure: no database.
 */
import { describe, expect, it } from 'vitest';
import {
  addonAiIssues,
  addonModuleIssues,
  addonSearchIssues,
  commands,
  manifestIssues,
  queries,
} from '../../src/server';
import { socialcontentAddon } from '../../src/addons/socialcontent/manifest';
import { socialcontentAddonServer } from '../../src/addons/socialcontent/server';

describe('AI Social Media Content Creator', () => {
  it('has a valid manifest', () => {
    expect(manifestIssues(socialcontentAddon)).toEqual([]);
  });

  it('joins core’s operations cleanly', () => {
    const core = {
      commands: commands.filter((c) => c.addon?.id !== 'socialcontent'),
      queries: queries.filter((q) => q.addon?.id !== 'socialcontent'),
    };
    expect(addonModuleIssues(core, [socialcontentAddonServer])).toEqual([]);
  });

  it('offers the AI only what it may use', () => {
    expect(addonAiIssues([socialcontentAddonServer])).toEqual([]);
  });

  it('answers searches only as core runs them', () => {
    expect(addonSearchIssues([socialcontentAddonServer])).toEqual([]);
  });
});
