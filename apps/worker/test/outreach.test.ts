/**
 * Social Outreach in the worker (docs/outreach.md): data version 2 brings a playbook saved before its questions had
 * answers, and before it had a pace, into today's shape when a reinstall brings it back; version 3 gives one saved
 * before it had a niche, problem, proof and something useful to send those, empty. Run as the worker runs it.
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

describe('Social Outreach’s data versions 2 to 7', () => {
  it('gives an older playbook’s questions answers, a pace, follow-ups and empty newer parts, and leaves today’s alone', async () => {
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
      pace: { messageAfterDays: 2, followUps: 5, followUpGaps: [1, 1, 2, 3, 5] },
      niche: 'Roofers with 2 to 3 crews',
      problem: null,
      proof: [],
      usefulWhat: null,
      usefulLink: null,
      videoLink: null,
      videoScript: null,
      partnerKinds: ['group_admin', 'creator', 'business'],
      onItsNetworks: true,
    });
    // A partner playbook saved before version 7 kept to its own networks already (decision 81).
    const partners = { ...before, goal: 'partner' };
    const [old, current, partner] = await rows<{ id: string }>(
      admin(),
      sql`insert into addon_outreach.playbooks (workspace_id, name, details)
          values (${ws}, 'Old', ${JSON.stringify(before)}::jsonb),
                 (${ws}, 'Current', ${JSON.stringify(today)}::jsonb),
                 (${ws}, 'Partners', ${JSON.stringify(partners)}::jsonb)
          returning id`,
    );

    for (const v of [2, 3, 4, 5, 6, 7]) {
      const step = outreachAddonWorker.dataMigrations![v]!;
      await asWorker(testDbs().worker.db, { workspaceId: ws }, (tx) =>
        step({ tx, scope: { workspaceId: ws } } as unknown as Parameters<AddonDataMigration>[0]),
      );
    }

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
      pace: { messageAfterDays: 1, followUps: 6, followUpGaps: [1, 1, 1, 2, 2, 2] },
      niche: null,
      proof: [],
      usefulLink: null,
      videoLink: null,
      videoScript: null,
      partnerKinds: ['group_admin', 'creator', 'business'],
      // It ran on every network that worked before version 7, and runs on those now.
      platforms: ['facebook', 'linkedin'],
      onItsNetworks: true,
    });
    expect(PlaybookDetails.parse(got(partner!.id).details)).toMatchObject({
      platforms: ['facebook'],
      onItsNetworks: true,
    });
    expect(got(current!.id)).toMatchObject({ details: today, updated: false });
  });
});
