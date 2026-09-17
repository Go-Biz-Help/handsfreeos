/**
 * Which adapter reads which CRM. The engine asks this and nothing else, so adding HubSpot is a file next to
 * GoHighLevel's plus one line here — and a change anywhere else would mean the seam has leaked.
 */
import type { CrmSourceAdapter } from '@hfos/core/server';
import { createFakeSourceAdapter, type FakeSource } from './fake';
import { createGoHighLevelAdapter, type GoHighLevelConfig } from './gohighlevel';

export interface MigrationAdapters {
  get(system: string): CrmSourceAdapter | undefined;
  readonly systems: readonly string[];
  /** The stand-in's own data, for local development and the tests. Null when the real adapter is in use. */
  readonly fake: FakeSource | null;
}

export interface AdapterConfig {
  /** Off locally and in tests: every source is then the stand-in, so nothing reaches a real account. */
  readonly live: boolean;
  readonly goHighLevel: GoHighLevelConfig;
}

export function createMigrationAdapters(config: AdapterConfig): MigrationAdapters {
  if (!config.live) {
    const fake = createFakeSourceAdapter();
    // The stand-in answers for every source, so a spec can migrate "from GoHighLevel" with no account.
    return {
      get: () => fake.adapter,
      systems: ['gohighlevel'],
      fake,
    };
  }
  const byName = new Map<string, CrmSourceAdapter>([
    ['gohighlevel', createGoHighLevelAdapter(config.goHighLevel)],
  ]);
  return { get: (s) => byName.get(s), systems: [...byName.keys()], fake: null };
}
