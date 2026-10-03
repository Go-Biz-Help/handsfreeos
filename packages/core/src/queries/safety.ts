/** A person's own safety contacts and open check-in, and what a teammate they asked to be told sees (round six). */
import { rows, sql } from '@hfos/db/client';
import { defineQuery } from '../kernel/define';
import { requireHuman } from '../kernel/actor';
import { contactStatus, SAFETY_DEFAULTS } from '../safety';
import {
  SafetyAlertOutput,
  SafetyCheckInRef,
  SafetyMineInput,
  SafetyMineOutput,
  SafetySettingsGetInput,
  SafetySettingsView,
} from '../schemas/safety';

const iso = (v: Date | string) => new Date(v).toISOString();

export const safetyMine = defineQuery({
  name: 'safety.mine',
  description: 'Your safety contacts here, and your check-in if one is open.',
  input: SafetyMineInput,
  output: SafetyMineOutput,
  permission: 'workspace.read',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    requireHuman(ctx);
    const [contacts, open] = await Promise.all([
      rows<{
        id: string;
        contact_user_id: string | null;
        name: string;
        phone_e164: string | null;
        email: string | null;
        agreed_at: string | null;
        stopped_at: string | null;
      }>(
        ctx.tx,
        sql`select id, contact_user_id, name, phone_e164, email, agreed_at, stopped_at
            from app.safety_contacts where workspace_id = ${input.workspaceId}::uuid
            order by position, created_at`,
      ),
      rows<{
        id: string;
        appointment_id: string | null;
        place: string;
        started_at: string;
        planned_end_at: string;
        state: 'in' | 'asked' | 'alerted' | 'ok' | 'out' | 'help';
        extended_count: number;
      }>(
        ctx.tx,
        sql`select id, appointment_id, place, started_at, planned_end_at, state, extended_count
            from app.safety_checkins where workspace_id = ${input.workspaceId}::uuid
              and state in ('in', 'asked', 'alerted', 'help')
            order by started_at desc limit 1`,
      ),
    ]);
    const o = open[0];
    return {
      contacts: contacts.map((c) => ({
        id: c.id,
        contactUserId: c.contact_user_id,
        name: c.name,
        phone: c.phone_e164,
        email: c.email,
        status: contactStatus({
          teammate: !!c.contact_user_id,
          agreed: !!c.agreed_at,
          stopped: !!c.stopped_at,
        }),
      })),
      open: o
        ? {
            id: o.id,
            appointmentId: o.appointment_id,
            place: o.place,
            startedAt: iso(o.started_at),
            plannedEndAt: iso(o.planned_end_at),
            state: o.state,
            extendedCount: o.extended_count,
          }
        : null,
    };
  },
});

export const safetyAlert = defineQuery({
  name: 'safety.alert',
  description:
    'For a teammate someone asked to be told: where they were when they missed their check-out, and how to reach them, while it’s yours to answer.',
  input: SafetyCheckInRef,
  output: SafetyAlertOutput,
  permission: 'workspace.read',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    requireHuman(ctx);
    const [a] = await rows<{
      id: string;
      person_name: string;
      person_phone: string | null;
      place: string;
      latitude: string | null;
      longitude: string | null;
      located_at: string | null;
      started_at: string;
      planned_end_at: string;
      state: 'alerted' | 'help';
    }>(
      ctx.tx,
      sql`select * from private.safety_checkin_for_contact(${input.workspaceId}::uuid, ${input.checkInId}::uuid)`,
    );
    return {
      alert: a
        ? {
            checkInId: a.id,
            personName: a.person_name,
            personPhone: a.person_phone,
            place: a.place,
            latitude: a.latitude === null ? null : Number(a.latitude),
            longitude: a.longitude === null ? null : Number(a.longitude),
            locatedAt: a.located_at ? iso(a.located_at) : null,
            startedAt: iso(a.started_at),
            plannedEndAt: iso(a.planned_end_at),
            state: a.state,
          }
        : null,
    };
  },
});

/** Settings → Safety, read by everyone in the business: the phone says when it asks and when it tells. */
export const safetySettings = defineQuery({
  name: 'safety.settings',
  description:
    'How long after a planned end the person is asked, how long before their contacts are told, and who’s told when someone has no contacts.',
  input: SafetySettingsGetInput,
  output: SafetySettingsView,
  permission: 'workspace.read',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    const [w] = await rows<{ safety: Record<string, unknown> | null }>(
      ctx.tx,
      sql`select settings -> 'safety' as safety from app.workspaces where id = ${input.workspaceId}::uuid`,
    );
    const s = w?.safety ?? {};
    const n = (k: 'askAfterMinutes' | 'alertAfterMinutes') =>
      Number.isInteger(s[k]) ? (s[k] as number) : SAFETY_DEFAULTS[k];
    const safetyUserId = typeof s['safetyUserId'] === 'string' ? s['safetyUserId'] : null;
    const [person] = safetyUserId
      ? await rows<{ name: string }>(
          ctx.tx,
          sql`select coalesce(nullif(trim(full_name), ''), email::text) as name from app.users
              where id = ${safetyUserId}::uuid`,
        )
      : [];
    return {
      askAfterMinutes: n('askAfterMinutes'),
      alertAfterMinutes: n('alertAfterMinutes'),
      safetyUserId,
      safetyPersonName: person?.name ?? null,
    };
  },
});

export const safetyQueries = [safetyMine, safetyAlert, safetySettings];
