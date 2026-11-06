/**
 * What the Assistant reads of AI Sales Coach's answers, and what its cards say (each operation's `ai.answer`, `ai.card`
 * and `ai.outcome`, in ../../kernel/types.ts): a call's write-up ahead of what was said, the live call's stage and
 * step in place of its whole playbook, the team ahead of each rep, and on a card the playbook, suggestion or call by
 * its name rather than its id. They only reshape what the kernel gave the person, so they never show more than the
 * screens do.
 *
 * Browser-safe and pure.
 */
import { playbookStages, SALES_STAGE_LABELS, stageAt } from './method';
import {
  PLAYBOOK_KIND_LABELS,
  PlaybookDraftInput,
  type PlaybookKind,
  type PlaybookStep,
} from './playbooks';
import { SALESCOACH_WORDS as W } from './words';

type Bag = Record<string, unknown>;
type Line = { readonly label: string; readonly value: string };
type Card = { readonly title: string; readonly lines: readonly Line[]; readonly warning?: string };
type Outcome = { readonly words: string; readonly path?: string | null } | null;

const isObject = (v: unknown): v is Bag => typeof v === 'object' && v !== null && !Array.isArray(v);
const listOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const kindLabel = (kind: unknown): string =>
  PLAYBOOK_KIND_LABELS[kind as PlaybookKind] ?? PLAYBOOK_KIND_LABELS.any;

/** The tabs' addresses, under the business's (`/app/w/<id>/`): where a confirmed change's card links. */
const PAGE = 'a/salescoach';
const PLAYBOOKS_PAGE = `${PAGE}?view=playbooks`;

/** About how long a list of playbooks can run and still be read whole; past it each is read briefly. */
const PLAYBOOKS_WHOLE = 14_000;

/** A playbook in brief: its kind, whether it's the usual one, its steps by title and the objections it answers. */
function briefPlaybook(p: unknown): unknown {
  if (!isObject(p)) return p;
  const details = isObject(p['details']) ? p['details'] : {};
  return {
    id: p['id'],
    name: p['name'],
    kind: p['kind'],
    kindLabel: kindLabel(p['kind']),
    isDefault: p['isDefault'],
    archivedAt: p['archivedAt'],
    steps: listOf(details['steps']).map((s) => (isObject(s) ? s['title'] : s)),
    objections: listOf(details['objections']).map((o) => (isObject(o) ? o['objection'] : o)),
    talkingPoints: listOf(details['points']).length,
  };
}

/**
 * The playbooks as the model reads them: each whole with its kind in the screens' words, while they fit; past that,
 * each in brief (its steps by title, the objections it answers, how many talking points), to read one whole by its
 * id. One asked for by its id is always whole.
 */
export function playbooksAnswer(output: unknown, input: unknown): unknown {
  if (!isObject(output) || !Array.isArray(output['playbooks'])) return output;
  const all = output['playbooks'].map((p) =>
    isObject(p) ? { ...p, kindLabel: kindLabel(p['kind']) } : p,
  );
  const one = isObject(input) && typeof input['playbookId'] === 'string';
  if (one || JSON.stringify(all).length <= PLAYBOOKS_WHOLE) return { playbooks: all };
  return {
    brief: true,
    note: 'Too many to read whole here, so each shows its steps by title and the objections it answers. Pass playbookId to read one whole: what to say at each step, and each objection’s answer.',
    playbooks: all.map(briefPlaybook),
  };
}

/**
 * The call the coach hears now as the model reads it: where the call is (the stage and the step, "n of m", as the
 * screen shows them) in place of the whole playbook, then the cards, newest first. The playbook's words are one
 * salescoach_list_playbooks away, by its id.
 */
export function liveAnswer(output: unknown): unknown {
  if (!isObject(output) || !isObject(output['call'])) return output;
  const { playbook, step, cards, ...call } = output['call'];
  const book = isObject(playbook) ? playbook : null;
  // The kernel gave the playbook as its schema says, so its steps are a playbook's steps.
  const steps = listOf(isObject(book?.['details']) ? book['details']['steps'] : []).filter(
    isObject,
  ) as unknown as PlaybookStep[];
  const stepId = typeof step === 'string' ? step : null;
  const stages = playbookStages(steps);
  const now = stages.length ? (stageAt(steps, stepId) ?? stages[0]!) : null;
  const at = steps.findIndex((s) => s.id === stepId);
  const current = steps[Math.max(0, at)];
  return {
    call: {
      ...call,
      playbook: book ? { id: book['id'], name: book['name'], steps: steps.length } : null,
      stage: now
        ? { name: SALES_STAGE_LABELS[now], n: stages.indexOf(now) + 1, of: stages.length }
        : null,
      step: current
        ? { id: current.id, title: current.title, n: Math.max(1, at + 1), of: steps.length }
        : null,
    },
    cards: listOf(cards),
  };
}

/**
 * One coached call as the model reads it: the call, why there's no write-up, the write-up and the cards, then what was
 * said last, from `linesFrom`. A long call's lines are what's cut when it's too long to read whole, never the
 * write-up.
 */
export function callAnswer(output: unknown, input: unknown): unknown {
  if (!isObject(output) || !isObject(output['call'])) return output;
  const { lines, result, failure, cards, ...call } = output['call'];
  const from = isObject(input) && typeof input['linesFrom'] === 'number' ? input['linesFrom'] : 0;
  return {
    call,
    failure: failure ?? null,
    result: result ?? null,
    cards: listOf(cards),
    linesFrom: from,
    lines: listOf(lines),
  };
}

/** A row of the coached calls with only what the list shows: its rep by name, and nothing that's empty. */
function callRow(row: unknown): unknown {
  if (!isObject(row)) return row;
  const rep = isObject(row['rep']) ? row['rep']['name'] : null;
  const kept: Bag = {
    id: row['id'],
    state: row['state'],
    channel: row['channel'],
    // The list marks only a call that wasn't in English.
    language: row['language'] === 'en' ? null : row['language'],
    rep,
    person: row['person'],
    playbookName: row['playbookName'],
    startedAt: row['startedAt'],
    score: row['score'],
    wonHow: row['wonHow'],
    conversationId: row['conversationId'],
  };
  return Object.fromEntries(Object.entries(kept).filter(([, v]) => v !== null && v !== undefined));
}

/** The coached calls as the model reads them: each row as the list shows it, so fifty fit. */
export function callListAnswer(output: unknown): unknown {
  if (!isObject(output) || !Array.isArray(output['calls'])) return output;
  return { calls: output['calls'].map(callRow) };
}

/**
 * Trends as the model reads them: the team first, as the screen shows it first, then each rep. With more than one rep
 * and none asked for, each rep's week-by-week line is left out (the team's is there), so every rep fits.
 */
export function trendsAnswer(output: unknown, input: unknown): unknown {
  if (!isObject(output) || !Array.isArray(output['reps'])) return output;
  const one = isObject(input) && typeof input['userId'] === 'string';
  const reps = output['reps'];
  const brief = !one && reps.length > 1;
  return {
    weeks: output['weeks'],
    timeZone: output['timeZone'],
    team: output['team'],
    ...(brief
      ? {
          note: 'Each rep’s week-by-week scores are left out here; pass userId for one rep’s weeks.',
        }
      : {}),
    reps: brief
      ? reps.map((r) => {
          if (!isObject(r)) return r;
          const { series: _series, ...rest } = r;
          return rest;
        })
      : reps,
  };
}

/** A step, objection or talking point without the parts that are empty, which a save fills back in. */
const withoutBlanks = (part: unknown): unknown =>
  isObject(part)
    ? Object.fromEntries(Object.entries(part).filter(([, v]) => v !== '' && v !== null))
    : part;

/**
 * A playbook the AI drafted, as the model reads it: its name, the kind of call it was asked for, and its details with
 * the empty parts left out (a save fills them back in), so a long draft still comes back whole, ready to pass to
 * salescoach_playbook_save as it is.
 */
export function draftAnswer(output: unknown, input: unknown): unknown {
  if (!isObject(output) || !isObject(output['details'])) return output;
  const details = output['details'];
  const asked = PlaybookDraftInput.safeParse(input ?? {});
  return {
    name: output['name'],
    kind: asked.success ? asked.data.kind : undefined,
    details: {
      steps: listOf(details['steps']).map(withoutBlanks),
      objections: listOf(details['objections']).map(withoutBlanks),
      points: listOf(details['points']).map(withoutBlanks),
    },
    saved: false,
  };
}

// ---------- cards ----------

/** "3: Open the call, Ask about the problem, …": a list's count, then its parts by name. */
const named = (count: number, names: readonly string[]) =>
  count === 0 ? 'None' : `${count}: ${names.filter(Boolean).join(', ')}`;

/** The lines that say what's in a playbook: its kind, whether it's the usual one, and its parts. */
function playbookLines(p: Bag): Line[] {
  const details = isObject(p['details']) ? p['details'] : {};
  const steps = listOf(details['steps']).filter(isObject);
  const objections = listOf(details['objections']).filter(isObject);
  const points = listOf(details['points']).filter(isObject);
  return [
    { label: W.playbooks.kind, value: kindLabel(p['kind']) },
    {
      label: W.playbooks.usual,
      value:
        p['isDefault'] === true
          ? 'Yes: calls use it when no playbook is for how they started'
          : 'No',
    },
    {
      label: W.playbooks.steps,
      value: named(
        steps.length,
        steps.map((s) => text(s['title'])),
      ),
    },
    {
      label: W.playbooks.objections,
      value: named(
        objections.length,
        objections.map((o) => text(o['objection'])),
      ),
    },
    {
      label: W.playbooks.points,
      value: named(
        points.length,
        points.map((t) => text(t['topic'])),
      ),
    },
  ];
}

/** What a change to a playbook gives, in the editor's words. */
function changedParts(input: Bag): string[] {
  const details = isObject(input['details']) ? input['details'] : {};
  return [
    ...(input['name'] !== undefined ? [W.playbooks.name] : []),
    ...(input['kind'] !== undefined ? [W.playbooks.kind] : []),
    ...(details['steps'] !== undefined ? [W.playbooks.steps] : []),
    ...(details['objections'] !== undefined ? [W.playbooks.objections] : []),
    ...(details['points'] !== undefined ? [W.playbooks.points] : []),
    ...(input['isDefault'] === true ? [W.playbooks.makeUsual] : []),
  ];
}

/** Saving a playbook: which one, by name, what it holds once saved, and on a change what changes. */
export function playbookSaveCard(output: unknown, input: unknown): Card | null {
  if (!isObject(output) || !isObject(input)) return null;
  const name = text(output['name']);
  const isNew = input['playbookId'] === undefined;
  const changes = changedParts(input);
  const onlyUsual = !isNew && changes.length === 1 && input['isDefault'] === true;
  return {
    title: isNew
      ? `Add the “${name}” playbook?`
      : onlyUsual
        ? `Make “${name}” the usual playbook?`
        : `Change the “${name}” playbook?`,
    lines: [
      ...(!isNew && !onlyUsual
        ? [{ label: 'Changes', value: changes.join(', ') || 'Nothing' }]
        : []),
      ...playbookLines(output),
    ],
  };
}

/** Archiving a playbook, or bringing it back: which one, and what that does to calls. */
export function playbookArchiveCard(output: unknown, input: unknown): Card | null {
  if (!isObject(output) || !isObject(input)) return null;
  const name = text(output['name']);
  const archiving = input['archived'] === true;
  return {
    title: archiving ? `Archive the “${name}” playbook?` : `Bring back the “${name}” playbook?`,
    lines: [
      {
        label: 'What happens',
        value: archiving
          ? 'Calls stop using it, and it can be brought back from Playbooks. If it was the usual one, the next one in use becomes the usual one.'
          : 'Calls can use it again.',
      },
      ...playbookLines(output).filter((l) => l.label !== W.playbooks.usual),
    ],
  };
}

export const playbookSaveOutcome = (): Outcome => ({
  words: W.playbooks.saved,
  path: PLAYBOOKS_PAGE,
});

export function playbookArchiveOutcome(output: unknown, input: unknown): Outcome {
  if (!isObject(output) || !isObject(input)) return null;
  const name = text(output['name']);
  return {
    words: input['archived'] === true ? `“${name}” is archived.` : `“${name}” is back in use.`,
    path: PLAYBOOKS_PAGE,
  };
}

/** Using a lesson from wins, or putting it away: the playbook, the objection, the answer now and the one suggested. */
export function lessonCard(output: unknown, input: unknown): Card | null {
  if (!isObject(output) || !isObject(input)) return null;
  const book = text(output['playbookName']);
  const use = input['use'] === true;
  const better = output['kind'] === 'better_answer';
  const current = text(output['current']);
  return {
    title: !use
      ? `Put away this suggestion for “${book}”?`
      : better
        ? `Use the better answer in “${book}”?`
        : `Add this objection to “${book}”?`,
    lines: [
      { label: W.playbooks.objection, value: text(output['objection']) },
      ...(better && current ? [{ label: W.learn.now, value: current }] : []),
      { label: W.learn.suggested, value: text(output['answer']) },
      {
        label: 'What happens',
        value: use
          ? better
            ? 'The playbook’s answer changes now; the coach uses it from the next call.'
            : 'The objection and its answer go into the playbook now; the coach uses them from the next call.'
          : 'Nothing changes in the playbook, and it isn’t suggested again for 30 days.',
      },
    ],
  };
}

export function lessonOutcome(_output: unknown, input: unknown): Outcome {
  const use = isObject(input) && input['use'] === true;
  return { words: use ? W.learn.used : 'Suggestion put away.', path: PLAYBOOKS_PAGE };
}

/** Whose call it is, as the card names it: "your call with Dana Lee", or "your call now". */
function yourCall(output: Bag): string {
  const person = isObject(output['person']) ? text(output['person']['name']) : '';
  return person ? `your call with ${person}` : 'your call now';
}

/** Stopping the coach on the rep's own call: which call, and that nothing from it is kept unless it starts again. */
export function callStopCard(output: unknown): Card | null {
  if (!isObject(output)) return null;
  return {
    title: `Stop the coach on ${yourCall(output)}?`,
    lines: [
      {
        label: 'What happens',
        value:
          'No more cards, and nothing from this call is kept or written up, unless you start the coach again before the call ends.',
      },
    ],
  };
}

/** Starting the coach again on the rep's own call. */
export function callResumeCard(output: unknown): Card | null {
  if (!isObject(output)) return null;
  return {
    title: `Start the coach again on ${yourCall(output)}?`,
    lines: [
      {
        label: 'What happens',
        value: 'The cards come back, and the write-up has the whole call.',
      },
    ],
  };
}

export const callStopOutcome = (): Outcome => ({ words: W.live.stopped, path: PAGE });
export const callResumeOutcome = (): Outcome => ({
  words: 'The coach is listening again.',
  path: PAGE,
});
