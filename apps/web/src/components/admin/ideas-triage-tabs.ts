/**
 * The tabs the team reads the ideas board by. "Under review" is the queue: nobody here has answered those yet.
 * They are core's, so the phone's Support desk has the same tabs; a module of its own, so the server page that reads
 * the address and the list that draws the tabs share it.
 */
export {
  IDEA_TRIAGE_TABS as TRIAGE_TABS,
  ideaTriageQuery,
  type IdeaTriageTab as TriageTab,
} from '@hfos/core';
