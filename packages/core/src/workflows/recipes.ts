/**
 * Built-in recipes, and the placeholders that let a recipe or an agency template travel between
 * businesses. A recipe names workspace things (a stage, a calendar, a person) with `{"$ph": "key"}`;
 * installing it maps each key to a real id (`suggestMapping` proposes matches by name), and saving a
 * workflow as a template swaps its ids back out for named placeholders (`extractPlaceholders`).
 */
import { WorkflowDefinition, type WorkflowDefinitionInput } from './definition';
import { isPlaceholder, type RefKind } from './ids';
import { listRefs, mapRefs } from './refs';
import type { WorkflowCatalogs } from './rules';

export interface WorkflowPlaceholder {
  readonly key: string;
  readonly kind: RefKind;
  /** What to ask for when mapping ("Estimate sent", "Who takes emergencies"). */
  readonly label: string;
}

const humanize = (key: string) => {
  const words = key.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/**
 * A placeholder's label from its key. A saved template's keys lead with their kind (`stage_estimate_sent`,
 * from extractPlaceholders), which the label leaves out: "Estimate sent", as the business knows it.
 */
function labelFor(key: string, kind: RefKind): string {
  const bare = key.startsWith(`${kind}_`) ? key.slice(kind.length + 1) : key;
  return humanize(bare || key);
}

/** The placeholders still in a definition, in order of first use. */
export function placeholdersIn(def: WorkflowDefinition): WorkflowPlaceholder[] {
  const out = new Map<string, WorkflowPlaceholder>();
  for (const site of listRefs(def))
    if (isPlaceholder(site.value) && !out.has(site.value.$ph))
      out.set(site.value.$ph, {
        key: site.value.$ph,
        kind: site.kind,
        label: labelFor(site.value.$ph, site.kind),
      });
  return [...out.values()];
}

/** Swaps mapped placeholders for their ids; unmapped ones stay (the validator flags them). */
export function resolvePlaceholders(
  def: WorkflowDefinition,
  mapping: Readonly<Record<string, string | null | undefined>>,
): WorkflowDefinition {
  return mapRefs(def, (site) => {
    if (!isPlaceholder(site.value)) return undefined;
    const id = mapping[site.value.$ph];
    return typeof id === 'string' ? id : undefined;
  });
}

interface Candidate {
  readonly id: string;
  readonly name: string;
}

function candidates(kind: RefKind, c: WorkflowCatalogs): Candidate[] {
  switch (kind) {
    case 'stage':
      return c.pipelines
        .filter((p) => !p.archived)
        .flatMap((p) =>
          p.stages.filter((s) => !s.archived).map((s) => ({ id: s.id, name: s.name })),
        );
    case 'pipeline':
      return c.pipelines.filter((p) => !p.archived);
    case 'tag':
      return [...c.tags];
    case 'calendar':
      return c.calendars.filter((x) => !x.archived);
    case 'service':
      return (c.services ?? []).filter((x) => !x.archived);
    case 'user':
      return c.team.filter((p) => p.active).map((p) => ({ id: p.userId, name: p.name }));
    case 'workflow':
      return [...(c.workflows ?? [])];
  }
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * A proposed id for each placeholder: an exact name match, then a name that contains the other, then (for
 * people and calendars, which rarely have telling names) the first one. null when nothing fits.
 */
export function suggestMapping(
  placeholders: readonly WorkflowPlaceholder[],
  catalogs: WorkflowCatalogs,
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const ph of placeholders) {
    const list = candidates(ph.kind, catalogs);
    const wanted = [norm(ph.label), norm(ph.key.replace(/_/g, ' '))].filter(Boolean);
    const exact = list.find((x) => wanted.includes(norm(x.name)));
    const partial = list.find((x) => {
      const n = norm(x.name);
      return n && wanted.some((w) => w.includes(n) || n.includes(w));
    });
    const fallback =
      ph.kind === 'user' || ph.kind === 'calendar' || list.length === 1 ? list[0] : undefined;
    out[ph.key] = (exact ?? partial ?? fallback)?.id ?? null;
  }
  return out;
}

function nameOf(kind: RefKind, id: string, c: WorkflowCatalogs): string | null {
  return candidatesAll(kind, c).find((x) => x.id === id)?.name ?? null;
}

/** Like `candidates`, archived ones included (a template can name an archived stage). */
function candidatesAll(kind: RefKind, c: WorkflowCatalogs): Candidate[] {
  if (kind === 'stage')
    return c.pipelines.flatMap((p) => p.stages.map((s) => ({ id: s.id, name: s.name })));
  if (kind === 'pipeline') return [...c.pipelines];
  if (kind === 'user') return c.team.map((p) => ({ id: p.userId, name: p.name }));
  if (kind === 'calendar') return [...c.calendars];
  if (kind === 'service') return [...(c.services ?? [])];
  if (kind === 'workflow') return [...(c.workflows ?? [])];
  return [...c.tags];
}

export interface ExtractedPlaceholder extends WorkflowPlaceholder {
  /** The id it replaced, so the same business can map it straight back. */
  readonly id: string;
}

/** Swaps every workspace id for a named placeholder (`stage_estimate_sent`), one key per distinct id. */
export function extractPlaceholders(
  def: WorkflowDefinition,
  catalogs: WorkflowCatalogs,
): { definition: WorkflowDefinition; placeholders: ExtractedPlaceholder[] } {
  const byId = new Map<string, ExtractedPlaceholder>();
  const used = new Set(placeholdersIn(def).map((p) => p.key));
  const definition = mapRefs(def, (site) => {
    if (typeof site.value !== 'string') return undefined;
    const k = `${site.kind}:${site.value}`;
    let ph = byId.get(k);
    if (!ph) {
      const name = nameOf(site.kind, site.value, catalogs);
      const slug = name ? norm(name).replace(/ /g, '_').slice(0, 40) : '';
      const base = slug ? `${site.kind}_${slug}` : site.kind;
      let key = base;
      for (let n = 2; used.has(key); n++) key = `${base}_${n}`;
      used.add(key);
      ph = { key, kind: site.kind, label: name ?? humanize(site.kind), id: site.value };
      byId.set(k, ph);
    }
    return { $ph: ph.key };
  });
  return { definition, placeholders: [...byId.values()] };
}

// ---- The recipes ----

export const RECIPE_KEYS = [
  'speed_to_lead',
  'missed_call_text_back',
  'appointment_follow_up_review',
  'estimate_follow_up',
  'no_show_rebook',
  'speed_to_lead_ai',
  'missed_call_text_back_ai',
] as const;
export type RecipeKey = (typeof RECIPE_KEYS)[number];

export interface WorkflowRecipe {
  readonly key: RecipeKey;
  readonly name: string;
  readonly description: string;
  readonly placeholders: readonly WorkflowPlaceholder[];
  readonly definition: WorkflowDefinitionInput;
}

const first = (fallback: string) => `{{person.first_name | default:"${fallback}"}}`;
const wait = (id: string, amount: number, unit: 'minutes' | 'hours' | 'days') => ({
  id,
  type: 'wait' as const,
  until: { kind: 'duration' as const, duration: { amount, unit } },
});
const text = (id: string, body: string, bookingCalendarId: unknown = null) => ({
  id,
  type: 'action' as const,
  action: 'send_text' as const,
  config: { body, bookingCalendarId: bookingCalendarId as never },
});
const task = (
  id: string,
  title: string,
  assignTo: Record<string, unknown>,
  due: unknown = null,
) => ({
  id,
  type: 'action' as const,
  action: 'create_task' as const,
  config: { title, assignTo: assignTo as never, due: due as never },
});
const calendarFilter = {
  match: 'all' as const,
  conditions: [{ field: 'appointment.calendar_id', op: 'eq' as const, value: { $ph: 'calendar' } }],
};
const handToTeammate = (id: string, config: Record<string, unknown>) => ({
  id,
  type: 'action' as const,
  action: 'hand_to_ai_teammate' as const,
  config: config as never,
});
/** "If nothing happened before the wait ran out, …; otherwise nothing." */
const ifTimedOut = (
  id: string,
  names: [string, string],
  ids: [string, string],
  steps: unknown[],
) => ({
  id,
  type: 'branch' as const,
  mode: 'if_else' as const,
  branches: [
    {
      id: ids[0],
      name: names[0],
      condition: {
        match: 'all' as const,
        conditions: [{ field: 'wait.timed_out', op: 'is_true' as const }],
      },
      steps: steps as never,
    },
    { id: ids[1], name: names[1], condition: null, steps: [] },
  ],
});

export const WORKFLOW_RECIPES: readonly WorkflowRecipe[] = [
  {
    key: 'speed_to_lead',
    name: 'Speed to lead',
    description:
      'Text every new lead right away, get the assignee calling, and check in the next day.',
    placeholders: [],
    definition: {
      version: 1,
      trigger: { kind: 'event', event: 'lead.created' },
      steps: [
        text(
          's_stltext1',
          `Hi ${first('there')}, thanks for reaching out to {{business.name}}! We got your request and will be in touch shortly. Reply here anytime.`,
        ),
        wait('s_stlwait1', 5, 'minutes'),
        task('s_stltask1', `Call ${first('the new lead')} about {{lead.title}}`, {
          kind: 'lead_assignee',
        }),
        wait('s_stlwait2', 1, 'days'),
        text(
          's_stltext2',
          `Hi ${first('there')}, just checking in from {{business.name}}. Want to pick a time? {{links.booking}}`,
        ),
      ],
      settings: { stopOn: ['reply', 'booking'] },
    },
  },
  {
    key: 'missed_call_text_back',
    name: 'Missed-call text back',
    description:
      'Text back a missed call, then let AI sort the reply: emergency, booking, question or other.',
    placeholders: [
      { key: 'on_call_user', kind: 'user', label: 'Who takes emergencies' },
      { key: 'booking_calendar', kind: 'calendar', label: 'Booking calendar' },
      { key: 'office_user', kind: 'user', label: 'Who answers questions' },
    ],
    definition: {
      version: 1,
      trigger: { kind: 'event', event: 'call.missed' },
      steps: [
        text(
          's_mcttext1',
          // Straight apostrophes in texts: a curly one forces the slower encoding, and the text counts as two.
          "Sorry we missed your call! This is {{business.name}}. How can we help? Reply here and we'll get right back to you.",
        ),
        {
          id: 's_mctwait1',
          type: 'wait',
          until: {
            kind: 'event',
            events: ['message.received'],
            timeout: { amount: 30, unit: 'minutes' },
          },
        },
        {
          id: 's_mctsort1',
          type: 'branch',
          mode: 'ai',
          branches: [
            {
              id: 'b_mctemerg',
              name: 'Emergency',
              description:
                'They describe an urgent problem: no heat or cooling, a leak, a gas smell, or say it’s an emergency',
              steps: [
                {
                  id: 's_mctalert',
                  type: 'action',
                  action: 'notify_team',
                  config: {
                    message: 'Emergency from {{person.name | default:"a caller"}}: call them now',
                  },
                },
                task(
                  's_mcttask1',
                  `Call ${first('the caller')} back now (emergency)`,
                  {
                    kind: 'user',
                    userId: { $ph: 'on_call_user' },
                  },
                  { amount: 15, unit: 'minutes' },
                ),
              ],
            },
            {
              id: 'b_mctbook0',
              name: 'Book',
              description: 'They want to book, schedule or get someone out',
              steps: [
                text(
                  's_mctbook1',
                  'Great! Pick a time that works for you here: {{links.booking}}',
                  {
                    $ph: 'booking_calendar',
                  },
                ),
              ],
            },
            {
              id: 'b_mctquest',
              name: 'Question',
              description: 'They ask a question',
              steps: [
                {
                  id: 's_mctasgn1',
                  type: 'action',
                  action: 'assign_conversation',
                  config: {
                    assignTo: { kind: 'user', userId: { $ph: 'office_user' } },
                    channel: 'sms',
                  },
                },
              ],
            },
            {
              id: 'b_mctother',
              name: 'Other',
              description: 'Anything else, or no reply',
              steps: [
                task('s_mcttask2', `Call ${first('the caller')} back`, {
                  kind: 'user',
                  userId: { $ph: 'office_user' },
                }),
              ],
            },
          ],
        },
      ],
    },
  },
  {
    key: 'appointment_follow_up_review',
    name: 'Appointment follow-up + review',
    description:
      'Thank the customer after a visit; happy customers get the review link, unhappy ones a call.',
    placeholders: [{ key: 'calendar', kind: 'calendar', label: 'Calendar' }],
    definition: {
      version: 1,
      trigger: { kind: 'event', event: 'appointment.completed', filters: calendarFilter },
      steps: [
        wait('s_afrwait1', 2, 'hours'),
        text(
          's_afrthank',
          `Thanks for choosing {{business.name}} today, ${first('friend')}! How did everything go?`,
        ),
        {
          id: 's_afrwait2',
          type: 'wait',
          until: {
            kind: 'event',
            events: ['message.received'],
            timeout: { amount: 2, unit: 'days' },
          },
        },
        {
          id: 's_afrsort1',
          type: 'branch',
          mode: 'ai',
          branches: [
            {
              id: 'b_afrunhap',
              name: 'Unhappy',
              description: 'They are unhappy, complain, or report a problem with the visit',
              steps: [
                task(
                  's_afrtask1',
                  `Call ${first('the customer')} about their visit`,
                  { kind: 'person_owner' },
                  {
                    amount: 1,
                    unit: 'days',
                  },
                ),
                {
                  id: 's_afrwrite',
                  type: 'ai',
                  task: 'write',
                  prompt:
                    'Write a short, sincere reply that apologizes the visit didn’t go well and says someone will call them today. Don’t offer refunds or discounts.',
                },
                {
                  id: 's_afrappr1',
                  type: 'approval',
                  message: 'Check this reply before it goes to the customer.',
                  previewStepId: 's_afrwrite',
                },
                text('s_afrsorry', '{{ai.message}}'),
              ],
            },
            {
              id: 'b_afrhappy',
              name: 'Happy',
              description: 'They are happy, or didn’t say anything negative',
              steps: [
                text(
                  's_afrrevw1',
                  'So glad to hear it! Would you mind leaving us a quick review? {{links.review}}',
                ),
              ],
            },
          ],
        },
      ],
    },
  },
  {
    key: 'estimate_follow_up',
    name: 'Estimate follow-up',
    description:
      'Follow up on a sent estimate by text, then email, then a task. Stops when it’s won, lost or they reply.',
    placeholders: [{ key: 'estimate_stage', kind: 'stage', label: 'Estimate sent' }],
    definition: {
      version: 1,
      trigger: {
        kind: 'event',
        event: 'lead.stage_changed',
        filters: {
          match: 'all',
          conditions: [
            { field: 'trigger.to_stage_id', op: 'eq', value: { $ph: 'estimate_stage' } },
          ],
        },
      },
      steps: [
        wait('s_efuwait1', 2, 'days'),
        text(
          's_efutext1',
          `Hi ${first('there')}, just following up on the estimate from {{business.name}}. Any questions? Happy to help.`,
        ),
        wait('s_efuwait2', 3, 'days'),
        {
          id: 's_efumail1',
          type: 'action',
          action: 'send_email',
          config: {
            subject: 'Your estimate from {{business.name}}',
            body: `Hi ${first('there')},\n\nI wanted to follow up on your estimate for {{lead.title}}. If you have any questions or want to get on the schedule, just reply to this email.\n\nThanks,\n{{business.name}}`,
          },
        },
        wait('s_efuwait3', 5, 'days'),
        task('s_efutask1', `Follow up with ${first('the customer')} on their estimate`, {
          kind: 'lead_assignee',
        }),
      ],
      settings: { stopOn: ['reply', 'lead_won', 'lead_lost'] },
    },
  },
  {
    key: 'no_show_rebook',
    name: 'No-show rebook',
    description:
      'When someone misses an appointment, text them the booking link; if they don’t rebook, make a task.',
    placeholders: [{ key: 'calendar', kind: 'calendar', label: 'Calendar' }],
    definition: {
      version: 1,
      trigger: { kind: 'event', event: 'appointment.no_show', filters: calendarFilter },
      steps: [
        wait('s_nsrwait1', 30, 'minutes'),
        text(
          's_nsrtext1',
          `Hi ${first('there')}, we missed you today! Want to pick a new time? {{links.booking}}`,
          { $ph: 'calendar' },
        ),
        wait('s_nsrwait2', 2, 'days'),
        task('s_nsrtask1', `Call ${first('the customer')} to rebook`, { kind: 'person_owner' }),
      ],
      settings: { stopOn: ['booking'] },
    },
  },
  {
    key: 'speed_to_lead_ai',
    name: 'Speed to lead with your AI teammate',
    description:
      'Your AI teammate messages every new lead right away and asks your qualifying questions. If the lead isn’t qualified within a day, their assignee gets a task.',
    placeholders: [],
    definition: {
      version: 1,
      trigger: { kind: 'event', event: 'lead.created' },
      steps: [
        handToTeammate('s_stlaihnd', {
          goal: 'qualify',
          firstMessage: 'ai_writes',
          channel: 'latest',
          note: 'A new lead just came in: {{lead.title}}.',
        }),
        {
          id: 's_stlaiwt1',
          type: 'wait',
          until: {
            kind: 'event',
            events: ['lead.qualified'],
            timeout: { amount: 1, unit: 'days' },
          },
        },
        ifTimedOut(
          's_stlaibr1',
          ['Not qualified yet', 'Qualified'],
          ['b_stlainot', 'b_stlaiqul'],
          [
            task('s_stlaitsk', `Follow up with ${first('the new lead')} about {{lead.title}}`, {
              kind: 'lead_assignee',
            }),
          ],
        ),
      ],
      settings: { stopOn: ['booking'] },
    },
  },
  {
    key: 'missed_call_text_back_ai',
    name: 'Missed-call text back with your AI teammate',
    description:
      'Your AI teammate texts back a missed call, helps with what they need and offers to book. If they don’t reply within a day, their owner gets a task to call.',
    placeholders: [],
    definition: {
      version: 1,
      trigger: { kind: 'event', event: 'call.missed' },
      steps: [
        handToTeammate('s_mctaihnd', {
          goal: 'book',
          firstMessage: 'ai_writes',
          channel: 'sms',
          note: 'We missed their call. Text them back, help with what they need and offer to book.',
        }),
        {
          id: 's_mctaiwt1',
          type: 'wait',
          until: {
            kind: 'event',
            events: ['message.received'],
            timeout: { amount: 1, unit: 'days' },
          },
        },
        ifTimedOut(
          's_mctaibr1',
          ['No reply', 'Replied'],
          ['b_mctainor', 'b_mctairep'],
          [task('s_mctaitsk', `Call ${first('the caller')} back`, { kind: 'person_owner' })],
        ),
      ],
      settings: { stopOn: ['booking'] },
    },
  },
];

export function recipeByKey(key: string): WorkflowRecipe | undefined {
  return WORKFLOW_RECIPES.find((r) => r.key === key);
}

/** A recipe's definition, parsed with every default (placeholders still in it). */
export function recipeDefinition(key: RecipeKey): WorkflowDefinition {
  const recipe = recipeByKey(key);
  if (!recipe) throw new RangeError(`No recipe ${key}.`);
  return WorkflowDefinition.parse(recipe.definition);
}
