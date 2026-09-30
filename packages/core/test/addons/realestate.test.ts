/**
 * Real Estate Agent's manifest and operations, held to the add-on rules (docs/addon-architecture.md). Pure: no database.
 */
import { describe, expect, it } from 'vitest';
import {
  addonAiIssues,
  addonModuleIssues,
  commands,
  manifestIssues,
  queries,
} from '../../src/server';
import { realestateAddon } from '../../src/addons/realestate/manifest';
import { realestateAddonServer } from '../../src/addons/realestate/server';

describe('Real Estate Agent', () => {
  it('has a valid manifest', () => {
    expect(manifestIssues(realestateAddon)).toEqual([]);
  });

  it('joins core’s operations cleanly', () => {
    const core = {
      commands: commands.filter((c) => c.addon?.id !== 'realestate'),
      queries: queries.filter((q) => q.addon?.id !== 'realestate'),
    };
    expect(addonModuleIssues(core, [realestateAddonServer])).toEqual([]);
  });

  it('offers the AI only what it may use', () => {
    expect(addonAiIssues([realestateAddonServer])).toEqual([]);
  });
});
