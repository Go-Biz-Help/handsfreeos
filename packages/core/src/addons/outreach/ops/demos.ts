/**
 * Demos booked (../demos.ts, docs/outreach.md decision 24): through the person's demo link, which the worker hears of
 * from core's booking (`outreach.demo.note`), or marked by the person on someone's profile (`outreach.demo.mark`).
 * One a booking, and one mark a person reached; a mark taken back is kept, not counted. Nobody goes in Contacts: the booking already made them a customer.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { requireHuman } from '../../../kernel/actor';
import { changeMoment } from '../../../kernel/moment';
import { defineAddonCommand } from '../../server';
import {
  DemoMarkInput,
  DemoMarkOutput,
  DemoNoteInput,
  DemoNoteOutput,
  readDemoRef,
} from '../demos';
import { outreachAddon } from '../manifest';
import { demos, profiles } from '../tables';
import { inWorkspace, once } from './common';
import { profileToSet } from './friends';
import { wantLead } from './leads';
import { claimProfile } from './owners';

export const demoMark = defineAddonCommand(outreachAddon, {
  name: 'outreach.demo.mark',
  description:
    'The person says someone they reached booked a demo some other way than the demo link, or takes that back. It counts toward which openers work.',
  risk: 0,
  input: DemoMarkInput,
  output: DemoMarkOutput,
  permission: 'outreach.use',
  ai: {
    tool: 'outreach_mark_demo',
    keywords: ['demo booked', 'booked a call'],
  },
  scope: inWorkspace,
  emits: ['outreach.demo.marked', 'outreach.lead.wanted'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const at = changeMoment(ctx.meta);
    return once(async () => {
      const profile = await profileToSet(ctx, input, me, at);
      // Taken back, a mark is kept and no longer counted; marked again, it counts from now.
      if (input.booked)
        await ctx.tx
          .insert(demos)
          .values({ workspaceId: ws, userId: me, profileId: profile.id, how: 'marked', at })
          .onConflictDoUpdate({
            target: [demos.workspaceId, demos.userId, demos.profileId],
            targetWhere: sql`how = 'marked'`,
            set: { at, undoneAt: null },
            setWhere: sql`${demos.undoneAt} is not null`,
          });
      else
        await ctx.tx
          .update(demos)
          .set({ undoneAt: at })
          .where(
            and(
              eq(demos.workspaceId, ws),
              eq(demos.userId, me),
              eq(demos.profileId, profile.id),
              eq(demos.how, 'marked'),
              isNull(demos.undoneAt),
            ),
          );
      await ctx.emit({
        type: 'outreach.demo.marked',
        entityType: 'outreach_profile',
        entityId: profile.id,
        payload: { booked: input.booked },
      });
      if (input.booked) {
        await claimProfile(ctx, me, profile.id, changeMoment(ctx.meta));
        await wantLead(ctx, me, profile.id);
      }
      return { profileId: profile.id, booked: input.booked };
    });
  },
});

export const demoNote = defineAddonCommand(outreachAddon, {
  name: 'outreach.demo.note',
  description:
    'Worker: someone booked through a person’s demo link (the booking’s ref names who sent it to whom): it counts as a demo, once a booking.',
  risk: 0,
  input: DemoNoteInput,
  output: DemoNoteOutput,
  permission: 'outreach.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: ['outreach.demo.booked', 'outreach.lead.wanted'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const named = readDemoRef(input.ref);
    if (!named) return { counted: false };
    const [profile] = await ctx.tx
      .select({ id: profiles.id })
      .from(profiles)
      .where(and(eq(profiles.workspaceId, ws), eq(profiles.id, named.profileId)));
    // Whoever sent it still does outreach here: a link from someone who left, or made up, names nobody.
    const [member] = await rows<{ ok: boolean }>(
      ctx.tx,
      sql`select true as ok from app.workspace_access
          where workspace_id = ${ws} and user_id = ${named.userId}
            and 'outreach.use' = any (permissions)`,
    );
    if (!profile || !member) return { counted: false };
    const [row] = await ctx.tx
      .insert(demos)
      .values({
        workspaceId: ws,
        userId: named.userId,
        profileId: profile.id,
        how: 'link',
        appointmentId: input.appointmentId,
        personId: input.personId,
        at: new Date(input.at),
      })
      .onConflictDoNothing()
      .returning({ id: demos.id });
    if (!row) return { counted: false };
    await ctx.emit({
      type: 'outreach.demo.booked',
      entityType: 'outreach_profile',
      entityId: profile.id,
      payload: { userId: named.userId, appointmentId: input.appointmentId },
    });
    // A demo booked through their link reaches them (decision 107).
    await claimProfile(ctx, named.userId, profile.id, new Date(input.at));
    await wantLead(ctx, named.userId, profile.id);
    return { counted: true };
  },
});

export const demoCommands = [demoMark, demoNote] as const;
