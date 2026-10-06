/**
 * Social Outreach in the worker (docs/outreach.md): data version 2 brings a playbook saved before its questions had
 * answers, and before it had a pace, into today's shape when a reinstall brings it back. Run as the worker runs it.
 */
import { PlaybookDetails } from '@hfos/core/addons/outreach/playbooks';
import { asWorker, rows, sql } from '@hfos/db/client';
import { bootstrapOrganization, closeTestDbs, createTestUser, testDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { outreachAddonWorker } from '../src/addons/outreach';
import type { AddonDataMigration } from '../src/addons/types';

const admin = () => testDbs().admin.db;
let ws: string;

beforeAll(async () => {
  const owner = await createTestUser('outreach-worker');
  ({ wsId: ws } = await bootstrapOrganization(owner, 'Outreach Worker Co', 'Outreach Worker Co'));
  await rows(
    admin(),
    sql`insert into app.addon_installations (workspace_id, addon_id, state, installed_version, data_version)
        values (${ws}, 'outreach', 'installing', '0.1.0', 1)`,
  );
}, 60_000);

afterAll(closeTestDbs);

describe('Social Outreach’s data version 2', () => {
  it('gives an older playbook’s questions answers and a pace, and leaves today’s alone', async () => {
    const before = {
      goal: 'demo',
      offer: null,
      link: null,
      audience: null,
      signs: [],
      skip: [],
      area: null,
      platforms: ['facebook'],
      groupWords: [],
      steps: ['connect', 'message'],
      tone: null,
      samples: [],
      questions: ['Do you use a CRM?', 'Which one?'],
      avoid: [],
      disclaimer: null,
      tags: [],
    };
    const today = PlaybookDetails.parse({
      ...before,
      questions: [{ id: 'q1', text: 'Is it doing what you need?', answers: [] }],
      pace: { messageAfterDays: 2, followUpAfterDays: 5 },
    });
    const [old, current] = await rows<{ id: string }>(
      admin(),
      sql`insert into addon_outreach.playbooks (workspace_id, name, details)
          values (${ws}, 'Old', ${JSON.stringify(before)}::jsonb),
                 (${ws}, 'Current', ${JSON.stringify(today)}::jsonb)
          returning id`,
    );

    const step = outreachAddonWorker.dataMigrations![2]!;
    await asWorker(testDbs().worker.db, { workspaceId: ws }, (tx) =>
      step({ tx, scope: { workspaceId: ws } } as unknown as Parameters<AddonDataMigration>[0]),
    );

    const after = await rows<{ id: string; details: unknown; updated: boolean }>(
      admin(),
      sql`select id, details, updated_at > created_at as updated from addon_outreach.playbooks
          where workspace_id = ${ws}`,
    );
    const got = (id: string) => after.find((p) => p.id === id)!;
    expect(PlaybookDetails.parse(got(old!.id).details)).toMatchObject({
      questions: [
        { id: 'q1', text: 'Do you use a CRM?', answers: [] },
        { id: 'q2', text: 'Which one?', answers: [] },
      ],
      pace: { messageAfterDays: 1, followUpAfterDays: 3 },
    });
    expect(got(current!.id)).toMatchObject({ details: today, updated: false });
  });
});
