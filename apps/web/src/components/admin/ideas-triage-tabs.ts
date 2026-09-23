/**
 * The tabs the team reads the ideas board by. "Under review" is the queue: nobody here has answered those yet.
 * A module of its own, so the server page that reads the address and the list that draws the tabs share it.
 */
export const TRIAGE_TABS = [
  { key: 'under_review', label: 'Under review' },
  { key: 'planned', label: 'Planned' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'done', label: 'Done' },
  { key: 'not_planned', label: 'Not planned' },
  { key: 'all', label: 'Everything' },
  { key: 'hidden', label: 'Taken down' },
  { key: 'merged', label: 'Merged' },
] as const;
export type TriageTab = (typeof TRIAGE_TABS)[number]['key'];
