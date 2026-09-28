/**
 * Add-ons (0108): what the lifecycle commands take and give back, and what the add-on queries show. Browser-safe, so
 * the screens build the same requests the Assistant and the tests do. See docs/addon-architecture.md.
 */
import { z } from 'zod';
import { CATALOG_STATUSES } from '../addons/manifest';
import { INSTALLATION_STATES, LIFECYCLE_ACTIONS } from '../addons/lifecycle';
import { SUGGESTION_CHOICES } from '../addons/suggest';
import { isoDateTime, uuid } from './common';

export const addonId = z.string().regex(/^[a-z]{2,16}$/, 'Not an add-on.');
export const installationState = z.enum(INSTALLATION_STATES);
export const lifecycleAction = z.enum(LIFECYCLE_ACTIONS);

/**
 * A move on one add-on. `include` is the person's answer to "Turn off both?" (or "Install both?"): the other add-ons
 * they agreed to move with it. Without it, a move that would break a required dependency is refused with the list
 * to ask about (rule `addon_required_by` or `addon_needs`, disposition `ask`).
 */
export const AddonMoveInput = z.object({
  workspaceId: uuid,
  addonId,
  include: z.array(addonId).max(30).default([]),
});
export const AddonMoveOutput = z.object({
  /** Every add-on that moved, in the order it moved. Empty when it was already there. */
  moved: z.array(
    z.object({
      addonId,
      action: lifecycleAction,
      from: installationState.nullable(),
      to: installationState,
      generation: z.number().int(),
    }),
  ),
});

/** Permanently deleting an add-on's data: its name typed out, the way deleting a business asks for its name. */
export const AddonPurgeInput = z.object({
  workspaceId: uuid,
  addonId,
  confirmName: z.string().trim().min(1, 'Type the add-on’s name.').max(80),
});

export const AddonSaveSettingsInput = z.object({
  workspaceId: uuid,
  addonId,
  settings: z.record(z.string(), z.unknown()).optional(),
  flags: z.record(z.string(), z.boolean()).optional(),
});
export const AddonSaveMySettingsInput = z.object({
  workspaceId: uuid,
  addonId,
  settings: z.record(z.string(), z.unknown()),
});
export const AddonSettingsSaved = z.object({ addonId, saved: z.literal(true) });

export const AddonListInput = z.object({ workspaceId: uuid });

const CapabilityRow = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string(),
  provider: z.string(),
  providerName: z.string(),
});

export const AddonListOutput = z.object({
  /** Add-ons this business has, whatever state they are in, with where they stand. */
  installed: z.array(
    z.object({
      addonId,
      name: z.string(),
      summary: z.string(),
      state: installationState,
      installedVersion: z.string(),
      /** The code's version now: different from installedVersion after an update, until the worker catches up. */
      latestVersion: z.string().nullable(),
      generation: z.number().int(),
      changedAt: isoDateTime,
      /** Trouble finishing the last move, if any. */
      lastError: z.string().nullable(),
      /** While there's trouble (`lastError`), the checks that failed when the worker last looked; else empty. */
      failedChecks: z.array(z.string()),
      /**
       * The add-on's code is gone from HandsFreeOS (a retired add-on). It goes by its id, nothing turns it on or off
       * again, and it can still be uninstalled and its data deleted.
       */
      retired: z.boolean(),
      /** Its catalogue status now, with HandsFreeOS's override applied (`deprecated`, `unavailable`); null if retired. */
      status: z.enum(CATALOG_STATUSES).nullable(),
      /** Whether it runs here now: on, and not switched off everywhere by HandsFreeOS (`unavailable`). */
      running: z.boolean(),
    }),
  ),
  /** What this person can do here now, and what's installed but not theirs, or turned off. */
  capabilities: z.object({
    current: z.array(CapabilityRow),
    restricted: z.array(CapabilityRow),
    turnedOff: z.array(CapabilityRow),
    /** Only for people who may install add-ons: available ones this business doesn't have. */
    installable: z.array(CapabilityRow),
    /** Only for people who may install add-ons: what is planned. Never installable. */
    planned: z.array(CapabilityRow),
  }),
  /** Only for people who may install add-ons: the available ones. What is planned is `addon.roadmap`'s. */
  catalog: z.array(
    z.object({
      addonId,
      name: z.string(),
      summary: z.string(),
      category: z.string(),
      status: z.enum(CATALOG_STATUSES),
    }),
  ),
});

export const AddonImpactInput = z.object({
  workspaceId: uuid,
  addonId,
  action: lifecycleAction,
});
export const AddonImpactOutput = z.object({
  addonId,
  action: lifecycleAction,
  /**
   * What would happen: `plan` lists every move in order (and `needsAgreement` names the ones the person must agree
   * to, which is the simple question to ask), `already` means nothing would change, `refused` says why it can't.
   */
  outcome: z.enum(['plan', 'already', 'refused']),
  moves: z.array(z.object({ addonId, action: lifecycleAction, name: z.string() })),
  needsAgreement: z.array(addonId),
  question: z.string().nullable(),
  refusal: z.object({ rule: z.string(), message: z.string() }).nullable(),
  /** Add-ons that use it when it's there and would lose those features. */
  optionalFor: z.array(z.object({ addonId, name: z.string() })),
  /** Capabilities working now that would stop: none from an add-on that is already off. */
  capabilitiesLost: z.array(z.object({ id: z.string(), label: z.string() })),
  /** What it holds here now. */
  holds: z.object({
    records: z.number().int(),
    relationships: z.number().int(),
    pendingJobs: z.number().int(),
    heldResources: z.number().int(),
    ownRows: z.number().int(),
    usageEvents: z.number().int(),
  }),
});

export const AddonSettingsInput = z.object({ workspaceId: uuid, addonId });
export const AddonSettingsOutput = z.object({
  addonId,
  /** The business's settings, when this person may see them (the add-on's settings permission). */
  settings: z.record(z.string(), z.unknown()).nullable(),
  flags: z.record(z.string(), z.boolean()).nullable(),
  mySettings: z.record(z.string(), z.unknown()),
});

/** The one add-on Home may suggest to this person now (packages/core/src/addons/suggest.ts), or none. */
export const AddonSuggestionInput = z.object({ workspaceId: uuid });
export const AddonSuggestionOutput = z.object({
  suggestion: z
    .object({
      addonId,
      name: z.string(),
      summary: z.string(),
      /** What it would let the business do. */
      does: z.array(z.string()),
    })
    .nullable(),
});

/** Setting a suggestion aside: not now (every suggestion rests a while), or not interested in this one. */
export const AddonSuggestionDismissInput = z.object({
  workspaceId: uuid,
  addonId,
  choice: z.enum(SUGGESTION_CHOICES),
});
export const AddonSuggestionDismissOutput = z.object({
  addonId,
  choice: z.enum(SUGGESTION_CHOICES),
});

// ---------- voting on what's next (0109) ----------

export const addonPickHow = z.enum(['votes', 'team', 'plan']);
export const addonNewsKind = z.enum(['picked', 'shipped']);

/** A business's vote for a planned add-on, cast or taken back by an owner or admin. */
export const AddonVoteInput = z.object({ workspaceId: uuid, addonId });
export const AddonVoteOutput = z.object({
  addonId,
  /** Whether the business's vote is on it now. */
  voted: z.boolean(),
  votes: z.number().int(),
});

export const AddonRoadmapInput = z.object({ workspaceId: uuid });
export const AddonRoadmapOutput = z.object({
  /** Picked and not ready to add yet, newest first. */
  comingSoon: z.array(
    z.object({
      addonId,
      name: z.string(),
      summary: z.string(),
      how: addonPickHow,
      pickedAt: isoDateTime,
      votes: z.number().int(),
      /** This business voted for it. */
      voted: z.boolean(),
    }),
  ),
  /** Every planned add-on still in the race, in the catalogue's order. */
  planned: z.array(
    z.object({
      addonId,
      name: z.string(),
      summary: z.string(),
      category: z.string(),
      groups: z.array(z.string()),
      /** What HandsFreeOS already does of it, and what it would add. */
      overlap: z.string().nullable(),
      votes: z.number().int(),
      voted: z.boolean(),
    }),
  ),
  /** When this week's vote closes: Sunday at midnight, US Eastern. */
  nextPickAt: isoDateTime,
});

/** Home's note: an add-on this business voted for is coming soon, or ready to add. */
export const AddonNewsInput = z.object({ workspaceId: uuid });
export const AddonNewsOutput = z.object({
  news: z
    .object({ addonId, name: z.string(), summary: z.string(), kind: addonNewsKind })
    .nullable(),
});
export const AddonNewsSeenInput = z.object({ workspaceId: uuid, addonId, kind: addonNewsKind });
export const AddonNewsSeenOutput = z.object({
  addonId,
  kind: addonNewsKind,
  seen: z.literal(true),
});

/** The team's view of the vote: weeks waiting for a pick, the race, and Coming soon. */
export const AddonPickOverviewInput = z.object({});
export const AddonPickOverviewOutput = z.object({
  /** Weeks that closed with nothing voted for or a tie: the team chooses each one's pick. */
  waiting: z.array(
    z.object({
      weekId: uuid,
      endsAt: isoDateTime,
      outcome: z.enum(['no_votes', 'tie']),
      /** For a tie, the add-ons to choose among. */
      tied: z.array(addonId),
      topVotes: z.number().int(),
    }),
  ),
  /** The last weeks that closed, newest first. */
  weeks: z.array(
    z.object({
      weekId: uuid,
      endsAt: isoDateTime,
      outcome: z.enum(['votes', 'no_votes', 'tie']),
      addonId: addonId.nullable(),
      name: z.string().nullable(),
      topVotes: z.number().int(),
      decidedAt: isoDateTime.nullable(),
      decidedBy: z.string().nullable(),
    }),
  ),
  /** Every planned add-on still in the race, most votes first. */
  race: z.array(
    z.object({ addonId, name: z.string(), category: z.string(), votes: z.number().int() }),
  ),
  comingSoon: z.array(
    z.object({
      addonId,
      name: z.string(),
      how: addonPickHow,
      pickedAt: isoDateTime,
      votes: z.number().int(),
      shippedAt: isoDateTime.nullable(),
    }),
  ),
  nextPickAt: isoDateTime,
});

/** The team choosing the pick for a week that closed with nothing voted for or a tie. */
export const AddonPickChooseInput = z.object({ weekId: uuid, addonId });
export const AddonPickChooseOutput = z.object({ weekId: uuid, addonId });
