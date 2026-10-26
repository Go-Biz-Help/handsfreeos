/**
 * The listing's description, step 4 (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round three: Listing core").
 * Chris decided (2026-10-01): the AI drafts it, with both fair housing checks; the agent edits it; the seller signs it
 * off in their portal.
 *
 * - **Versions.** Every draft and every save is its own version, kept as written. The one being worked on replaces
 *   the one before it; the one signed off stays in use until a newer one is signed.
 * - **Checks.** The fixed word list reads every version at once and the model a moment later, as a CMA's summary and
 *   a client update are. A flag is fixed by changing the words, or kept as written with a reason.
 * - **The seller's sign-off.** Sending makes a sign-off task in their portal with these exact words; refused until
 *   both checks have read them and every flag is fixed or kept. Signing it puts the description in use (S-19's
 *   proof). An owner or admin (Approve exceptions) can let it through without the portal, with a reason.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import { HfosError } from '../../../errors';
import { scopeCan } from '../../../kernel/execute';
import { changeMoment } from '../../../kernel/moment';
import type { CommandContext } from '../../../kernel/types';
import type { Permission } from '../../../permissions';
import { defineAddonCommand } from '../../server';
import { checkWords, FAIR_HOUSING_WORDS_VERSION, type FairHousingFlag } from '../fair-housing';
import { DESCRIPTION_WORKING, descriptionShape, type DescriptionRow } from '../listing-shape';
import { realestateAddon } from '../manifest';
import {
  ListingDescriptionAcknowledgeInput,
  ListingDescriptionCheckedInput,
  ListingDescriptionDraftedInput,
  ListingDescriptionLetThroughInput,
  ListingDescriptionOutput,
  ListingDescriptionRef,
  ListingDescriptionRequestInput,
  ListingDescriptionSaveInput,
} from '../schemas';
import { clientTasks, fairHousingChecks, listingDescriptions } from '../tables';
import { textHashOf } from './client-updates';
import {
  actorKind,
  actorUserId,
  dealClients,
  historyLine,
  inWorkspace,
  loadDeal,
  requireNotArchived,
  requireOpen,
  type Ctx,
  type Deal,
} from './common';
import { ensureListing, listingAddress, listingOf } from './listing';
import { addProof, PROOF_EVENTS } from './proof-hooks';

type Description = typeof listingDescriptions.$inferSelect;
type Check = typeof fairHousingChecks.$inferSelect;

async function loadDescription(
  ctx: Ctx,
  id: string,
  lock = false,
): Promise<{ d: Description; deal: Deal }> {
  const q = ctx.tx
    .select()
    .from(listingDescriptions)
    .where(
      and(
        eq(listingDescriptions.id, id),
        eq(listingDescriptions.workspaceId, ctx.scope.workspaceId!),
      ),
    );
  const [d] = lock ? await q.for('update') : await q;
  if (!d)
    throw HfosError.notFound(
      'That description isn’t on the listing anymore. Refresh to see the one being worked on.',
    );
  return { d, deal: await loadDeal(ctx, d.dealRecordId, { lock }) };
}

async function checksOf(ctx: Ctx, descriptionIds: readonly string[]): Promise<Check[]> {
  if (!descriptionIds.length) return [];
  return ctx.tx
    .select()
    .from(fairHousingChecks)
    .where(inArray(fairHousingChecks.descriptionId, [...descriptionIds]))
    .orderBy(desc(fairHousingChecks.checkedAt));
}

/** The checks of these words, and the flags they raise between them. */
function currentChecks(d: Description, checks: readonly Check[]) {
  const hash = textHashOf(null, d.words);
  const now = checks.filter((c) => c.descriptionId === d.id && c.textHash === hash);
  const words = now.find((c) => c.source === 'words') ?? null;
  const model = now.find((c) => c.source === 'model') ?? null;
  const flags: FairHousingFlag[] = [];
  const seen = new Set<string>();
  for (const c of [words, model])
    for (const f of (c?.flags ?? []) as FairHousingFlag[]) {
      if (seen.has(f.phrase.toLowerCase())) continue;
      seen.add(f.phrase.toLowerCase());
      flags.push(f);
    }
  return { hash, words, model, flags };
}

async function recordCheck(
  ctx: CommandContext,
  d: Description,
  check: {
    source: 'words' | 'model';
    version: string;
    status: 'passed' | 'flagged' | 'unavailable';
    flags: readonly FairHousingFlag[];
    textHash: string;
  },
) {
  await ctx.tx.insert(fairHousingChecks).values({
    workspaceId: d.workspaceId,
    dealRecordId: d.dealRecordId,
    descriptionId: d.id,
    source: check.source,
    version: check.version,
    status: check.flags.length ? 'flagged' : check.status === 'flagged' ? 'passed' : check.status,
    flags: [...check.flags],
    textHash: check.textHash,
  });
}

/** Why a description can't go to the seller yet, with its rule; null when it can. */
export function sendBlock(
  d: Description,
  checks: readonly Check[],
): { rule: string; words: string } | null {
  if (d.state === 'drafting')
    return {
      rule: 'realestate_description_drafting',
      words: 'The description is still being written. Try again in a moment.',
    };
  if (d.state === 'failed' || !d.words)
    return {
      rule: 'realestate_description_none',
      words: 'There are no words to send yet. Ask for a draft again, or write it yourself.',
    };
  if (d.state !== 'ready')
    return {
      rule: 'realestate_description_sent',
      words: `Version ${d.version} is already with the seller.`,
    };
  const now = currentChecks(d, checks);
  if (!now.words || !now.model)
    return {
      rule: 'realestate_check_running',
      words: 'The fair housing check is still reading the description. Try again in a moment.',
    };
  if (now.flags.length && !d.flagsAcknowledgedAt)
    return {
      rule: 'realestate_fair_housing_flags',
      words: `The description has words that could read as a preference about who should live there: ${now.flags
        .map((f) => `“${f.phrase}”`)
        .join(', ')}. Change them, or keep them with a reason.`,
    };
  return null;
}

/** The new version's number, with the ones it replaces set aside (and their sign-off taken back). */
async function nextVersion(ctx: CommandContext, deal: Deal): Promise<number> {
  const all = await ctx.tx
    .select({
      id: listingDescriptions.id,
      version: listingDescriptions.version,
      state: listingDescriptions.state,
      taskId: listingDescriptions.clientTaskId,
    })
    .from(listingDescriptions)
    .where(eq(listingDescriptions.dealRecordId, deal.recordId));
  const working = all.filter((d) => (DESCRIPTION_WORKING as readonly string[]).includes(d.state));
  for (const w of working) {
    await ctx.tx
      .update(listingDescriptions)
      .set({ state: 'replaced', updatedAt: new Date() })
      .where(eq(listingDescriptions.id, w.id));
    if (w.taskId)
      await ctx.tx
        .update(clientTasks)
        .set({
          status: 'canceled',
          canceledReason: 'A newer description replaced it.',
          updatedAt: new Date(),
        })
        .where(and(eq(clientTasks.id, w.taskId), eq(clientTasks.status, 'open')));
  }
  return Math.max(0, ...all.map((d) => d.version)) + 1;
}

/** A listing needs its confirmed facts before anything is written about it. */
async function requireFacts(ctx: Ctx, deal: Deal): Promise<void> {
  const l = await listingOf(ctx, deal.recordId);
  if (!l?.factsConfirmedAt)
    throw HfosError.rule(
      'realestate_listing_no_facts',
      409,
      'Confirm the home’s facts first: the description is written from them. Open Facts on the listing.',
    );
}

const out = (d: Description, flags: readonly FairHousingFlag[] = []) => ({
  descriptionId: d.id,
  version: d.version,
  state: d.state,
  flags: [...flags],
});

/** The description in use and the one being worked on, for the listing's view. */
export async function descriptionView(ctx: Ctx, deal: Deal) {
  const all = await ctx.tx
    .select()
    .from(listingDescriptions)
    .where(eq(listingDescriptions.dealRecordId, deal.recordId))
    .orderBy(desc(listingDescriptions.version));
  const shape = descriptionShape(all.map(descriptionRowOf));
  const working = shape.working ? all.find((d) => d.id === shape.working!.id)! : null;
  const checks = await checksOf(ctx, working ? [working.id] : []);
  const now = working ? currentChecks(working, checks) : null;
  return {
    ...shape,
    working:
      shape.working && working && now
        ? {
            ...shape.working,
            flags: now.flags,
            checked: { words: !!now.words, model: !!now.model },
            blocked: working.state === 'sent' ? null : sendBlock(working, checks),
          }
        : null,
  };
}

/** A version as the listing's page reads it (listing-shape.ts). */
const descriptionRowOf = (d: Description): DescriptionRow => ({
  id: d.id,
  version: d.version,
  words: d.words,
  source: d.source,
  state: d.state,
  failure: d.failure,
  signedAt: d.signedAt?.toISOString() ?? null,
  overrideReason: d.overrideReason,
  flagsAcknowledgedAt: d.flagsAcknowledgedAt?.toISOString() ?? null,
  flagsAcknowledgedReason: d.flagsAcknowledgedReason,
  sentAt: d.sentAt?.toISOString() ?? null,
  createdAt: d.createdAt.toISOString(),
});

/** Whether this person may let a description or a price through without the seller's sign-off. */
export const mayLetThrough = (ctx: Ctx): boolean =>
  ctx.actor.type === 'human' && scopeCan(ctx.scope, 'realestate.except' as Permission);

export function requireLetThrough(ctx: CommandContext, what: string): void {
  if (actorKind(ctx) !== 'person')
    throw HfosError.forbidden(
      `Only a person can let ${what} through without the seller’s sign-off, from the listing’s page.`,
    );
  if (!mayLetThrough(ctx))
    throw HfosError.forbidden(
      `Only an owner or admin (Approve exceptions) can let ${what} through without the seller’s sign-off. Ask one of them.`,
      'realestate_let_through_permission',
    );
}

/** The description signed off: in use from now, the one before it set aside, and S-19's proof. */
export async function signDescription(
  ctx: CommandContext,
  deal: Deal,
  d: Description,
  by: { personId: string } | { reason: string },
): Promise<void> {
  const at = changeMoment(ctx.meta);
  await ctx.tx
    .update(listingDescriptions)
    .set({ state: 'replaced', updatedAt: at })
    .where(
      and(
        eq(listingDescriptions.dealRecordId, deal.recordId),
        eq(listingDescriptions.state, 'signed'),
      ),
    );
  await ctx.tx
    .update(listingDescriptions)
    .set({
      state: 'signed',
      signedAt: at,
      updatedAt: at,
      ...('personId' in by
        ? { signedByPersonId: by.personId }
        : { overrideBy: actorUserId(ctx), overrideReason: by.reason }),
    })
    .where(eq(listingDescriptions.id, d.id));
  await historyLine(ctx, deal, 'description_signed', {
    after: { version: d.version, how: 'personId' in by ? 'portal' : 'let_through' },
    note: 'reason' in by ? by.reason : null,
  });
  // S-19 "Create listing description": the signed-off words are its record.
  await addProof(
    ctx,
    deal,
    { keys: ['S-19'] },
    {
      kind: 'record',
      refKind: 'listing_description',
      refId: d.id,
      body: `The description, version ${d.version}, signed off`,
    },
  );
  await ctx.emit({
    type: 'realestate.listing.description_signed',
    entityType: 'realestate_deal',
    entityId: deal.recordId,
    payload: { descriptionId: d.id, version: d.version, letThrough: 'reason' in by },
  });
}

// ---------- commands ----------

export const descriptionRequest = defineAddonCommand(realestateAddon, {
  name: 'realestate.listing.description.request',
  description:
    'Ask the AI to draft a listing’s description from its confirmed facts, the agent’s notes and the seller’s own words, for the agent to check and edit. Replaces the one being worked on.',
  risk: 1,
  input: ListingDescriptionRequestInput,
  output: ListingDescriptionOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_draft_listing_description',
    description:
      'Draft a listing’s description from its confirmed facts, for the agent to check and send to the seller.',
  },
  emits: ['realestate.listing.description_requested'],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireOpen(deal);
    await ensureListing(ctx, deal);
    await requireFacts(ctx, deal);
    const version = await nextVersion(ctx, deal);
    const [d] = await ctx.tx
      .insert(listingDescriptions)
      .values({
        workspaceId: deal.workspaceId,
        dealRecordId: deal.recordId,
        version,
        source: 'ai',
        state: 'drafting',
        createdBy: actorUserId(ctx),
      })
      .returning();
    await ctx.emit({
      type: 'realestate.listing.description_requested',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { descriptionId: d!.id },
      broadcast: false,
    });
    return out(d!);
  },
});

export const descriptionDrafted = defineAddonCommand(realestateAddon, {
  name: 'realestate.listing.description.drafted',
  description:
    'Real Estate Agent’s own: the AI’s draft of a listing’s description and its first fair housing checks, or why it couldn’t be written.',
  risk: 0,
  input: ListingDescriptionDraftedInput,
  output: ListingDescriptionOutput,
  permission: null,
  actors: ['system'],
  scope: inWorkspace,
  emits: ['realestate.listing.description_ready'],
  async handler(ctx, input) {
    const { d, deal } = await loadDescription(ctx, input.descriptionId, true);
    if (d.state !== 'drafting') return out(d);
    const failed = !input.words?.trim();
    const [next] = await ctx.tx
      .update(listingDescriptions)
      .set(
        failed
          ? {
              state: 'failed',
              failure:
                input.failure?.slice(0, 500) ||
                'The description couldn’t be written. Ask for it again, or write it yourself.',
              updatedAt: new Date(),
            }
          : {
              state: 'ready',
              words: input.words!.trim().slice(0, 2000),
              model: input.model ?? null,
              updatedAt: new Date(),
            },
      )
      .where(eq(listingDescriptions.id, d.id))
      .returning();
    if (!failed) {
      const hash = textHashOf(null, next!.words);
      for (const c of input.checks) await recordCheck(ctx, next!, { ...c, textHash: hash });
    }
    await ctx.emit({
      type: 'realestate.listing.description_ready',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { descriptionId: d.id, failed },
      broadcast: false,
    });
    return out(next!);
  },
});

export const descriptionSave = defineAddonCommand(realestateAddon, {
  name: 'realestate.listing.description.save',
  description:
    'Save the agent’s own words for a listing’s description as a new version. The fixed list reads them at once and the model a moment later; any flag kept on an earlier version doesn’t carry over.',
  risk: 1,
  input: ListingDescriptionSaveInput,
  output: ListingDescriptionOutput,
  permission: 'realestate.use',
  ai: { tool: 'realestate_listing_description_save' },
  scope: inWorkspace,
  emits: ['realestate.listing.description_saved'],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireOpen(deal);
    await ensureListing(ctx, deal);
    const version = await nextVersion(ctx, deal);
    const [d] = await ctx.tx
      .insert(listingDescriptions)
      .values({
        workspaceId: deal.workspaceId,
        dealRecordId: deal.recordId,
        version,
        words: input.words,
        source: 'person',
        state: 'ready',
        createdBy: actorUserId(ctx),
      })
      .returning();
    const flags = checkWords(input.words);
    await recordCheck(ctx, d!, {
      source: 'words',
      version: FAIR_HOUSING_WORDS_VERSION,
      status: 'passed',
      flags,
      textHash: textHashOf(null, input.words),
    });
    await ctx.emit({
      type: 'realestate.listing.description_saved',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { descriptionId: d!.id },
      broadcast: false,
    });
    return out(d!, flags);
  },
});

export const descriptionChecked = defineAddonCommand(realestateAddon, {
  name: 'realestate.listing.description.checked',
  description:
    'Real Estate Agent’s own: the model’s fair housing check of a listing description’s words.',
  risk: 0,
  input: ListingDescriptionCheckedInput,
  output: ListingDescriptionOutput,
  permission: null,
  actors: ['system'],
  scope: inWorkspace,
  emits: [],
  async handler(ctx, input) {
    const { d } = await loadDescription(ctx, input.descriptionId, true);
    if (d.state === 'ready' && textHashOf(null, d.words) === input.textHash)
      await recordCheck(ctx, d, {
        source: 'model',
        version: input.version,
        status: input.status,
        flags: input.flags,
        textHash: input.textHash,
      });
    return out(d);
  },
});

export const descriptionAcknowledgeFlags = defineAddonCommand(realestateAddon, {
  name: 'realestate.listing.description.acknowledge_flags',
  description:
    'Keep a listing description’s fair housing flags as written, with the reason. Kept with that version; a new version asks again.',
  risk: 1,
  input: ListingDescriptionAcknowledgeInput,
  output: ListingDescriptionOutput,
  permission: 'realestate.use',
  ai: { tool: 'realestate_listing_description_acknowledge_flags', autonomy: 'confirm' },
  scope: inWorkspace,
  emits: ['realestate.listing.description_flags_kept'],
  async handler(ctx, input) {
    if (actorKind(ctx) !== 'person')
      throw HfosError.forbidden(
        'Only a person keeps fair housing flags as written, from the description’s page.',
      );
    const { d, deal } = await loadDescription(ctx, input.descriptionId, true);
    requireNotArchived(deal);
    if (d.state !== 'ready') return out(d);
    const now = currentChecks(d, await checksOf(ctx, [d.id]));
    if (!now.flags.length) return out(d);
    const at = changeMoment(ctx.meta);
    const [next] = await ctx.tx
      .update(listingDescriptions)
      .set({
        flagsAcknowledgedAt: at,
        flagsAcknowledgedBy: actorUserId(ctx),
        flagsAcknowledgedReason: input.reason,
        updatedAt: at,
      })
      .where(eq(listingDescriptions.id, d.id))
      .returning();
    await historyLine(ctx, deal, 'fair_housing_confirmed', {
      after: { descriptionId: d.id, phrases: now.flags.map((f) => f.phrase) },
      note: input.reason,
    });
    await ctx.emit({
      type: 'realestate.listing.description_flags_kept',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: {
        descriptionId: d.id,
        phrases: now.flags.map((f) => f.phrase),
        reason: input.reason,
      },
    });
    return out(next!, now.flags);
  },
});

export const descriptionSend = defineAddonCommand(realestateAddon, {
  name: 'realestate.listing.description.send',
  description:
    'Send a listing’s description to the seller to sign off in their portal, with its exact words. Refused until both fair housing checks have read it and every flag is fixed or kept with a reason.',
  risk: 2,
  input: ListingDescriptionRef,
  output: ListingDescriptionOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_send_listing_description',
    description:
      'Send a checked listing description to the seller to sign off in their portal. Always asks the person first.',
  },
  emits: ['realestate.listing.description_sent', 'realestate.client_task.added'],
  async handler(ctx, input) {
    const { d, deal } = await loadDescription(ctx, input.descriptionId, true);
    requireOpen(deal);
    if (d.state === 'sent') return out(d);
    const blocked = sendBlock(d, await checksOf(ctx, [d.id]));
    if (blocked) throw HfosError.rule(blocked.rule, 409, blocked.words);
    const sellers = await dealClients(ctx, deal.recordId);
    if (!sellers.length)
      throw HfosError.rule(
        'realestate_no_client',
        409,
        `${deal.name} has no seller on it yet. Add the seller under People on the deal, then send it.`,
      );
    const address = (await listingAddress(ctx, deal)) ?? deal.name;
    const [task] = await ctx.tx
      .insert(clientTasks)
      .values({
        workspaceId: deal.workspaceId,
        dealRecordId: deal.recordId,
        kind: 'sign_off',
        title: 'Sign off your listing’s description',
        detail: `These are the words for ${address.split(',')[0]} on the MLS, your listing’s page and the flyer.`,
        signOffWords: d.words!,
        refKind: 'listing_description',
        refId: d.id,
        createdBy: actorUserId(ctx),
      })
      .returning({ id: clientTasks.id });
    const at = changeMoment(ctx.meta);
    const [next] = await ctx.tx
      .update(listingDescriptions)
      .set({
        state: 'sent',
        clientTaskId: task!.id,
        sentBy: actorUserId(ctx),
        sentAt: at,
        updatedAt: at,
      })
      .where(eq(listingDescriptions.id, d.id))
      .returning();
    await historyLine(ctx, deal, 'description_sent', { after: { version: d.version } });
    await ctx.emit({
      type: 'realestate.client_task.added',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { taskId: task!.id, kind: 'sign_off' },
    });
    await ctx.emit({
      type: 'realestate.listing.description_sent',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { descriptionId: d.id, version: d.version, taskId: task!.id },
    });
    return out(next!);
  },
});

export const descriptionLetThrough = defineAddonCommand(realestateAddon, {
  name: 'realestate.listing.description.let_through',
  description:
    'Put a checked listing description in use without the seller’s sign-off in the portal, with the reason (“signed on paper at the office”). Owners and admins only; kept on the deal’s history.',
  risk: 2,
  input: ListingDescriptionLetThroughInput,
  output: ListingDescriptionOutput,
  permission: 'realestate.use',
  ai: { tool: 'realestate_listing_description_let_through', autonomy: 'confirm' },
  scope: inWorkspace,
  emits: ['realestate.listing.description_signed', ...PROOF_EVENTS],
  async handler(ctx, input) {
    requireLetThrough(ctx, 'a description');
    const { d, deal } = await loadDescription(ctx, input.descriptionId, true);
    requireOpen(deal);
    if (d.state === 'signed') return out(d);
    // The checks still count: only the seller's own sign-off is passed over.
    if (d.state !== 'sent') {
      const blocked = sendBlock(d, await checksOf(ctx, [d.id]));
      if (blocked) throw HfosError.rule(blocked.rule, 409, blocked.words);
    }
    if (d.clientTaskId)
      await ctx.tx
        .update(clientTasks)
        .set({
          status: 'canceled',
          canceledReason: `Let through without the portal: ${input.reason}`.slice(0, 500),
          updatedAt: new Date(),
        })
        .where(and(eq(clientTasks.id, d.clientTaskId), eq(clientTasks.status, 'open')));
    await signDescription(ctx, deal, d, { reason: input.reason });
    const { d: next } = await loadDescription(ctx, d.id);
    return out(next);
  },
});

/** The seller signed a description's sign-off in their portal (client-tasks' completeTask, once it's done). */
export async function descriptionSignedOff(
  ctx: CommandContext,
  deal: Deal,
  descriptionId: string,
  personId: string,
): Promise<void> {
  const { d } = await loadDescription(ctx, descriptionId, true);
  if (d.state !== 'sent') return;
  await signDescription(ctx, deal, d, { personId });
}

export const descriptionCommands = [
  descriptionRequest,
  descriptionDrafted,
  descriptionSave,
  descriptionChecked,
  descriptionAcknowledgeFlags,
  descriptionSend,
  descriptionLetThrough,
] as const;
