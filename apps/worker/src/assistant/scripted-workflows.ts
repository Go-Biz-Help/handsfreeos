import type { ScriptRule } from '@hfos/ai';

/**
 * The scripted Assistant's workflow and knowledge phrases (scripted.ts puts them first). Ids come from the
 * context: the workflows it lists, the approvals waiting on the person, and the record on screen.
 */

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const parse = (json: string | undefined): Record<string, unknown> => {
  try {
    return json ? (JSON.parse(json) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/** The record on screen of this type ("On screen now: … (workflow id …)"). */
const onScreen = (context: string, type: string) =>
  new RegExp(`On screen now: [^\\n]*\\(${type} id ${UUID}\\)`).exec(context)?.[1];
/** The customer on screen, or the one a run on screen is for. */
const personHere = (context: string) => new RegExp(`\\(person id ${UUID}\\)`).exec(context)?.[1];

/** A workflow the context lists, by (part of) its name: "- Speed to lead [active] (workflow id …): …". */
function workflowNamed(context: string, words: string): string | undefined {
  const want = words
    .trim()
    .replace(/[.?!]+$/, '')
    .replace(/^(?:the|my|our)\s+/i, '')
    .replace(/\s+workflow$/i, '')
    .toLowerCase();
  if (!want) return undefined;
  for (const line of context.split('\n')) {
    const m = new RegExp(`^- (.+?) \\[[a-z]+\\] \\(workflow id ${UUID}\\)`).exec(line);
    if (m && m[1]!.toLowerCase().includes(want)) return m[2];
  }
  return undefined;
}

const firstApproval = (context: string) =>
  new RegExp(`\\(approval id ${UUID}\\)`).exec(context)?.[1];
const firstSentence = (s: string) => {
  const text = s.replace(/\s+/g, ' ').trim();
  return /^(.+?[.!?])(\s|$)/.exec(text)?.[1] ?? text;
};

/** The answer to a card-making tool: its error, a reason it can't go ahead, or the line given. */
const cardReply =
  (tool: string, fallback: string, ok: string, stopped: readonly string[] = []) =>
  (_q: string, r: Readonly<Record<string, string>>) => {
    if (!r[tool]) return fallback;
    const out = parse(r[tool]);
    if (out['error']) return `That didn’t work: ${String(out['error'])}`;
    for (const key of stopped) if (out[key]) return String(out[key]);
    return ok;
  };

const DRAFT_NEW =
  /^(?:build|make|create|draft) (?:me )?an? (?:new )?workflow (?:that|to|which) (.+)$/i;
const DRAFT_CHANGE = /^change (?:this|the) workflow (?:so it |so that it |to )?(.+)$/i;
const START = /^(?:put|start|add|enrol|enroll) (?:him|her|them) (?:in|on|into|to) (.+?)\.?$/i;
const PAUSE = /^pause (.+?)(?: for (?:today|now|a bit|a while))?\.?$/i;
const RESUME = /^(?:resume|unpause|turn back on) (.+?)\.?$/i;
const REMOVE = /^(?:take|remove) (?:him|her|them) (?:out of|from|off) (.+?)\.?$/i;
const DECIDE = /^(approve|reject)\b(.*)$/i;
const ASK_KNOWLEDGE = /^(?:do|does|can|are|is) (?:we|you|they|the business)\b.*\?$/i;
const SEARCH_KNOWLEDGE = /^search (?:the |our |my )?knowledge(?: base)? for (.+)$/i;
const ADD_KNOWLEDGE =
  /^add (?:an? )?(faq|fact|article)(?: to (?:the |our |my )?knowledge(?: base)?)?:\s*(.+?)\s+(?:—|--|=)\s+(.+)$/i;

export const workflowRules: ScriptRule[] = [
  {
    // "Build a workflow that texts new leads within a minute": a proposal for a new one.
    when: DRAFT_NEW,
    calls: (q) => [
      {
        name: 'draft_workflow',
        arguments: {
          description: q,
          ...(/new leads/i.test(q) ? { name: 'New lead text-back' } : {}),
        },
      },
    ],
    reply: cardReply(
      'draft_workflow',
      'I couldn’t draft that.',
      'Here’s a draft. Nothing runs until you open it, test it and publish it.',
    ),
  },
  {
    // On a workflow's page: "Change this workflow to wait two days instead".
    when: DRAFT_CHANGE,
    calls: (q, context) => {
      const workflowId = onScreen(context, 'workflow');
      return workflowId
        ? [
            {
              name: 'draft_workflow',
              arguments: { workflowId, description: DRAFT_CHANGE.exec(q)![1]! },
            },
          ]
        : [];
    },
    reply: cardReply(
      'draft_workflow',
      'Open the workflow first, then ask again.',
      'Here’s the change. Nothing changes until you open it and apply it.',
    ),
  },
  {
    when: /^(?:list|show)(?: me)? (?:my |our |the |all )?workflows\.?$|^what workflows\b/i,
    calls: () => [{ name: 'list_workflows', arguments: {} }],
    reply: (_q, r) => {
      const n = (parse(r['list_workflows'])['workflows'] as unknown[] | undefined)?.length ?? 0;
      return n ? `You have ${n === 1 ? 'one workflow' : `${n} workflows`}.` : 'No workflows yet.';
    },
  },
  {
    // On a customer's page: "Put him in Follow-up call".
    when: START,
    calls: (q, context) => {
      const personId = personHere(context);
      const workflowId = workflowNamed(context, START.exec(q)![1]!);
      return personId && workflowId
        ? [{ name: 'start_workflow', arguments: { workflowId, personId } }]
        : [];
    },
    reply: cardReply(
      'start_workflow',
      'Open a customer and name the workflow, then ask again.',
      'Here’s what would happen. Nothing starts until you OK it.',
      ['cannotStart'],
    ),
  },
  {
    when: PAUSE,
    calls: (q, context) => {
      const workflowId = workflowNamed(context, PAUSE.exec(q)![1]!);
      return workflowId ? [{ name: 'pause_workflow', arguments: { workflowId } }] : [];
    },
    reply: cardReply(
      'pause_workflow',
      'I can’t find that workflow.',
      'Pausing stops anything new from starting it. Nothing changes until you OK it.',
      ['cannotPause'],
    ),
  },
  {
    when: RESUME,
    calls: (q, context) => {
      const workflowId = workflowNamed(context, RESUME.exec(q)![1]!);
      return workflowId ? [{ name: 'resume_workflow', arguments: { workflowId } }] : [];
    },
    reply: cardReply(
      'resume_workflow',
      'I can’t find that workflow.',
      'Here’s what resuming does. Nothing changes until you OK it.',
      ['cannotResume'],
    ),
  },
  {
    when: REMOVE,
    calls: (q, context) => {
      const personId = personHere(context);
      const workflowId = workflowNamed(context, REMOVE.exec(q)![1]!);
      return personId && workflowId
        ? [{ name: 'remove_contact_from_workflow', arguments: { workflowId, personId } }]
        : [];
    },
    reply: cardReply(
      'remove_contact_from_workflow',
      'Open a customer and name the workflow, then ask again.',
      'Here’s what would stop. Nothing changes until you OK it.',
      ['nothingToDo'],
    ),
  },
  {
    // "Approve it", "Approve it with: …", "Reject it because …": the first approval waiting on them.
    when: DECIDE,
    calls: (q, context) => {
      const approvalId = firstApproval(context);
      if (!approvalId) return [];
      const [, verb, rest] = DECIDE.exec(q)!;
      const reject = /^reject$/i.test(verb!);
      const withText = /\bwith:\s*(.+)$/i.exec(rest!)?.[1]?.trim();
      const because = /\bbecause\s+(.+)$/i.exec(rest!)?.[1]?.trim();
      return [
        {
          name: 'answer_workflow_approval',
          arguments: {
            approvalId,
            decision: reject ? 'reject' : 'approve',
            ...(!reject && withText ? { message: withText } : {}),
            ...(reject && because ? { reason: because } : {}),
          },
        },
      ];
    },
    reply: (q, r) =>
      cardReply(
        'answer_workflow_approval',
        'Nothing is waiting on you right now.',
        /^reject/i.test(q)
          ? 'Here’s the rejection. Nothing changes until you OK it.'
          : 'Here’s what goes out. It goes as soon as you OK it.',
        ['cannotDecide'],
      )(q, r),
  },
  {
    // "Do we offer financing?": answered from the knowledge base, or it says it doesn't know.
    when: new RegExp(`${ASK_KNOWLEDGE.source}|${SEARCH_KNOWLEDGE.source}`, 'i'),
    calls: (q) => [
      {
        name: 'search_knowledge',
        arguments: { query: SEARCH_KNOWLEDGE.exec(q)?.[1] ?? q },
      },
    ],
    reply: (_q, r) => {
      const out = parse(r['search_knowledge']);
      const items = (out['items'] as { title: string; text: string }[] | undefined) ?? [];
      const first = items[0];
      if (out['error']) return `That didn’t work: ${String(out['error'])}`;
      return first
        ? `From your knowledge base: ${firstSentence(first.text)}`
        : 'Your knowledge base doesn’t say. Tell me the answer and I can add it as a draft FAQ.';
    },
  },
  {
    // "Add an FAQ: Do you work weekends? — Yes, Saturdays 9 to 1."
    when: ADD_KNOWLEDGE,
    calls: (q) => {
      const [, kind, title, body] = ADD_KNOWLEDGE.exec(q)!;
      return [
        {
          name: 'add_knowledge_item',
          arguments: {
            kind: kind!.toLowerCase(),
            title: title!.trim(),
            body: body!.replace(/\s*,?\s*and publish it\.?$/i, '').trim(),
            publish: /\band publish it\.?$/i.test(q),
          },
        },
      ];
    },
    reply: cardReply(
      'add_knowledge_item',
      'I couldn’t add that.',
      'Here it is. It’s saved once you OK it.',
    ),
  },
];
