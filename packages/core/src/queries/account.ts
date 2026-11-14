/**
 * A person's own account (M10), as the web's Settings → Account and Delete my account pages read it: what deleting it
 * would leave without an owner, the phones they get notifications on, their own cell, and what they said of
 * themselves for the AI that writes as them (About you).
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
import { pushDevices, userAbout, userPhones } from '@hfos/db/schema';
import {
  addOrganizationOwner,
  agencyCandidates,
  nothingOwnedAlone,
  onlyOwnerPlaces,
  ownerSuggestion,
  soleBusinessHandOvers,
  undone,
} from '../account/ownership';
import { requireHuman } from '../kernel/actor';
import { defineQuery } from '../kernel/define';
import { PushDeviceListInput, PushDeviceListOutput } from '../schemas/push';
import { UserAboutGetInput, UserAboutGetOutput } from '../schemas/user-about';
import { UserPhoneGetInput, UserPhoneGetOutput } from '../schemas/user-phone';
import { AccountDeletionCheckInput, AccountDeletionCheckOutput } from '../schemas/user';

export const accountDeletionCheck = defineQuery({
  name: 'account.deletion_check',
  description:
    'Whether you can delete your account now: the businesses and agencies you’re the only owner of (with who could take each over), and the ones that pass to their other owners when you go.',
  input: AccountDeletionCheckInput,
  output: AccountDeletionCheckOutput,
  permission: null,
  scope: () => ({ kind: 'account' }),
  async handler(ctx) {
    const me = requireHuman(ctx).userId;
    const handOvers = await soleBusinessHandOvers(ctx.tx, me);
    // What account.delete would find, tried and undone: the hand-overs first, then the last-owner rules.
    const places = await undone(ctx.tx, async (sp) => {
      for (const h of handOvers)
        for (const to of h.to) await addOrganizationOwner(sp, h.organizationId, to.userId);
      return onlyOwnerPlaces(sp, me);
    });
    const businesses = [];
    for (const b of places.businesses)
      businesses.push({ ...b, suggestion: await ownerSuggestion(ctx.tx, b.workspaceId, me) });
    const agencies = [];
    for (const a of places.agencies)
      agencies.push({ ...a, candidates: await agencyCandidates(ctx.tx, a.organizationId, me) });
    return {
      ready: nothingOwnedAlone(places),
      businesses,
      agencies,
      handsOver: handOvers.map((h) => ({
        organizationId: h.organizationId,
        workspaceId: h.workspaceId,
        name: h.name,
        to: [...h.to],
      })),
    };
  },
});

export const pushDeviceList = defineQuery({
  name: 'push_device.list',
  description:
    'The phones you get notifications on: each install of the HandsFreeOS app you’re signed in on, newest first.',
  input: PushDeviceListInput,
  output: PushDeviceListOutput,
  permission: null,
  scope: () => ({ kind: 'account' }),
  async handler(ctx) {
    const me = requireHuman(ctx).userId;
    const found = await ctx.tx
      .select({
        id: pushDevices.id,
        platform: pushDevices.platform,
        deviceName: pushDevices.deviceName,
        appVersion: pushDevices.appVersion,
        lastSeenAt: pushDevices.lastSeenAt,
      })
      .from(pushDevices)
      .where(and(eq(pushDevices.userId, me), isNull(pushDevices.disabledAt)))
      .orderBy(desc(pushDevices.lastSeenAt));
    return { devices: found.map((d) => ({ ...d, lastSeenAt: d.lastSeenAt.toISOString() })) };
  },
});

export const userPhoneGet = defineQuery({
  name: 'user_phone.get',
  description:
    'My cell phone: the number HandsFreeOS rings when you press Call, and whether you’ve confirmed it by pressing 1.',
  input: UserPhoneGetInput,
  output: UserPhoneGetOutput,
  permission: null,
  scope: () => ({ kind: 'account' }),
  async handler(ctx) {
    const me = requireHuman(ctx).userId;
    const mine = await ctx.tx
      .select()
      .from(userPhones)
      .where(eq(userPhones.userId, me))
      .orderBy(desc(userPhones.createdAt));
    // A verified cell is the one Call rings; otherwise the number waiting to be confirmed.
    const row = mine.find((p) => p.verifiedAt) ?? mine[0];
    return {
      phone: row
        ? {
            id: row.id,
            e164: row.e164,
            verifiedAt: row.verifiedAt?.toISOString() ?? null,
            lastVerificationAt: row.lastVerificationAt?.toISOString() ?? null,
          }
        : null,
    };
  },
});

export const userAboutGet = defineQuery({
  name: 'user_about.get',
  description:
    'About you: what you said of yourself, in your own words, for the AI that writes as you. Only you see it.',
  input: UserAboutGetInput,
  output: UserAboutGetOutput,
  permission: null,
  scope: () => ({ kind: 'account' }),
  async handler(ctx) {
    const me = requireHuman(ctx).userId;
    const [row] = await ctx.tx
      .select({ about: userAbout.about, updatedAt: userAbout.updatedAt })
      .from(userAbout)
      .where(eq(userAbout.userId, me));
    return { about: row?.about ?? '', updatedAt: row?.updatedAt.toISOString() ?? null };
  },
});
