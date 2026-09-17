/// <reference types="node" />
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { AppSchema } from '../app-schema';

/**
 * The phone's schema is generated from the sync streams and the types the phone's contract records
 * (scripts/mobile-schema.mjs). The app's lint runs its check; these prove the check fails when it should.
 */

const ROOT = resolve(__dirname, '../../../../..');
const SCRIPT = join(ROOT, 'scripts/mobile-schema.mjs');
const CONFIG = join(ROOT, 'apps/sync/sync-config.yaml');
const CONTRACT = join(ROOT, 'packages/core/test/contract/mobile-contract.json');
const PEOPLE = /^( {6}- SELECT id, workspace_id, company_id, first_name.*)$/m;

let scratch: string;
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'hfos-mobile-schema-'));
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Runs the check, optionally against changed copies of the streams and the contract. */
function check(
  edit?: (config: string) => string,
  editContract?: (tables: Record<string, unknown>) => Record<string, unknown>,
) {
  const args = [SCRIPT, '--check'];
  const name = Math.random().toString(36).slice(2);
  if (edit) {
    const config = join(scratch, `sync-config-${name}.yaml`);
    writeFileSync(config, edit(readFileSync(CONFIG, 'utf8')));
    args.push('--config', config);
  }
  if (editContract) {
    const recorded = JSON.parse(readFileSync(CONTRACT, 'utf8')) as {
      tables: Record<string, unknown>;
    };
    const contract = join(scratch, `contract-${name}.json`);
    writeFileSync(contract, JSON.stringify({ ...recorded, tables: editContract(recorded.tables) }));
    args.push('--contract', contract);
  }
  const run = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' });
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

/** A table's columns and the SQLite type PowerSync gives each. */
const typesOf = (name: string) =>
  Object.fromEntries(
    AppSchema.tables.find((t) => t.name === name)!.columns.map((c) => [c.name, c.type]),
  );

describe('the phone’s schema', () => {
  it('matches the sync streams and the contract', () => {
    const run = check();
    expect(run.output).toContain('matches the sync streams and the contract');
    expect(run.status).toBe(0);
  });

  it('is out of date when a stream changes what it sends', () => {
    const run = check((config) => config.replace(PEOPLE, (line) => line.replace(' notes,', '')));
    expect(run.status).toBe(1);
    expect(run.output).toContain('apps/mobile/src/sync/schema.ts is out of date');
  });

  it('fails for a column the contract hasn’t recorded, before any phone could get it', () => {
    const run = check((config) =>
      config.replace(PEOPLE, (line) => line.replace(' notes,', ' notes, import_row,')),
    );
    expect(run.status).toBe(1);
    expect(run.output).toContain("business_v1.people.import_row isn't in the phone's contract yet");
  });

  it('refuses a synced table named for one of the app’s own', () => {
    const run = check(
      (config) => config.replace('AS my_profile', 'AS outbox'),
      (tables) => ({ ...tables, 'me_v1.outbox': tables['me_v1.my_profile'] }),
    );
    expect(run.status).toBe(1);
    expect(run.output).toContain(
      'A stream fills "outbox", a name the app keeps for its own local table.',
    );
  });

  it('types each column as PowerSync does, and leaves room for the app’s own tables', () => {
    expect(() => AppSchema.validate()).not.toThrow();
    const names = AppSchema.tables.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(['people', 'workspace_access', 'invoices', 'users']),
    );
    expect(names).not.toContain('commands');
    expect(names).not.toContain('outbox');
    const people = typesOf('people');
    expect(people).toMatchObject({
      phone_e164: 'TEXT',
      archived_at: 'TEXT',
      field_times: 'TEXT',
      possible_duplicate_of: 'TEXT',
    });
    expect(typesOf('invoices')).toMatchObject({
      total_cents: 'INTEGER',
      amount_paid_cents: 'INTEGER',
    });
    expect(typesOf('appointment_attendees')).toMatchObject({ sms_ok: 'INTEGER', seats: 'INTEGER' });
    expect(typesOf('estimate_lines')).toMatchObject({ quantity: 'TEXT' });
    // Generated columns never sync, so the phone works them out (compute.ts).
    expect(people).not.toHaveProperty('search_text');
    expect(typesOf('invoices')).not.toHaveProperty('balance_cents');
    expect(AppSchema.tables.find((t) => t.name === 'people')!.indexes.map((i) => i.name)).toEqual([
      'workspace',
    ]);
  });
});
