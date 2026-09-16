/**
 * What the scenarios need in the database, made fresh for each file: a business with its owner (Dale), an admin
 * (Priya) and a member (Marco), a customer, and — for texting — a business number the carriers have approved.
 * People and the business come through the API like the web; what a real carrier or calendar would have set up is
 * written straight to the database, as the core suites do.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { type RunningApi, WebUser } from './api';

export const TZ = 'America/Chicago';
export const admin = () => testDbs().admin.db;

export interface Business {
  readonly workspaceId: string;
  readonly organizationId: string;
  readonly dale: TestUser;
  readonly priya: TestUser;
  readonly marco: TestUser;
  /** Each of them on the web. */
  readonly web: { readonly dale: WebUser; readonly priya: WebUser; readonly marco: WebUser };
}

export async function makeBusiness(api: RunningApi, label: string): Promise<Business> {
  const [dale, priya, marco] = await Promise.all([
    createTestUser(`${label}-dale`, { fullName: 'Dale Owner' }),
    createTestUser(`${label}-priya`, { fullName: 'Priya Admin' }),
    createTestUser(`${label}-marco`, { fullName: 'Marco Member' }),
  ]);
  const web = {
    dale: new WebUser(api, dale),
    priya: new WebUser(api, priya),
    marco: new WebUser(api, marco),
  };
  const created = await web.dale.command<{ organizationId: string; workspaceId: string }>(
    'organization.create',
    { businessName: `${label} HVAC`, timezone: TZ },
  );
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role)
        values (${created.workspaceId}, ${priya.id}, 'admin'), (${created.workspaceId}, ${marco.id}, 'member')`,
  );
  return { ...created, dale, priya, marco, web };
}

/** A customer, added on the web. */
export async function customer(
  b: Business,
  details: Record<string, unknown> = {},
): Promise<string> {
  const out = await b.web.dale.command<{ personId: string }>('person.create', {
    workspaceId: b.workspaceId,
    firstName: 'Maria',
    lastName: 'Lopez',
    ignoreDuplicates: true,
    ...details,
  });
  return out.personId;
}

let numbers = 0;

/** A toll-free number the carriers approved (the stand-in carrier), and quiet hours off, so texts go at any hour. */
export async function canText(b: Business): Promise<void> {
  const tag = randomUUID().slice(0, 8);
  const [account] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.telephony_accounts (workspace_id, provider, account_sid, status)
        values (${b.workspaceId}, 'fake', ${`ACsync${tag}`}, 'active') returning id`,
  );
  const e164 = `+1833${String(5550000 + ((Date.now() + numbers++) % 4_000_000)).padStart(7, '0')}`;
  const [number] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.phone_numbers (workspace_id, account_id, provider_sid, e164, number_type, status)
        values (${b.workspaceId}, ${account!.id}, ${`PNsync${tag}`}, ${e164}, 'toll_free', 'active') returning id`,
  );
  await rows(
    admin(),
    sql`insert into app.telephony_registrations (workspace_id, account_id, phone_number_id, kind, status, provider_sid, approved_at)
        values (${b.workspaceId}, ${account!.id}, ${number!.id}, 'toll_free_verification', 'approved', ${`HHsync${tag}`}, now())`,
  );
  await b.web.dale.command('phone.update_settings', {
    workspaceId: b.workspaceId,
    quietHours: { enabled: false, start: '20:00', end: '08:00' },
  });
}
