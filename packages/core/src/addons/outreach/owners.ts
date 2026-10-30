/**
 * Whose each group and each person is (docs/outreach.md decision 107, the owner's pick 4a): "Each group belongs to the
 * teammate who works it first, and each person to whoever reached them first. Owners can move either."
 *
 * A group is the teammate's who first took a step from it, asked to join it or put a helpful post up there; a person
 * the teammate's who first took a step to them or booked their demo through their link. Another teammate's Today
 * leaves both out: their people aren't friended, warmed up, messaged or commented on from a group someone else works,
 * and `outreach.send.queue` refuses outreach to someone else's person (`outreach_someone_elses`). A reply they're owed
 * still goes, and so do a booked demo's reminder and another time. A teammate who no longer uses Social Outreach holds
 * nothing. An owner or admin moves either (`outreach.owner.move`).
 *
 * Browser-safe: the shapes, the words, and which messages someone else's person still gets.
 */
import { z } from 'zod';
import type { SendKind } from './automation';

/** What another teammate's person still gets from the person: a reply they're owed, and a demo booked through them. */
const STILL_GOES: readonly SendKind[] = ['reply', 'partner_reply', 'demo_reminder', 'rebook'];

/** Whether a message is outreach that another teammate's person never gets from the person. */
export const heldForOthers = (kind: SendKind): boolean => !STILL_GOES.includes(kind);

/** Who works a group, or reached a person first, as their pages show it. */
export const TeamOwner = z.object({
  userId: z.uuid(),
  name: z.string(),
  /** The person asking themselves. */
  you: z.boolean(),
});
export type TeamOwner = z.output<typeof TeamOwner>;

export const OWNED_KINDS = ['group', 'person'] as const;
export type OwnedKind = (typeof OWNED_KINDS)[number];

export const OwnerMoveInput = z.object({
  workspaceId: z.uuid(),
  /** A group, or a person by their profile. */
  kind: z.enum(OWNED_KINDS),
  /** The group's id, or the person's profile id. */
  id: z.uuid(),
  /** The teammate they go to, who uses Social Outreach. */
  userId: z.uuid(),
});
export type OwnerMoveInput = z.input<typeof OwnerMoveInput>;

export const OwnerMoveOutput = z.object({
  kind: z.enum(OWNED_KINDS),
  id: z.uuid(),
  owner: TeamOwner,
  /** For a person: how many of the teammate's messages to them before, waiting for an OK or OK'd, were skipped. */
  skipped: z.number().int().min(0),
});
export type OwnerMoveOutput = z.output<typeof OwnerMoveOutput>;

/** The words on a group's page, a customer's Social panel and the person menu, on the web and the phone alike. */
export const OWNER_WORDS = {
  /** A group's page: who works it, and what that means for the person's Today. */
  group: (o: TeamOwner | null): string =>
    !o
      ? 'No teammate works this group yet.'
      : o.you
        ? 'You work this group.'
        : `${o.name} works this group, so its people aren’t on your Today.`,
  /** The person menu's line. */
  person: (o: TeamOwner): string =>
    o.you ? 'You reached them first' : `Reached first by ${o.name}`,
  /** A customer's Social panel: who reached them first, and what that means for the person's Today. */
  personNote: (o: TeamOwner): string =>
    o.you
      ? 'You reached them first.'
      : `${o.name} reached them first, so they aren’t on your Today. A reply to them still goes.`,
  move: 'Move to',
  /** The group page's picker, for a screen reader. */
  moveLabel: 'Move this group to a teammate',
  /** A person menu's give, for an owner or admin. */
  giveTo: (to: TeamOwner): string => (to.you ? 'Make them yours' : `Give them to ${to.name}`),
  /** What a give does, in the person menu's explainer (`OUTREACH_WORDS.person.hints`). */
  giveHint: (to: TeamOwner): string =>
    `${to.you ? 'Only you reach out to them from now on, from your Today.' : `Only ${to.name} reaches out to them from now on, from their Today.`} Whoever had them before stops, and their messages still waiting to go are skipped. Replies still go.`,
  moved: (kind: OwnedKind, to: TeamOwner): string => {
    const whose = to.you ? 'yours' : `${to.name}’s`;
    return kind === 'group' ? `This group is ${whose} now.` : `They’re ${whose} now.`;
  },
} as const;
