/**
 * Who and what is around a deal (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Deals, properties and the people
 * around them"): the team on it and what each does there, the deal on the other side of the same home or the
 * client's other deal, its property, the outside parties (the business's own contacts), its commission, and
 * archiving it. The team rules are core's (custom_record.assign): the main agent adds and removes people, and
 * owners and admins do too and alone choose the main agent (Chris, 2026-09-30).
 */
import { and, eq, sql as dsql } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import {
  customRecordArchive,
  customRecordCreate,
  customRecordRestore,
} from '../../../commands/custom-record';
import { customRecordAssign, customRecordUnassign } from '../../../commands/custom-record-team';
import { relationshipCreate, relationshipDelete } from '../../../commands/relationship';
import { HfosError } from '../../../errors';
import { executeCommandWithin, scopeCan } from '../../../kernel/execute';
import type { CommandContext } from '../../../kernel/types';
import { money } from '../../../money/format';
import { defineAddonCommand } from '../../server';
import { commissionOf } from '../commission';
import { realestateAddon } from '../manifest';
import {
  DealAddPersonInput,
  DealArchiveInput,
  DealArchiveOutput,
  DealCommissionOutput,
  DealLinkInput,
  DealLinkOutput,
  DealRemovePersonInput,
  DealSetCommissionInput,
  DealSetFinalCommissionInput,
  DealSetPropertyInput,
  DealSetPropertyOutput,
  DealSetRoleInput,
  DealTeamOutput,
  DealUnlinkInput,
  PartyAddInput,
  PartyAddOutput,
  PartyRemoveInput,
  PartyRemoveOutput,
} from '../schemas';
import { dealLinks, dealRoles, deals } from '../tables';
import { moneyOf, type TermKey, type TermNow } from '../terms';
import {
  DEAL_LINK_KINDS,
  DEAL_ROLE_LABELS,
  PARTY_ROLES,
  PROPERTY_TYPE_KEY,
  partyTypeKey,
  type DealRole,
} from '../words';
import {
  dealLine,
  historyLine,
  inWorkspace,
  kindIds,
  loadDeal,
  mayChangeTeam,
  relationshipTypeId,
  requireNotArchived,
  rolesOf,
  userNames,
  type Ctx,
  type Deal,
} from './common';
import { applyFacts } from './deals';
import { openWork } from './engine';

// ---------- the team ----------

/** Everyone on the deal, its main agent first, with what each does there. */
export async function teamOf(ctx: Ctx, deal: Deal) {
  const roles = await rolesOf(ctx, deal);
  const ids = [deal.ownerUserId, ...deal.teamUserIds].filter((i): i is string => !!i);
  const names = await userNames(ctx, ids);
  return ids.map((id) => ({
    userId: id,
    name: names.get(id) ?? 'Former member',
    role: id === deal.ownerUserId ? 'agent' : (roles.get(id) ?? 'co_agent'),
    main: id === deal.ownerUserId,
  }));
}

async function setRole(ctx: CommandContext, deal: Deal, userId: string, role: DealRole) {
  await ctx.tx
    .insert(dealRoles)
    .values({ workspaceId: deal.workspaceId, dealRecordId: deal.recordId, userId, role })
    .onConflictDoUpdate({
      target: [dealRoles.dealRecordId, dealRoles.userId],
      set: { role, updatedAt: new Date() },
    });
}

const onDeal = (deal: Deal, userId: string) =>
  deal.ownerUserId === userId || deal.teamUserIds.includes(userId);

async function teamAnswer(ctx: CommandContext, dealId: string, changed: boolean, handed: number) {
  const after = await loadDeal(ctx, dealId);
  return { dealId, team: await teamOf(ctx, after), changed, dutiesHandedOver: handed };
}

export const dealAddPerson = defineAddonCommand(realestateAddon, {
  name: 'realestate.deal.add_person',
  description:
    'Put someone from the team on a deal as co-agent, coordinator or assistant: they see it and everything about it. The deal’s main agent does this, and so do owners and admins.',
  risk: 2,
  input: DealAddPersonInput,
  output: DealTeamOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: ['realestate.deal.team_changed'],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireNotArchived(deal);
    const was = await rolesOf(ctx, deal);
    await executeCommandWithin(ctx, customRecordAssign, {
      workspaceId: ctx.scope.workspaceId!,
      customRecordId: deal.recordId,
      userId: input.userId,
      main: false,
    });
    const after = await loadDeal(ctx, deal.recordId, { lock: true });
    const role: DealRole = after.ownerUserId === input.userId ? 'agent' : input.role;
    const changed = !onDeal(deal, input.userId) || (was.get(input.userId) ?? null) !== role;
    if (!changed) return teamAnswer(ctx, deal.recordId, false, 0);
    await setRole(ctx, after, input.userId, role);
    const w = await openWork(ctx, after);
    // A new coordinator takes the coordinator's duties the main agent held.
    if (role === 'coordinator' && after.ownerUserId) await w.handOver(after.ownerUserId);
    await w.settle();
    await historyLine(ctx, deal, 'team', { after: { added: input.userId, role } });
    const names = await userNames(ctx, [input.userId]);
    const name = names.get(input.userId) ?? 'someone';
    const eventId = await ctx.emit({
      type: 'realestate.deal.team_changed',
      entityType: 'custom_record',
      entityId: deal.recordId,
      payload: { name: deal.name, userId: input.userId, role },
      after: { name: deal.name, person: name, role: DEAL_ROLE_LABELS[role] },
    });
    await dealLine(
      ctx,
      deal,
      `put ${name} on this deal as ${DEAL_ROLE_LABELS[role].toLowerCase()}`,
      {
        eventId,
      },
    );
    return teamAnswer(ctx, deal.recordId, true, w.counts.handedOver);
  },
});

export const dealRemovePerson = defineAddonCommand(realestateAddon, {
  name: 'realestate.deal.remove_person',
  description:
    'Take someone off a deal. Their unfinished duties go to whoever their role now falls to. Only owners and admins take off the main agent; the next person on it becomes the main one.',
  risk: 2,
  input: DealRemovePersonInput,
  output: DealTeamOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: ['realestate.deal.team_changed'],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireNotArchived(deal);
    if (!onDeal(deal, input.userId)) return teamAnswer(ctx, deal.recordId, false, 0);
    await executeCommandWithin(ctx, customRecordUnassign, {
      workspaceId: ctx.scope.workspaceId!,
      customRecordId: deal.recordId,
      userId: input.userId,
    });
    await ctx.tx
      .delete(dealRoles)
      .where(and(eq(dealRoles.dealRecordId, deal.recordId), eq(dealRoles.userId, input.userId)));
    const after = await loadDeal(ctx, deal.recordId, { lock: true });
    if (after.ownerUserId && after.ownerUserId !== deal.ownerUserId)
      await setRole(ctx, after, after.ownerUserId, 'agent');
    const w = await openWork(ctx, after);
    await w.handOver(input.userId);
    await w.settle();
    await historyLine(ctx, deal, 'team', {
      after: { removed: input.userId, mainAgent: after.ownerUserId },
    });
    const names = await userNames(ctx, [input.userId]);
    const name = names.get(input.userId) ?? 'someone';
    const eventId = await ctx.emit({
      type: 'realestate.deal.team_changed',
      entityType: 'custom_record',
      entityId: deal.recordId,
      payload: { name: deal.name, removed: input.userId, mainAgent: after.ownerUserId },
      before: { name: deal.name, person: name },
      after: { name: deal.name, person: null },
    });
    await dealLine(ctx, deal, `took ${name} off this deal`, { eventId });
    return teamAnswer(ctx, deal.recordId, true, w.counts.handedOver);
  },
});

export const dealSetRole = defineAddonCommand(realestateAddon, {
  name: 'realestate.deal.set_role',
  description:
    'Change what someone on a deal does there: co-agent, coordinator or assistant, or make them its main agent (owners and admins only; the one they replace stays on as co-agent). Duties follow the role.',
  risk: 2,
  input: DealSetRoleInput,
  output: DealTeamOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: ['realestate.deal.team_changed'],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireNotArchived(deal);
    const names = await userNames(ctx, [input.userId]);
    const name = names.get(input.userId) ?? 'That person';
    if (!onDeal(deal, input.userId))
      throw HfosError.rule(
        'realestate_not_on_deal',
        409,
        `${name} isn’t on ${deal.name}. Put them on it first, then choose what they do.`,
      );
    const roles = await rolesOf(ctx, deal);
    let after = deal;
    const w0 = { handed: 0 };
    if (input.role === 'agent') {
      if (deal.ownerUserId === input.userId) return teamAnswer(ctx, deal.recordId, false, 0);
      // Core's own check: only owners and admins choose a record's main person.
      await executeCommandWithin(ctx, customRecordAssign, {
        workspaceId: ctx.scope.workspaceId!,
        customRecordId: deal.recordId,
        userId: input.userId,
        main: true,
      });
      after = await loadDeal(ctx, deal.recordId, { lock: true });
      await setRole(ctx, after, input.userId, 'agent');
      if (deal.ownerUserId) await setRole(ctx, after, deal.ownerUserId, 'co_agent');
      const w = await openWork(ctx, after);
      if (deal.ownerUserId) await w.handOver(deal.ownerUserId);
      await w.settle();
      w0.handed = w.counts.handedOver;
    } else {
      if (deal.ownerUserId === input.userId)
        throw HfosError.rule(
          'realestate_main_agent_role',
          409,
          `${name} is ${deal.name}’s main agent. Make someone else the main agent first.`,
        );
      if (!mayChangeTeam(ctx, deal))
        throw HfosError.rule(
          'record_team_not_yours',
          403,
          `Only the main agent on ${deal.name}, or an owner or admin, changes what people do on it. Ask them.`,
        );
      if ((roles.get(input.userId) ?? 'co_agent') === input.role)
        return teamAnswer(ctx, deal.recordId, false, 0);
      await setRole(ctx, deal, input.userId, input.role);
      const w = await openWork(ctx, deal);
      // The coordinator's duties follow the coordinator: to them, or back from them.
      await w.handOver(input.userId);
      if (deal.ownerUserId) await w.handOver(deal.ownerUserId);
      await w.settle();
      w0.handed = w.counts.handedOver;
    }
    await historyLine(ctx, deal, 'team', {
      before: { userId: input.userId, role: roles.get(input.userId) ?? null },
      after: { userId: input.userId, role: input.role },
    });
    const eventId = await ctx.emit({
      type: 'realestate.deal.team_changed',
      entityType: 'custom_record',
      entityId: deal.recordId,
      payload: { name: deal.name, userId: input.userId, role: input.role },
      after: { name: deal.name, person: name, role: DEAL_ROLE_LABELS[input.role] },
    });
    await dealLine(
      ctx,
      deal,
      input.role === 'agent'
        ? `made ${name} the main agent on this deal`
        : `made ${name} ${DEAL_ROLE_LABELS[input.role].toLowerCase()} on this deal`,
      { eventId },
    );
    return teamAnswer(ctx, deal.recordId, true, w0.handed);
  },
});

// ---------- the property ----------

/** The deal's property, and the relationship that says so. */
export async function propertyOf(
  ctx: Ctx,
  dealId: string,
): Promise<{ relationshipId: string; propertyId: string; address: string } | null> {
  const [p] = await rows<{ relationship_id: string; property_id: string; address: string }>(
    ctx.tx,
    sql`select rel.id as relationship_id, pr.id as property_id, pr.name as address
        from app.relationships rel
        join app.relationship_types rt on rt.id = rel.type_id and rt.addon_key = ${PROPERTY_TYPE_KEY}
        join app.custom_records pr on pr.id = rel.b_custom_record_id
        where rel.workspace_id = ${ctx.scope.workspaceId!} and rel.a_custom_record_id = ${dealId}
        order by rel.created_at desc limit 1`,
  );
  return p
    ? { relationshipId: p.relationship_id, propertyId: p.property_id, address: p.address }
    : null;
}

async function putOnProperty(ctx: CommandContext, dealId: string, propertyId: string) {
  await executeCommandWithin(ctx, relationshipCreate, {
    workspaceId: ctx.scope.workspaceId!,
    relationshipTypeId: await relationshipTypeId(ctx, PROPERTY_TYPE_KEY),
    aId: dealId,
    bId: propertyId,
  });
}

export const dealSetProperty = defineAddonCommand(realestateAddon, {
  name: 'realestate.deal.set_property',
  description:
    'Say which home a deal is about: one already here, or a new one by its address. A deal has one property; a property keeps every deal done on it.',
  risk: 1,
  input: DealSetPropertyInput,
  output: DealSetPropertyOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: ['realestate.deal.property_set'],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireNotArchived(deal);
    const current = await propertyOf(ctx, deal.recordId);
    let target = input.propertyId ?? null;
    if (current && target === current.propertyId)
      return { dealId: deal.recordId, propertyId: current.propertyId };
    if (!target)
      target = (
        await executeCommandWithin(ctx, customRecordCreate, {
          workspaceId: ctx.scope.workspaceId!,
          typeId: (await kindIds(ctx)).property,
          name: input.newPropertyAddress!,
        })
      ).output.customRecordId;
    if (current)
      await executeCommandWithin(ctx, relationshipDelete, {
        workspaceId: ctx.scope.workspaceId!,
        relationshipId: current.relationshipId,
      });
    await putOnProperty(ctx, deal.recordId, target);
    await historyLine(ctx, deal, 'property', {
      before: { propertyId: current?.propertyId ?? null },
      after: { propertyId: target },
    });
    const now = await propertyOf(ctx, deal.recordId);
    const eventId = await ctx.emit({
      type: 'realestate.deal.property_set',
      entityType: 'custom_record',
      entityId: deal.recordId,
      payload: { name: deal.name, propertyId: target },
      before: { name: deal.name, property: current?.address ?? null },
      after: { name: deal.name, property: now?.address ?? null },
    });
    await dealLine(ctx, deal, `set this deal’s property to ${now?.address ?? 'a new home'}`, {
      eventId,
    });
    return { dealId: deal.recordId, propertyId: target };
  },
});

// ---------- linked deals ----------

async function lockPair(ctx: CommandContext, a: string, b: string): Promise<[Deal, Deal]> {
  if (a === b)
    throw HfosError.rule(
      'realestate_link_itself',
      400,
      'A deal can’t be linked to itself. Pick the other deal.',
    );
  // Always the same order, so two people linking the same pair never wait on each other.
  const [first, second] = a < b ? [a, b] : [b, a];
  const x = await loadDeal(ctx, first, { lock: true });
  const y = await loadDeal(ctx, second, { lock: true });
  return a < b ? [x, y] : [y, x];
}

/** Whether a deal still has a client's other deal linked. */
async function hasSaleLink(ctx: CommandContext, dealId: string): Promise<boolean> {
  const [l] = await ctx.tx
    .select({ id: dealLinks.id })
    .from(dealLinks)
    .where(and(eq(dealLinks.dealRecordId, dealId), eq(dealLinks.kind, 'sale_and_purchase')))
    .limit(1);
  return !!l;
}

async function setLinkedSale(ctx: CommandContext, deal: Deal, on: boolean) {
  if (deal.facts.includes('linked_sale') === on) return;
  const w = await openWork(ctx, deal);
  await applyFacts(
    ctx,
    w,
    on ? [...deal.facts, 'linked_sale'] : deal.facts.filter((f) => f !== 'linked_sale'),
  );
  await w.settle();
}

export const dealLink = defineAddonCommand(realestateAddon, {
  name: 'realestate.deal.link',
  description:
    'Link a buyer deal and a listing: the two sides of one home (they share its property), or a client’s sale and their next purchase (whose dates are then checked against each other).',
  risk: 1,
  input: DealLinkInput,
  output: DealLinkOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: ['realestate.deal.linked'],
  async handler(ctx, input) {
    const [deal, other] = await lockPair(ctx, input.dealId, input.otherDealId);
    requireNotArchived(deal);
    requireNotArchived(other);
    if (deal.side === other.side)
      throw HfosError.rule(
        'realestate_link_sides',
        400,
        input.kind === 'same_home'
          ? 'The two sides of one home are a buyer deal and a listing. Pick the other side’s deal.'
          : 'A client’s sale and purchase are a listing and a buyer deal. Pick their other deal.',
      );
    if (input.kind === 'same_home') {
      const [p, q] = [await propertyOf(ctx, deal.recordId), await propertyOf(ctx, other.recordId)];
      if (p && q && p.propertyId !== q.propertyId)
        throw HfosError.rule(
          'realestate_link_other_home',
          409,
          `${deal.name} is on ${p.address} and ${other.name} on ${q.address}. Put them on the same property first.`,
        );
      if (p && !q) await putOnProperty(ctx, other.recordId, p.propertyId);
      if (q && !p) await putOnProperty(ctx, deal.recordId, q.propertyId);
    }
    const made = await ctx.tx
      .insert(dealLinks)
      .values([
        {
          workspaceId: deal.workspaceId,
          dealRecordId: deal.recordId,
          otherRecordId: other.recordId,
          kind: input.kind,
          createdBy: ctx.actor.type === 'human' ? ctx.actor.userId : null,
        },
        {
          workspaceId: deal.workspaceId,
          dealRecordId: other.recordId,
          otherRecordId: deal.recordId,
          kind: input.kind,
          createdBy: ctx.actor.type === 'human' ? ctx.actor.userId : null,
        },
      ])
      .onConflictDoNothing()
      .returning({ id: dealLinks.id });
    if (!made.length) return { dealId: deal.recordId, otherDealId: other.recordId, changed: false };
    if (input.kind === 'sale_and_purchase') {
      await setLinkedSale(ctx, deal, true);
      await setLinkedSale(ctx, other, true);
    }
    for (const [a, b] of [
      [deal, other],
      [other, deal],
    ] as const)
      await historyLine(ctx, a, 'linked', { after: { otherDealId: b.recordId, kind: input.kind } });
    const eventId = await ctx.emit({
      type: 'realestate.deal.linked',
      entityType: 'custom_record',
      entityId: deal.recordId,
      payload: {
        name: deal.name,
        otherDealId: other.recordId,
        otherName: other.name,
        kind: input.kind,
      },
      after: { name: deal.name, linked: other.name, kind: DEAL_LINK_KINDS[input.kind] },
    });
    await dealLine(
      ctx,
      deal,
      `linked ${other.name} (${DEAL_LINK_KINDS[input.kind].toLowerCase()})`,
      {
        eventId,
      },
    );
    // One timeline line per event: the other deal's line stands on its own.
    await dealLine(
      ctx,
      other,
      `linked ${deal.name} (${DEAL_LINK_KINDS[input.kind].toLowerCase()})`,
    );
    return { dealId: deal.recordId, otherDealId: other.recordId, changed: true };
  },
});

export const dealUnlink = defineAddonCommand(realestateAddon, {
  name: 'realestate.deal.unlink',
  description: 'Undo a link between two deals. Both keep their property, dates and duties.',
  risk: 1,
  input: DealUnlinkInput,
  output: DealLinkOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: ['realestate.deal.unlinked'],
  async handler(ctx, input) {
    const [deal, other] = await lockPair(ctx, input.dealId, input.otherDealId);
    requireNotArchived(deal);
    requireNotArchived(other);
    const gone = await ctx.tx
      .delete(dealLinks)
      .where(
        and(
          eq(dealLinks.kind, input.kind),
          dsql`(${dealLinks.dealRecordId} = ${deal.recordId} and ${dealLinks.otherRecordId} = ${other.recordId})
            or (${dealLinks.dealRecordId} = ${other.recordId} and ${dealLinks.otherRecordId} = ${deal.recordId})`,
        ),
      )
      .returning({ id: dealLinks.id });
    if (!gone.length) return { dealId: deal.recordId, otherDealId: other.recordId, changed: false };
    if (input.kind === 'sale_and_purchase')
      for (const d of [deal, other])
        if (!(await hasSaleLink(ctx, d.recordId))) await setLinkedSale(ctx, d, false);
    for (const [a, b] of [
      [deal, other],
      [other, deal],
    ] as const)
      await historyLine(ctx, a, 'unlinked', {
        before: { otherDealId: b.recordId, kind: input.kind },
      });
    const eventId = await ctx.emit({
      type: 'realestate.deal.unlinked',
      entityType: 'custom_record',
      entityId: deal.recordId,
      payload: { name: deal.name, otherDealId: other.recordId, kind: input.kind },
      before: { name: deal.name, linked: other.name },
      after: { name: deal.name, linked: null },
    });
    await dealLine(ctx, deal, `unlinked ${other.name}`, { eventId });
    await dealLine(ctx, other, `unlinked ${deal.name}`);
    return { dealId: deal.recordId, otherDealId: other.recordId, changed: true };
  },
});

// ---------- outside parties ----------

export const partyAdd = defineAddonCommand(realestateAddon, {
  name: 'realestate.party.add',
  description:
    'Tie one of the business’s customers or companies to a deal in a role: client, loan officer, other side’s agent, title contact, inspector, vendor, attorney, lender, title company or brokerage.',
  risk: 1,
  input: PartyAddInput,
  output: PartyAddOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: ['realestate.party.added'],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId);
    requireNotArchived(deal);
    const role = PARTY_ROLES[input.role];
    const end = role.end === 'person' ? input.personId : input.companyId;
    if (!end)
      throw HfosError.validation([
        {
          path: role.end === 'person' ? 'personId' : 'companyId',
          message:
            role.end === 'person'
              ? `A ${role.label.toLowerCase()} is a person. Pick one of the business’s customers.`
              : `A ${role.label.toLowerCase()} is a company. Pick one of the business’s companies.`,
        },
      ]);
    const made = await executeCommandWithin(ctx, relationshipCreate, {
      workspaceId: ctx.scope.workspaceId!,
      relationshipTypeId: await relationshipTypeId(ctx, partyTypeKey(input.role)),
      aId: end,
      bId: deal.recordId,
      note: input.note ?? null,
    });
    await historyLine(ctx, deal, 'party_added', {
      after: {
        role: input.role,
        personId: input.personId ?? null,
        companyId: input.companyId ?? null,
      },
    });
    // Core's relationship line already says so on the deal's and the contact's timelines.
    await ctx.emit({
      type: 'realestate.party.added',
      entityType: 'custom_record',
      entityId: deal.recordId,
      payload: {
        name: deal.name,
        role: input.role,
        personId: input.personId ?? null,
        companyId: input.companyId ?? null,
        relationshipId: made.output.relationshipId,
      },
      after: { name: deal.name, role: role.label },
    });
    return { dealId: deal.recordId, relationshipId: made.output.relationshipId };
  },
});

export const partyRemove = defineAddonCommand(realestateAddon, {
  name: 'realestate.party.remove',
  description:
    'Untie a customer or company from a deal. They stay one of the business’s contacts, with every other deal they’re on.',
  risk: 1,
  input: PartyRemoveInput,
  output: PartyRemoveOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: ['realestate.party.removed'],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId);
    requireNotArchived(deal);
    const keys = Object.keys(PARTY_ROLES).map((r) => `realestate_${r}`);
    const [pair] = await rows<{ id: string; addon_key: string }>(
      ctx.tx,
      sql`select rel.id, rt.addon_key from app.relationships rel
          join app.relationship_types rt on rt.id = rel.type_id
          where rel.id = ${input.relationshipId} and rel.workspace_id = ${ctx.scope.workspaceId!}
            and rel.b_custom_record_id = ${deal.recordId}
            and rt.addon_key = any(${`{${keys.join(',')}}`}::text[])`,
    );
    if (!pair)
      throw HfosError.notFound(
        'That person or company isn’t on this deal anymore. Refresh to see who is.',
      );
    await executeCommandWithin(ctx, relationshipDelete, {
      workspaceId: ctx.scope.workspaceId!,
      relationshipId: pair.id,
    });
    await historyLine(ctx, deal, 'party_removed', {
      before: { role: pair.addon_key.replace(/^realestate_/, ''), relationshipId: pair.id },
    });
    await ctx.emit({
      type: 'realestate.party.removed',
      entityType: 'custom_record',
      entityId: deal.recordId,
      payload: { name: deal.name, relationshipId: pair.id },
      after: { name: deal.name },
    });
    return { dealId: deal.recordId, relationshipId: pair.id };
  },
});

// ---------- commission ----------

/** The deal's commission as its page shows it. */
export function commissionView(
  deal: Deal & { readonly finalCommissionAt?: Date | null },
  terms: ReadonlyMap<TermKey, TermNow>,
) {
  const price =
    moneyOf(terms, 'price') ?? (deal.side === 'listing' ? moneyOf(terms, 'list_price') : null);
  const now = commissionOf(
    {
      rateBp: deal.commissionRateBp,
      flatCents: deal.commissionFlatCents,
      creditCents: deal.commissionCreditCents,
      splitBp: deal.commissionSplitBp,
    },
    price,
  );
  return {
    rateBp: deal.commissionRateBp,
    flatCents: deal.commissionFlatCents,
    creditCents: deal.commissionCreditCents,
    splitBp: deal.commissionSplitBp,
    ...now,
    finalCents: deal.finalCommissionCents,
    finalAt: deal.finalCommissionAt?.toISOString() ?? null,
  };
}

async function finalAtOf(ctx: Ctx, dealId: string): Promise<Date | null> {
  const [d] = await ctx.tx
    .select({ at: deals.finalCommissionAt })
    .from(deals)
    .where(eq(deals.recordId, dealId));
  return d?.at ?? null;
}

export const dealSetCommission = defineAddonCommand(realestateAddon, {
  name: 'realestate.deal.set_commission',
  description:
    'Set what was agreed for a deal’s commission: a rate of the price or a flat amount, any credit back to the client, and the agent’s split. The expected amount follows the price.',
  risk: 1,
  input: DealSetCommissionInput,
  output: DealCommissionOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: ['realestate.deal.commission_set'],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireNotArchived(deal);
    const next = {
      commissionRateBp: input.rateBp,
      commissionFlatCents: input.flatCents,
      commissionCreditCents: input.creditCents,
      commissionSplitBp: input.splitBp,
    };
    await ctx.tx
      .update(deals)
      .set({ ...next, updatedAt: new Date() })
      .where(and(eq(deals.recordId, deal.recordId), eq(deals.workspaceId, deal.workspaceId)));
    const w = await openWork(ctx, { ...deal, ...next });
    await w.settle();
    const view = commissionView(
      { ...w.deal, finalCommissionAt: await finalAtOf(ctx, deal.recordId) },
      w.terms,
    );
    await historyLine(ctx, deal, 'commission', {
      before: {
        rateBp: deal.commissionRateBp,
        flatCents: deal.commissionFlatCents,
        creditCents: deal.commissionCreditCents,
        splitBp: deal.commissionSplitBp,
      },
      after: {
        rateBp: input.rateBp,
        flatCents: input.flatCents,
        creditCents: input.creditCents,
        splitBp: input.splitBp,
        expectedCents: view.expectedCents,
      },
    });
    await ctx.emit({
      type: 'realestate.deal.commission_set',
      entityType: 'custom_record',
      entityId: deal.recordId,
      payload: { name: deal.name, expectedCents: view.expectedCents },
      before: { name: deal.name, expected: deal.expectedCommissionCents },
      after: { name: deal.name, expected: view.expectedCents },
    });
    return { dealId: deal.recordId, commission: view };
  },
});

export const dealSetFinalCommission = defineAddonCommand(realestateAddon, {
  name: 'realestate.deal.set_final_commission',
  description:
    'Set what a closed deal’s commission came to in the end. Owners and admins (Approve exceptions) only.',
  risk: 2,
  input: DealSetFinalCommissionInput,
  output: DealCommissionOutput,
  permission: 'realestate.except',
  scope: inWorkspace,
  emits: ['realestate.deal.final_commission_set'],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireNotArchived(deal);
    if (deal.outcome !== 'closed')
      throw HfosError.rule(
        'realestate_not_closed',
        409,
        `The final commission is set once ${deal.name} has closed. Mark it closed first.`,
      );
    const at = new Date();
    await ctx.tx
      .update(deals)
      .set({
        finalCommissionCents: input.cents,
        finalCommissionBy: ctx.actor.type === 'human' ? ctx.actor.userId : null,
        finalCommissionAt: at,
        updatedAt: at,
      })
      .where(and(eq(deals.recordId, deal.recordId), eq(deals.workspaceId, deal.workspaceId)));
    const w = await openWork(ctx, { ...deal, finalCommissionCents: input.cents });
    await historyLine(ctx, deal, 'final_commission', {
      before: { cents: deal.finalCommissionCents },
      after: { cents: input.cents },
      note: input.note ?? null,
    });
    const eventId = await ctx.emit({
      type: 'realestate.deal.final_commission_set',
      entityType: 'custom_record',
      entityId: deal.recordId,
      payload: { name: deal.name, cents: input.cents },
      before: { name: deal.name, final: deal.finalCommissionCents },
      after: { name: deal.name, final: input.cents },
    });
    await dealLine(ctx, deal, `set the final commission to ${money(input.cents)}`, {
      eventId,
      body: input.note ?? null,
    });
    return {
      dealId: deal.recordId,
      commission: commissionView({ ...w.deal, finalCommissionAt: at }, w.terms),
    };
  },
});

// ---------- archiving ----------

function requireArchiver(ctx: CommandContext, deal: Deal) {
  if (!scopeCan(ctx.scope, 'records.archive'))
    throw HfosError.rule(
      'realestate_archive_forbidden',
      403,
      `Only an owner or admin archives or restores deals. Ask one of them about ${deal.name}.`,
    );
}

export const dealArchive = defineAddonCommand(realestateAddon, {
  name: 'realestate.deal.archive',
  description:
    'Archive a deal: out of the lists, with its history, duties, documents and dates kept. Deals are never deleted. Owners and admins.',
  risk: 3,
  input: DealArchiveInput,
  output: DealArchiveOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: [],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireArchiver(ctx, deal);
    if (deal.archivedAt) return { dealId: deal.recordId, archived: true };
    await executeCommandWithin(ctx, customRecordArchive, {
      workspaceId: ctx.scope.workspaceId!,
      customRecordId: deal.recordId,
    });
    await historyLine(ctx, deal, 'archived');
    return { dealId: deal.recordId, archived: true };
  },
});

export const dealRestore = defineAddonCommand(realestateAddon, {
  name: 'realestate.deal.restore',
  description: 'Bring an archived deal back, as it was. Owners and admins.',
  risk: 1,
  input: DealArchiveInput,
  output: DealArchiveOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: [],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireArchiver(ctx, deal);
    if (!deal.archivedAt) return { dealId: deal.recordId, archived: false };
    await executeCommandWithin(ctx, customRecordRestore, {
      workspaceId: ctx.scope.workspaceId!,
      customRecordId: deal.recordId,
    });
    await historyLine(ctx, deal, 'restored');
    return { dealId: deal.recordId, archived: false };
  },
});

export const dealPeopleCommands = [
  dealAddPerson,
  dealRemovePerson,
  dealSetRole,
  dealSetProperty,
  dealLink,
  dealUnlink,
  partyAdd,
  partyRemove,
  dealSetCommission,
  dealSetFinalCommission,
  dealArchive,
  dealRestore,
];
