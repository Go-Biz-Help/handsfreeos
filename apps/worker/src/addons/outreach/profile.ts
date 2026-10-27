/**
 * Your profile, checked by the AI (docs/outreach.md, decision 64; packages/core/src/addons/outreach/profile-check.ts):
 * the person's extension read their own Facebook profile and sends what it read here (`outreach.profile.check`); the
 * AI scores it against the checklist with the business's live main offer beside it, and only its answer is kept, on
 * the person's setup row (`outreach.profile.check_save`). What the page said goes no further than this call, but the
 * parts shown side by side (decision 84). It counts against the business's daily AI limit like any other use.
 *
 * The whole profile (decision 84): the AI also has the business's name, the person's own name, the playbooks that run
 * on the network, the person's other profiles as their last checks read them, and what they've said they want of each
 * part, so it can say how the profile comes across, whether it's about the work they offer, and what clashes. Show me
 * more (`outreach.profile.more`) writes three more of one part, with the person's note.
 */
import { PLATFORM_KEYS, type Platform } from '@hfos/core/addons/outreach/networks';
import { FOR_CUSTOMERS } from '@hfos/core/addons/outreach/ops/common';
import {
  PlaybookDetails,
  runsOn,
  upgradePlaybookDetails,
} from '@hfos/core/addons/outreach/playbooks';
import { profileCheckSave, profileMoreSave } from '@hfos/core/addons/outreach/ops/readiness';
import {
  checkedProfileCheck,
  PROFILE_CHECK_MAX_TOKENS,
  profileCheckAsk,
  profileCheckPrompt,
  profileCheckSystem,
  ProfileCheck,
  ProfileRead,
  withHandles,
  type ProfileContext,
} from '@hfos/core/addons/outreach/profile-check';
import {
  checkedMore,
  moreNamesRefused,
  noteOf,
  PROFILE_MORE_MAX_TOKENS,
  PROFILE_MORE_SCHEMA,
  PROFILE_MORE_SYSTEM,
  ProfileMoreAnswer,
  ProfileMoreInput,
  profileMorePrompt,
  partWritten,
  type ProfileMoreOutput,
} from '@hfos/core/addons/outreach/profile-parts';
import { namesGoneBy } from '@hfos/core';
import { executeCommand, HfosError } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { askStructured } from '../../ai/ask';
import type { AddonWorkerAction } from '../types';
import { aiFailure, liveMainOffer } from './assist';

export const PROFILE_CHECK_ACTION = 'outreach.profile.check';
export const PROFILE_MORE_ACTION = 'outreach.profile.more';

type Ctx = Parameters<AddonWorkerAction['run']>[0];

/**
 * What the check goes by beside the page (decision 84): the business's name, the person's other profiles as their last
 * checks read them, and their notes; and the network's own last check.
 */
async function profileContext(
  ctx: Ctx,
  platform: Platform,
): Promise<{ readonly context: ProfileContext; readonly before: ProfileCheck | null }> {
  const ws = ctx.scope.workspaceId!;
  const { business, you, row, kept } = await asWorker(ctx.db, ctx.scope, async (tx) => {
    const [b] = await rows<{ name: string; names: string[] | null }>(
      tx,
      sql`select w.name, o.names from app.workspaces w
          left join app.main_offers o on o.workspace_id = w.id
          where w.id = ${ws}`,
    );
    const [u] = await rows<{ full_name: string | null }>(
      tx,
      sql`select full_name from app.users where id = ${ctx.userId}`,
    );
    const [r] = await rows<{ profile_check: unknown; network_profiles: unknown }>(
      tx,
      sql`select profile_check, network_profiles from addon_outreach.setup
          where workspace_id = ${ws} and user_id = ${ctx.userId}`,
    );
    const p = await rows<{ name: string; details: unknown }>(
      tx,
      sql`select name, details from addon_outreach.playbooks
          where workspace_id = ${ws} and archived_at is null and ${FOR_CUSTOMERS} order by created_at`,
    );
    return { business: b, you: u, row: r, kept: p };
  });
  // The playbooks that run on this network, for whether the profile is about the work they offer there.
  const playbooks = kept.flatMap((p) => {
    const read = PlaybookDetails.safeParse(upgradePlaybookDetails(p.details));
    return read.success && runsOn(read.data, platform)
      ? [
          {
            name: p.name,
            offer: read.data.offer,
            audience: read.data.audience,
            niche: read.data.niche ?? null,
          },
        ]
      : [];
  });
  const others = (row?.network_profiles ?? {}) as Record<string, { check?: unknown } | undefined>;
  const checkOn = (p: Platform): ProfileCheck | null =>
    ProfileCheck.safeParse(p === 'facebook' ? row?.profile_check : others[p]?.check).data ?? null;
  const before = checkOn(platform);
  return {
    context: {
      // Every name the business goes by (the main offer's), else its name in HandsFreeOS.
      business: business
        ? namesGoneBy(business.names ?? [], business.name).join('; ') || null
        : null,
      you: you?.full_name?.trim() || null,
      playbooks,
      others: PLATFORM_KEYS.filter((p) => p !== platform).flatMap((p) => {
        const seen = checkOn(p)?.seen;
        return seen ? [{ platform: p, seen }] : [];
      }),
      notes: before?.notes ?? {},
    },
    before,
  };
}

export const profileCheck: AddonWorkerAction<ProfileRead> = {
  permission: 'outreach.use',
  input: ProfileRead,
  async run(ctx, raw): Promise<ProfileCheck> {
    // Its username and links, worked out where the extension didn't say them (decision 84).
    const read = withHandles(ProfileRead.parse(raw));
    const [live, { context }] = await Promise.all([
      liveMainOffer(ctx),
      profileContext(ctx, read.platform),
    ]);
    let check: ProfileCheck;
    // Each network's own checklist (decision 80): LinkedIn's has its headline and its whole About, Instagram's its
    // name and link.
    try {
      const { value } = await askStructured(ctx, ctx.scope, {
        system: profileCheckSystem(read.platform),
        messages: [
          {
            role: 'user' as const,
            content: profileCheckPrompt(read, live?.offer ?? null, context),
          },
        ],
        maxTokens: PROFILE_CHECK_MAX_TOKENS[read.platform],
        usage: { source: 'addon' as const, addonId: ctx.manifest.id },
        ...profileCheckAsk(read.platform),
      });
      check = checkedProfileCheck(value, read, new Date().toISOString(), live?.version ?? null);
    } catch (e) {
      throw aiFailure(e);
    }
    const { output } = await executeCommand(
      ctx.db,
      profileCheckSave,
      { workspaceId: ctx.scope.workspaceId, userId: ctx.userId, platform: read.platform, check },
      ctx.actor,
      ctx.meta,
    );
    // As kept: with the person's notes, and what their computer found of usernames, carried over (decision 84).
    return output.profileCheck ?? check;
  },
};

/**
 * Show me more (decision 84): three more of one part of the person's own profile (its bio, name, username, cover line,
 * or the whole About again), unlike what was written before and following what they said they want. Kept on their
 * check with their note, which the next check follows too. Each person's own.
 */
export const profileMore: AddonWorkerAction<ProfileMoreInput> = {
  permission: 'outreach.use',
  ai: {
    tool: 'outreach_more_profile_options',
    description:
      "More options from the AI for one part of the person's own profile on a network (its bio, name, username, cover line and the rest), with their note on what they want and chips for quick asks. The options are kept for them to pick from in Get ready; nothing goes on the profile until they ask their computer to put one in (outreach_ask_computer, kind profile_edit).",
    autonomy: 'auto',
    keywords: ['more bio options', 'rewrite my bio', 'profile ideas'],
  },
  input: ProfileMoreInput,
  async run(ctx, raw): Promise<ProfileMoreOutput> {
    const input = ProfileMoreInput.parse(raw);
    const [live, { context, before: check }] = await Promise.all([
      liveMainOffer(ctx),
      profileContext(ctx, input.platform),
    ]);
    if (!check)
      throw HfosError.rule(
        'outreach_profile_not_read',
        409,
        'Your profile hasn’t been read yet. Press Read my profile first, then ask for more.',
      );
    const note = noteOf(input.chips, input.note);
    const before = partWritten(check, input.part);
    let wrote: string[];
    let options: string[];
    try {
      const { value } = await askStructured(ctx, ctx.scope, {
        system: PROFILE_MORE_SYSTEM,
        messages: [
          {
            role: 'user' as const,
            content: profileMorePrompt({
              platform: input.platform,
              part: input.part,
              offer: live?.offer ?? null,
              business: context.business,
              you: context.you ?? null,
              seen: check.seen ?? null,
              before,
              notes: [...(check.notes?.[input.part] ?? []), ...(note ? [note] : [])],
            }),
          },
        ],
        schema: PROFILE_MORE_SCHEMA,
        zod: ProfileMoreAnswer,
        maxTokens: PROFILE_MORE_MAX_TOKENS,
        usage: { source: 'addon' as const, addonId: ctx.manifest.id },
      });
      wrote = value.options;
      options = checkedMore(input.platform, input.part, wrote, before);
    } catch (e) {
      throw aiFailure(e);
    }
    // Only names the network won't take (Facebook's name standards): what to change, not to try again later.
    const refused =
      !options.length && input.part === 'name'
        ? moreNamesRefused(input.platform, wrote, input.chips)
        : null;
    if (refused) throw HfosError.rule('outreach_name_not_taken', 422, refused);
    if (!options.length)
      throw HfosError.rule(
        'ai_failed',
        502,
        'The AI couldn’t write new ones just now. Try again in a minute, or type your own.',
      );
    const { output: kept } = await executeCommand(
      ctx.db,
      profileMoreSave,
      {
        workspaceId: ctx.scope.workspaceId!,
        userId: ctx.userId,
        platform: input.platform,
        part: input.part,
        options,
        note,
      },
      ctx.actor,
      ctx.meta,
    );
    return { options, check: kept };
  },
};
