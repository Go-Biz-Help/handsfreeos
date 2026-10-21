/**
 * __NAME__'s manifest and operations, held to the add-on rules (docs/addon-architecture.md). Pure: no database.
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

  it('offers the AI only what it may use', () => {
    expect(addonAiIssues([__CONST__Server])).toEqual([]);
  });

  it('answers searches only as core runs them', () => {
    expect(addonSearchIssues([__CONST__Server])).toEqual([]);
  });
});
