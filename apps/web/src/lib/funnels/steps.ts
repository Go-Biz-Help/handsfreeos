/** A funnel's eight steps (HANDSFREEOS_TEAMMATE_FUNNELS_IMPLEMENTATION_PLAN.md, "Making one"), for the page and the builder. */
export const FUNNEL_STEPS = [
  { key: 'describe', label: 'Describe it' },
  { key: 'pipeline', label: 'Its pipeline' },
  { key: 'who', label: 'Who gets in' },
  { key: 'stages', label: 'The stages' },
  { key: 'messages', label: 'The messages' },
  { key: 'wording', label: 'Wording and approvals' },
  { key: 'try', label: 'Try it as a lead' },
  { key: 'on', label: 'Turn it on' },
] as const;
export type FunnelStepKey = (typeof FUNNEL_STEPS)[number]['key'];
