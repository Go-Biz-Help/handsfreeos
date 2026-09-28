/**
 * Add-ons in words: every state and move has its words, and every check the database runs after a move
 * (private.addon_verify) has a line a person can read. Pure: it reads the migration, as other file checks do.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ADDON_CHECK_WORDS,
  ADDON_MOVE_WORDS,
  ADDON_STATE_WORDS,
  INSTALLATION_STATES,
  LIFECYCLE_ACTIONS,
  addonCheckWords,
} from '../../src/index';

const MIGRATIONS = resolve(__dirname, '../../../../supabase/migrations');

/** Every check name private.addon_verify can return, as its latest definition writes them. */
function verifyCheckNames(): string[] {
  const files = readdirSync(MIGRATIONS).sort();
  const source = files
    .map((f) => readFileSync(join(MIGRATIONS, f), 'utf8'))
    .filter((s) => s.includes('function private.addon_verify('))
    .at(-1)!;
  const body = source.slice(source.indexOf('function private.addon_verify('));
  const end = body.indexOf('$$;', body.indexOf('as $$') + 5);
  return [...new Set([...body.slice(0, end).matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]!))];
}

describe('add-on words', () => {
  it('name every state and every move', () => {
    for (const s of INSTALLATION_STATES)
      expect(ADDON_STATE_WORDS[s].label.length).toBeGreaterThan(0);
    for (const a of LIFECYCLE_ACTIONS) expect(ADDON_MOVE_WORDS[a].button.length).toBeGreaterThan(0);
    // Every move that takes something away asks first, and says what it takes.
    for (const a of ['disable', 'uninstall', 'purge'] as const) {
      expect(ADDON_MOVE_WORDS[a].confirm?.('Pool Service')).toContain('Pool Service');
      expect(ADDON_MOVE_WORDS[a].consequence).toBeTruthy();
    }
  });

  it('have a line for every check the database runs after a move', () => {
    const names = verifyCheckNames();
    expect(names.length).toBeGreaterThan(10);
    for (const name of names) expect(ADDON_CHECK_WORDS[name], name).toBeTruthy();
    expect(addonCheckWords('something_new')).toBe(
      'Something it left behind is still being cleared up.',
    );
  });
});
