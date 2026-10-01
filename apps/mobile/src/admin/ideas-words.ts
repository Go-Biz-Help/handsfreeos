import { IDEA_STATUS_WORDS, type IdeaStatus } from '@hfos/core';

/**
 * The words only the phone's Ideas desk says: the toasts after a change (the web's page simply redraws), the sheets
 * that stand in for the web's inline forms and confirm boxes, and what an area's page says to somebody whose role
 * doesn't keep them (the web's page 404s). What both say is core's `IDEAS_TEAM_WORDS`, `IDEA_AREAS_WORDS` and
 * `WHATS_NEW_TEAM_WORDS`.
 */
export const IDEAS_DESK_WORDS = {
  moved: (status: IdeaStatus) => `Moved to ${IDEA_STATUS_WORDS[status]}`,
  updatePosted: 'Update posted',
  answerPosted: 'Answer posted',
  hidden: 'Taken off the board',
  unhidden: 'Back on the board',
  merged: (n: number) => `Merged into #${n}`,
  mergeButton: (n: number) => `Merge into #${n}`,
  saved: 'Saved',
  editTitle: 'Edit the entry',
  areasManageOnly:
    'Only support leads and admins keep the areas. Ask one of them to add or archive one.',
} as const;
