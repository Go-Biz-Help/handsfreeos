/** Teammate funnels' jobs and keys (HANDSFREEOS_TEAMMATE_FUNNELS_IMPLEMENTATION_PLAN.md, "How it runs"). */

export const FUNNEL_JOBS = {
  /** One a person in a funnel: the one thing due for them now, then sleep until the next (tick.ts). */
  tick: 'funnel.tick',
  /** Turned on with "Also add the leads already here": takes them in, a batch at a time (events.ts). */
  addExisting: 'funnel.add_existing',
} as const;

export const tickJobKey = (funnelPersonId: string): string => `funnel:${funnelPersonId}`;
export const addExistingJobKey = (funnelId: string): string => `funnel-add:${funnelId}`;

/** What `sent` holds once a stage's hand-off to the team is done (a stage hands off once; no message id has an underscore). */
export const FUNNEL_HANDOFF_MARK = '_handoff';

/** How many leads already there one add-existing pass takes in. */
export const ADD_EXISTING_BATCH = 50;
