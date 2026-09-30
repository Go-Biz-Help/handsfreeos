import { rows, sql } from '@hfos/db/client';
import { requireHuman } from '../kernel/actor';
import { defineQuery } from '../kernel/define';
import { clientStanding } from '../onboarding/clients';
import { shapeOnboardingCounts, type OnboardingCountRow } from '../onboarding/counts';
import { loadBusinessSetup, loadOnboardingStatus } from '../onboarding/load';
import type { z } from 'zod';
import {
  type OnboardingClient,
  OnboardingClientsInput,
  OnboardingClientsOutput,
  OnboardingCountsInput,
  OnboardingCountsOutput,
  OnboardingStatusInput,
  OnboardingStatusOutput,
} from '../schemas/onboarding';

export const onboardingStatus = defineQuery({
  name: 'onboarding.status',
  description:
    'Where your Getting started guide stands in this business: each step in order, done, waiting on someone else, needing a fix, to do or skipped, with the counts, the next step and whether the guide shows on Home. Owners and admins get the business’s steps; teammates get their own short list. `device` adds what only the browser or the phone knows.',
  input: OnboardingStatusInput,
  output: OnboardingStatusOutput,
  permission: 'workspace.read',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  handler: (ctx, input) => loadOnboardingStatus(ctx, input.workspaceId, input.device),
});

export const onboardingClients = defineQuery({
  name: 'onboarding.clients',
  description:
    'For an agency: each client business and how far it has got setting up (Getting started’s business steps): the count, stuck, setting up or done and why, its steps, its owner and when they last signed in, and whether a reminder went today.',
  input: OnboardingClientsInput,
  output: OnboardingClientsOutput,
  permission: 'org.templates.manage',
  scope: (i) => ({ kind: 'organization', organizationId: i.organizationId }),
  async handler(ctx, input) {
    const { userId } = requireHuman(ctx);
    const org = input.organizationId;
    // The organization's businesses its owners and admins work in, as account.me lists them.
    const list = await rows<{ id: string; name: string }>(
      ctx.tx,
      sql`select w.id, w.name from app.workspaces w
          where w.organization_id = ${org} and private.effective_workspace_role(w.id) is not null
          order by w.name`,
    );
    const ids = list.map((b) => b.id);
    const owners = ids.length
      ? await rows<{ workspace_id: string; full_name: string; email: string }>(
          ctx.tx,
          sql`select distinct on (m.workspace_id) m.workspace_id, u.full_name, u.email::text as email
              from app.workspace_memberships m join app.users u on u.id = m.user_id
              where m.role = 'owner'
                and m.workspace_id in (select w.id from app.workspaces w where w.organization_id = ${org})
                and not exists (select 1 from app.organization_memberships om
                                where om.organization_id = ${org} and om.user_id = m.user_id)
              order by m.workspace_id, m.created_at`,
        )
      : [];
    const reminded = ids.length
      ? await rows<{ workspace_id: string; at: Date | string }>(
          ctx.tx,
          sql`select workspace_id, max(created_at) as at from app.events
              where organization_id = ${org} and event_type = 'onboarding.remind_requested'
                and created_at > now() - interval '1 day'
              group by workspace_id`,
        )
      : [];
    const ownerOf = new Map(owners.map((o) => [o.workspace_id, o]));
    const remindedAt = new Map(reminded.map((r) => [r.workspace_id, new Date(r.at).toISOString()]));
    const now = new Date();
    const businesses: z.infer<typeof OnboardingClient>[] = [];
    for (const b of list) {
      const setup = await loadBusinessSetup(ctx.tx, b.id, userId);
      if (!setup) continue;
      const owner = ownerOf.get(b.id);
      const standing = clientStanding({
        steps: setup.steps,
        enabled: setup.enabled,
        lastSignInAt: setup.lastSignInAt,
        now,
      });
      businesses.push({
        workspaceId: b.id,
        name: b.name,
        owner: owner ? { name: owner.full_name.trim() || owner.email, email: owner.email } : null,
        lastSignInAt: setup.lastSignInAt,
        enabled: setup.enabled,
        done: setup.done,
        total: setup.total,
        skipped: setup.skipped,
        ...standing,
        steps: [...setup.steps],
        remindedAt: remindedAt.get(b.id) ?? null,
      });
    }
    const count = (g: string) => businesses.filter((b) => b.group === g).length;
    return {
      organizationId: org,
      businesses,
      counts: {
        all: businesses.length,
        stuck: count('stuck'),
        setup: count('setup'),
        done: count('done'),
      },
    };
  },
});

/**
 * The admin side's Getting started page (plan §9): how many businesses start, which steps get skipped, and how many
 * finish, counted from the onboarding events across every business. Counts only; the page views through the
 * wizard are Matomo's.
 */
export const platformOnboardingCounts = defineQuery({
  name: 'platform.onboarding.counts',
  description:
    'How Getting started is going across every business: how many answered the quick questions, which steps they skip and bring back, how many finish, and how many add customers as they go. Counts only.',
  input: OnboardingCountsInput,
  output: OnboardingCountsOutput,
  permission: 'platform.businesses.read',
  scope: () => ({ kind: 'platform' as const }),
  async handler(ctx, input) {
    const since = new Date(Date.now() - input.days * 24 * 60 * 60_000);
    const counted = await rows<OnboardingCountRow>(
      ctx.tx,
      sql`select * from private.admin_onboarding_counts(${since.toISOString()}::timestamptz)`,
    );
    return shapeOnboardingCounts(counted, since);
  },
});
