/**
 * __NAME__'s manifest and operations, held to the add-on rules (docs/addon-architecture.md). Pure: no database.
 */
import { describe, expect, it } from 'vitest';
import { addonModuleIssues, commands, manifestIssues, queries } from '../../src/server';
import { __CONST__ } from '../../src/addons/__ID__/manifest';
import { __CONST__Server } from '../../src/addons/__ID__/server';

describe('__NAME__', () => {
  it('has a valid manifest', () => {
    expect(manifestIssues(__CONST__)).toEqual([]);
  });

  it('joins core’s operations cleanly', () => {
    const core = {
      commands: commands.filter((c) => c.addon?.id !== '__ID__'),
      queries: queries.filter((q) => q.addon?.id !== '__ID__'),
    };
    expect(addonModuleIssues(core, [__CONST__Server])).toEqual([]);
  });
});
