/**
 * The person menu's own operations (../person-menu.ts, docs/outreach.md decision 91): **Mark as client** and **Not a
 * client after all** (`outreach.client.set`), and where someone stands as the menu opens (`outreach.profile.marks`).
 * A client is core's (crm/clients.ts): the Client tag on their customer in Contacts, put on and taken off through
 * core's `record.set_tags`, so Contacts, Search and Social Outreach agree. Nothing of it is kept here.
 */
import { and, eq, sql } from 'drizzle-orm';
import { rows } from '@hfos/db/client';
import { recordSetTags } from '../../../commands/record.set_tags';
import { CLIENT_TAG } from '../../../crm/record-words';
import { HfosError } from '../../../errors';
import { requireHuman } from '../../../kernel/actor';
import { executeCommandWithin, scopeCan } from '../../../kernel/execute';
import type { Permission } from '../../../permissions';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import { outreachAddon } from '../manifest';
import {
  CLIENT_SKIPPED_KINDS,
  ClientSetInput,
  ClientSetOutput,
  mayTakeOff,
  ProfileMarksInput,
  ProfileMarksOutput,
} from '../person-menu';
import { profiles } from '../tables';
import { OUTREACH_WORDS } from '../words';
import {
  clientOf,
  clientProfiles,
  dontPitchOf,
  inWorkspace,
  neverContactOf,
  once,
  partnered,
  saveProfile,
  skipOutreachTo,
  tagIdsFor,
  type Ctx,
  type Profile,
} from './common';

const P = OUTREACH_WORDS.person;

/** The profile the menu is for, or the refusal profile.contact gives when it's gone. */
async function menuProfile(ctx: Ctx, profileId: string): Promise<Profile> {
  const [profile] = await ctx.tx
    .select()
    .from(profiles)
    .where(and(eq(profiles.workspaceId, ctx.scope.workspaceId!), eq(profiles.id, profileId)));
  if (!profile)
    throw HfosError.notFound(
      'That person isn’t kept in Social Outreach any more. Refresh the page.',
    );
  return profile;
}

/** The Client tags on a customer, any capitals: what Not a client after all takes off. Never makes one. */
async function clientTagsOn(ctx: Ctx, personId: string): Promise<string[]> {
  const found = await rows<{ id: string }>(
    ctx.tx,
    sql`select tg.id from app.record_tags rt join app.tags tg on tg.id = rt.tag_id
        where rt.workspace_id = ${ctx.scope.workspaceId!} and rt.record_type = 'person'
          and rt.record_id = ${personId} and lower(tg.name::text) = lower(${CLIENT_TAG})`,
  );
  return found.map((f) => f.id);
}

export const clientSet = defineAddonCommand(outreachAddon, {
  name: 'outreach.client.set',
  description:
    'Mark someone the person reached as a client: they’re added to Contacts if they aren’t there (or tied to the customer named), the Client tag goes on their customer, and anyone’s outreach messages to them waiting for an OK are skipped; nothing on Today reaches them again but a reply. Or take the Client tag off again (Not a client after all); Contacts may still count them a client for another reason, which is said.',
  risk: 1,
  input: ClientSetInput,
  output: ClientSetOutput,
  permission: 'outreach.use',
  ai: {
    tool: 'outreach_mark_client',
    autonomy: 'confirm',
    keywords: ['client', 'mark as client', 'customer'],
  },
  scope: inWorkspace,
  emits: ['outreach.client.marked', 'outreach.send.skipped', 'outreach.profile.saved'],
  async handler(ctx, input) {
    requireHuman(ctx);
    const ws = ctx.scope.workspaceId!;
    let profile = await menuProfile(ctx, input.profileId);
    // A client is a tag in Contacts: the person needs to add and edit customers there.
    if (!scopeCan(ctx.scope, 'records.write' as Permission))
      throw HfosError.forbidden(
        P.clientNeedsContacts(profile.name),
        'outreach_client_needs_contacts',
      );
    return once(async () => {
      let addedPerson = false;
      let skipped = 0;
      if (input.client) {
        // Not in Contacts yet: added, or tied to the customer the person said they are (Add to Contacts' way).
        let personId = profile.personId;
        if (!personId) {
          const saved = await saveProfile(ctx, {
            platform: profile.platform,
            profile: { id: profile.platformId, username: profile.username, url: profile.url },
            name: profile.name,
            ...(input.personId ? { personId: input.personId } : {}),
          });
          addedPerson = saved.addedPerson;
          await ctx.emit({
            type: 'outreach.profile.saved',
            entityType: 'person',
            entityId: saved.personId,
            payload: {
              platform: profile.platform,
              profileId: saved.profileId,
              addedPerson: saved.addedPerson,
            },
          });
          personId = saved.personId;
          profile = await menuProfile(ctx, saved.profileId);
        }
        await executeCommandWithin(ctx, recordSetTags, {
          workspaceId: ws,
          recordType: 'person',
          recordId: personId,
          tagIds: await tagIdsFor(ctx, [CLIENT_TAG]),
          mode: 'add',
        });
        // Their outreach waiting, anyone's, on every profile the client rule now covers: replies and a partner's stay.
        skipped = await skipOutreachTo(
          ctx,
          await clientProfiles(ctx, personId),
          CLIENT_SKIPPED_KINDS,
        );
      } else if (profile.personId) {
        // Only the tag comes off, when it's on: Contacts' own reasons stay, and nothing skipped comes back.
        const on = await clientTagsOn(ctx, profile.personId);
        if (on.length)
          await executeCommandWithin(ctx, recordSetTags, {
            workspaceId: ws,
            recordType: 'person',
            recordId: profile.personId,
            tagIds: on,
            mode: 'remove',
          });
      }
      const standing = await clientOf(ctx, profile.id);
      await ctx.emit({
        type: 'outreach.client.marked',
        entityType: 'outreach_profile',
        entityId: profile.id,
        payload: {
          platform: profile.platform,
          personId: profile.personId,
          client: standing.on,
          tagged: standing.tagged,
          skipped,
        },
      });
      return {
        profileId: profile.id,
        personId: profile.personId,
        client: standing.on,
        tagged: standing.tagged,
        because: standing.because,
        addedPerson,
        skipped,
      };
    });
  },
});

export const profileMarks = defineAddonQuery(outreachAddon, {
  name: 'outreach.profile.marks',
  description:
    'Where someone the person reached stands, as their person menu shows it: in Contacts or not, a client (and why), a partner, a demo booked, on Don’t pitch or Never contact (and who put them on), and whether the person may take them off.',
  input: ProfileMarksInput,
  output: ProfileMarksOutput,
  permission: 'outreach.use',
  ai: {
    tool: 'outreach_person_marks',
    keywords: ['is a client', 'dont pitch', 'never contact', 'in contacts', 'demo booked'],
  },
  scope: inWorkspace,
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const profile = await menuProfile(ctx, input.profileId);
    const [facts] = await rows<{ name: string; partner: boolean; demo_booked: boolean }>(
      ctx.tx,
      sql`select coalesce(nullif(btrim(pp.first_name || ' ' || pp.last_name), ''), p.name) as name,
            ${partnered('p')} as partner,
            exists (select 1 from addon_outreach.demos d where d.profile_id = p.id and d.user_id = ${me}
              and d.how = 'marked' and d.undone_at is null) as demo_booked
          from addon_outreach.profiles p
          left join app.people pp on pp.id = p.person_id
          where p.id = ${profile.id}`,
    );
    const manages = scopeCan(ctx.scope, 'outreach.manage' as Permission);
    return {
      profileId: profile.id,
      name: facts?.name ?? profile.name,
      platform: profile.platform,
      url: profile.url,
      personId: profile.personId,
      partner: facts?.partner ?? false,
      demoBooked: facts?.demo_booked ?? false,
      client: await clientOf(ctx, profile.id),
      dontPitch: await dontPitchOf(ctx, profile),
      neverContact: await neverContactOf(ctx, profile),
      // Only this profile's own mark comes off here (`outreach.friend.set`), and only by whoever put it on, or an owner
      // or admin: a twin's, or the Friend or family tag, is said instead.
      canTakeOff: {
        dontPitch: profile.dontPitch && mayTakeOff(profile.dontPitchBy, me, manages),
        neverContact: profile.neverContact && mayTakeOff(profile.neverContactBy, me, manages),
      },
    };
  },
});

export const personMenuCommands = [clientSet] as const;
export const personMenuQueries = [profileMarks] as const;
