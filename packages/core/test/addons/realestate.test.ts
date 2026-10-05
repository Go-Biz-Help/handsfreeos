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

  it('keeps only files its phone rows hold, and says which aren’t current', () => {
    const offline = realestateAddon.offline;
    const broken = {
      ...realestateAddon,
      offline: {
        ...offline,
        files: [
          { table: 'documents', column: 'file_name' },
          { table: 'documents', column: 'file_id', skip: { column: 'state', values: ['void'] } },
          { table: 'nowhere', column: 'file_id' },
        ],
      },
    };
    expect(manifestIssues(broken).map((i) => i.message)).toEqual([
      `offline files of "documents" name "file_name", which it doesn't keep`,
      `offline files of "documents" skip by "state", which it doesn't keep`,
      `offline files come from "nowhere", which isn't one of its offline tables`,
    ]);
  });

  it('joins core’s operations cleanly', () => {
    const core = {
      commands: commands.filter((c) => c.addon?.id !== 'realestate'),
      queries: queries.filter((q) => q.addon?.id !== 'realestate'),
    };
    expect(addonModuleIssues(core, [realestateAddonServer])).toEqual([]);
  });

  it('declares every event its commands emit, and only those', () => {
    const emitted = (realestateAddonServer.commands ?? [])
      .flatMap((c) => c.emits)
      .filter((e) => e.startsWith('realestate.'));
    expect([...new Set(emitted)].sort()).toEqual([...(realestateAddon.events?.emits ?? [])].sort());
  });

  it('offers the AI only what it may use', () => {
    expect(addonAiIssues([realestateAddonServer])).toEqual([]);
  });
});
