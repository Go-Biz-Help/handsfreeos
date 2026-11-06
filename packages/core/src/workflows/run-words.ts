/**
 * Runs and test logs in plain words (in core so the web's Runs, run page, Test tab and customer card, and the
 * Assistant, say the same): where a run stands, why it ended, one short note per step read from what the engine
 * logged (a text's decisions, a wait's wake time, the path a branch took, a refusal's reason), how a test came out,
 * the paths a run didn't take, and whether a customer can be added to a workflow now. Browser-safe.
 */
import type { z } from 'zod';
import type { WorkflowRunStatusValue, WorkflowStepStatusValue } from '../schemas/workflow';
import { durationMinutes, durationText } from './conditions';
import type { Reentry, Step, WorkflowDefinition } from './definition';
import { describeStep, refName, type WorkflowNames } from './describe';
import type { RefKind } from './ids';
import { allSteps, findStep } from './walk';

export type RunStatus = z.infer<typeof WorkflowRunStatusValue>;
export type RunStepStatus = z.infer<typeof WorkflowStepStatusValue>;

type Json = Record<string, unknown>;

/** One row of a run's step log, as `workflow.run_get` gives it. */
export interface RunStepRow {
  readonly stepKey: string;
  readonly status: RunStepStatus;
  readonly attempt: number;
  readonly input: Json | null;
  readonly output: Json | null;
  readonly error: Json | null;
  readonly finishedAt: string | null;
}

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const lowerFirst = (s: string) => (s ? s[0]!.toLowerCase() + s.slice(1) : s);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const runTruncate = (s: string, n = 90) =>
  s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;

/** A step's title, the part of its line before any detail: "Send a text" of "Send a text: “Hi Maria…”". */
export function runStepTitle(step: Step, names: WorkflowNames, def: WorkflowDefinition): string {
  const line = describeStep(step, names, def);
  const at = line.indexOf(': ');
  return at > 0 && at < 60 ? line.slice(0, at) : line;
}

// ---- Times ----

function dayKey(d: Date, timeZone: string) {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(d);
}

/** "10:41 AM" where the business is. */
export function runClockText(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(
    new Date(iso),
  );
}

/** "10:41:02 AM", for a test's step log. */
export function runClockSeconds(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(iso));
}

/** "Today, 10:41 AM", "Yesterday, 4:12 PM", "Tomorrow, 8:03 AM", "Mon, Sep 14, 9:00 AM". */
export function runWhenText(iso: string, timeZone: string, now = Date.now()): string {
  const d = new Date(iso);
  const day = dayKey(d, timeZone);
  const time = runClockText(iso, timeZone);
  if (day === dayKey(new Date(now), timeZone)) return `Today, ${time}`;
  if (day === dayKey(new Date(now - 86_400_000), timeZone)) return `Yesterday, ${time}`;
  if (day === dayKey(new Date(now + 86_400_000), timeZone)) return `Tomorrow, ${time}`;
  const date = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(d);
  return `${date}, ${time}`;
}

// ---- Runs ----

/** Each status's badge, as Runs and the run page show it. */
export const RUN_STATUS: Record<
  RunStatus,
  { label: string; variant: 'ok' | 'gray' | 'pending' | 'danger' | 'accent' }
> = {
  running: { label: 'Running', variant: 'accent' },
  waiting: { label: 'Waiting', variant: 'accent' },
  awaiting_approval: { label: 'Needs approval', variant: 'pending' },
  held: { label: 'Held', variant: 'pending' },
  completed: { label: 'Completed', variant: 'ok' },
  stopped: { label: 'Stopped', variant: 'gray' },
  failed: { label: 'Failed', variant: 'danger' },
};

export const LIVE_RUN: readonly RunStatus[] = ['running', 'waiting', 'awaiting_approval', 'held'];
export const isLiveRun = (status: RunStatus) => LIVE_RUN.includes(status);

/** The Runs page's status filter (All, Going, Needs approval, Failed, Completed, Stopped) as run statuses. */
export const RUN_STATUS_FILTERS = {
  all: null,
  waiting: ['running', 'waiting', 'held'],
  awaiting_approval: ['awaiting_approval'],
  failed: ['failed'],
  completed: ['completed'],
  stopped: ['stopped'],
} as const satisfies Record<string, readonly RunStatus[] | null>;

/** Each step row's badge on the run page. */
export const RUN_STEP_STATUS: Record<RunStepStatus, string> = {
  running: 'Running',
  done: 'Done',
  skipped: 'Skipped',
  waiting: 'Waiting',
  failed: 'Failed',
  dead: 'Failed',
};

/** Why a rule stopped a step, in words that finish "because …". */
const RULE_WORDS: Record<string, string> = {
  lead_archived: 'the lead is archived',
  person_archived: 'the customer is archived',
  recipient_suppressed: 'email to them is stopped',
  unmapped_placeholder: 'a detail isn’t set for this business yet',
  not_found: 'something it needed was deleted',
  validation: 'a value wasn’t valid',
  forbidden: 'it wasn’t allowed',
  quiet_hours: 'it’s quiet hours',
  no_email_address: 'there’s no address to send email from',
  workflow_not_active: 'that workflow isn’t on',
  stage_archived: 'the stage is archived',
};

const STOP_ON: Record<string, string> = {
  reply: 'They replied',
  booking: 'They booked',
  lead_won: 'The lead was won',
  lead_lost: 'The lead was lost',
};

/** Why a run ended, in plain words. */
export function endReasonText(reason: string | null | undefined): string | null {
  if (!reason) return null;
  if (reason.startsWith('stop_on:'))
    return STOP_ON[reason.slice('stop_on:'.length)] ?? 'A stop setting matched';
  switch (reason) {
    case 'finished':
      return 'It finished every step';
    case 'end_step':
      return 'It reached an End step';
    case 'rejected':
      return 'The approval was rejected';
    case 'approval_expired':
      return 'The approval expired';
    case 'approval_cancelled':
      return 'The approval was cancelled';
    case 'max_days':
      return 'It ran for the most days a run can last';
    case 'step_limit':
      return 'It reached the limit of 200 steps';
    case 'workflow_archived':
      return 'The workflow was archived';
    case 'removed_from_workflow':
      return 'They were taken out of the workflow';
    case 'removed_by_workflow':
      return 'Another workflow took them out';
    case 'stopped_by_person':
      return 'Someone stopped it';
    case 'step_failed':
      return 'A step failed';
    case 'outdated':
      return 'The draft changed during the test';
    default:
      if (RULE_WORDS[reason]) return `A step was refused because ${RULE_WORDS[reason]}`;
      // A reason someone typed when they stopped it, or a rule this list doesn't know yet.
      return /^[a-z_]+$/.test(reason) ? `Stopped: ${reason.replace(/_/g, ' ')}` : reason;
  }
}

/** A run's one-line state for lists: "Waiting", "Stopped · They replied". */
export function runLine(r: { status: RunStatus; endReason: string | null }): string {
  const status = RUN_STATUS[r.status].label;
  const why = isLiveRun(r.status) ? null : endReasonText(r.endReason);
  return why ? `${status} · ${why}` : status;
}

// ---- Steps ----

/** Why a step was skipped or couldn't text, in words that finish "Skipped: …". */
export function skipReasonText(reason: string | null | undefined): string {
  switch (reason) {
    case 'no_phone':
      return 'no mobile number';
    case 'opted_out':
      return 'they opted out of texts';
    case 'no_consent':
      return 'they haven’t agreed to texts';
    case 'texting_not_ready':
    case 'messaging_not_ready':
      return 'texting isn’t set up yet';
    case 'no_number':
      return 'no business number yet';
    case 'no_email':
      return 'no email address';
    case 'recipient_suppressed':
      return 'email to them is stopped';
    case 'person_archived':
      return 'the customer is archived';
    case 'no_person':
      return 'no customer';
    case 'no_lead':
      return 'no lead';
    case 'no_conversation':
      return 'no conversation yet';
    case 'no_task':
      return 'no task to complete';
    case 'missing_variable':
      return 'a detail is missing';
    case 'quiet_hours':
      return 'quiet hours';
    case 'late_event':
      return 'what started it reached HandsFreeOS more than 30 minutes after it happened';
    case 'same_workflow':
      return 'a workflow can’t start itself';
    case 'depth_limit':
      return 'too many workflows started each other';
    case 'workflow_not_active':
      return 'that workflow isn’t on';
    case 'no_recipients':
      return 'nobody to notify';
    case 'no_call_consent':
      return 'they haven’t agreed to calls in writing';
    case 'not_business_landline':
      return 'they haven’t agreed to calls in writing, and their number isn’t a business landline';
    case 'no_calls':
      return 'they asked not to be called';
    case 'no_teammate':
      return 'the AI teammate is off';
    case 'already_called':
      return 'it already called them for this run';
    case 'no_tester':
      return 'no email address to send the test to';
    case 'by_person':
      return 'skipped by hand';
    case 'refused':
      return 'it was refused';
    default:
      return reason ? reason.replace(/_/g, ' ') : 'nothing to do';
  }
}

export interface RunDecision {
  readonly check: string;
  readonly result: string;
  readonly reason?: string;
  readonly until?: string;
}

export function decisionsOf(output: Json | null | undefined): RunDecision[] {
  const d = output?.['decisions'];
  return Array.isArray(d) ? (d.filter(isObj) as unknown as RunDecision[]) : [];
}

/** The checks before a text, one line each: consent, quiet hours, and email when it fell back to email. */
export function decisionLines(decisions: readonly RunDecision[], timeZone: string): string[] {
  return decisions.map((d) => {
    if (d.check === 'consent') {
      if (d.result === 'ok')
        return d.reason === 'opted_in'
          ? 'Texting: they agreed to texts'
          : 'Texting: they texted or called in the last day';
      if (d.result === 'blocked') return `Texting: can’t, ${skipReasonText(d.reason)}`;
      if (d.result === 'email_instead')
        return `Texting: can’t (${skipReasonText(d.reason)}), so email`;
      if (d.result === 'skip') return `Texting: can’t (${skipReasonText(d.reason)}), so skip`;
    }
    if (d.check === 'quiet_hours') {
      if (d.result === 'ok') return 'Quiet hours: not now';
      if (d.result === 'wait')
        return `Quiet hours: waits until ${d.until ? runWhenText(d.until, timeZone) : 'they end'}`;
      if (d.result === 'email_instead') return 'Quiet hours: sends an email instead';
      if (d.result === 'skip') return 'Quiet hours: skips the text';
    }
    if (d.check === 'email')
      return d.result === 'ok' ? 'Email: ok' : `Email: can’t, ${skipReasonText(d.reason)}`;
    return `${d.check}: ${d.result}`;
  });
}

/** A step's id and visit from its key ("s_stltext1#2"). */
export function stepKeyParts(key: string): { stepId: string; visit: number } {
  const at = key.lastIndexOf('#');
  return at < 0
    ? { stepId: key, visit: 1 }
    : { stepId: key.slice(0, at), visit: Number(key.slice(at + 1)) || 1 };
}

const WAIT_EVENT: Record<string, string> = {
  'message.received': 'a reply',
  'appointment.booked': 'a booking',
  'call.missed': 'a call',
};

/** What an event wait is waiting for: "a reply", "a reply or a booking". */
function waitingFor(step: Step | undefined): string {
  if (step?.type !== 'wait' || step.until.kind !== 'event') return 'it';
  const words = step.until.events.map((e) => WAIT_EVENT[e] ?? 'the event');
  return [...new Set(words)].join(' or ');
}

/** Knowledge an AI step used ("FAQ “Do you offer financing?”"), when it logged any. */
export function knowledgeUsed(output: Json | null | undefined): string[] {
  const items = output?.['items'];
  if (!Array.isArray(items)) return [];
  const KIND: Record<string, string> = {
    faq: 'FAQ',
    article: 'Article',
    fact: 'Fact',
    document: 'File',
  };
  return items.filter(isObj).map((i) => {
    const kind = KIND[str(i['kind']) ?? ''];
    const title = str(i['title']) ?? 'an item';
    return kind ? `${kind} “${title}”` : title;
  });
}

/** The message a step sent or would send, for a quote under the note. */
export function messageOf(row: Pick<RunStepRow, 'input' | 'output'>): string | null {
  const out = row.output ?? {};
  const inp = row.input ?? {};
  return str(out['body']) ?? str(inp['body']) ?? str(out['value']) ?? null;
}

/** One short line about what a step did, or would do in a test. */
export function stepNote(
  step: Step | undefined,
  row: Pick<RunStepRow, 'status' | 'attempt' | 'output' | 'error' | 'input' | 'finishedAt'>,
  opts: { timeZone: string; names: WorkflowNames; def: WorkflowDefinition | null },
): string {
  const out = (row.output ?? {}) as Json;
  const err = (row.error ?? {}) as Json;
  const tz = opts.timeZone;
  const tries = row.attempt > 1 ? ` · ${plural(row.attempt, 'try', 'tries')}` : '';

  if (row.status === 'failed' || row.status === 'dead') {
    const why = str(err['message']) ?? 'Something went wrong.';
    return `${row.status === 'dead' ? `Failed after ${plural(row.attempt, 'try', 'tries')}` : 'Failed'}: ${why}`;
  }
  if (row.status === 'running') return 'Running now';
  if (row.status === 'skipped') {
    const reason = str(out['skipped']);
    if (reason === 'by_person') return 'Skipped by hand';
    if (reason === 'refused') return `Skipped: ${str(err['message']) ?? 'it was refused'}`;
    if (reason === 'missing_variable') {
      const missing = Array.isArray(out['missing']) ? out['missing'].map(String) : [];
      return missing.length
        ? `Skipped: no value for ${missing.map((m) => `{{${m}}}`).join(', ')}`
        : 'Skipped: a detail is missing';
    }
    return `Skipped: ${skipReasonText(reason)}`;
  }
  if (row.status === 'waiting') {
    if (out['held'] === 'quiet_hours' && str(out['until']))
      return `Waits until ${runWhenText(str(out['until'])!, tz)} (quiet hours)`;
    if (step?.type === 'approval')
      return str(out['expiresAt'])
        ? `Waiting for an approval, until ${runWhenText(str(out['expiresAt'])!, tz)}`
        : 'Waiting for an approval';
    const wake = str(out['wakeAt']);
    if (step?.type === 'wait' && step.until.kind === 'event')
      return wake
        ? `Waiting for ${waitingFor(step)}, until ${runWhenText(wake, tz)}`
        : `Waiting for ${waitingFor(step)}`;
    return wake ? `Waiting until ${runWhenText(wake, tz)}` : 'Waiting';
  }

  // Done.
  if (out['simulated'] === true) {
    const would = str(out['would']);
    if (would === 'text') return `Would send: “${runTruncate(str(out['body']) ?? '')}”`;
    if (would === 'email') {
      const instead = str(out['instead']);
      const subject = str(out['subject']);
      return instead
        ? `Would email instead (${skipReasonText(instead)})${subject ? `: “${runTruncate(subject, 60)}”` : ''}`
        : `Would email ${str(out['to']) ?? 'them'}${subject ? `: “${runTruncate(subject, 60)}”` : ''}`;
    }
    if (would === 'wait')
      return `Would wait until ${str(out['until']) ? runWhenText(str(out['until'])!, tz) : 'morning'} (quiet hours)`;
    if (would === 'skip') return `Would skip: ${skipReasonText(str(out['reason']))}`;
    if (would === 'nothing') return 'Would do nothing: email to the team is off';
    const title = step && opts.def ? runStepTitle(step, opts.names, opts.def) : 'do this';
    return `Would ${lowerFirst(title)}${tries}`;
  }
  if (str(out['sentToTester']))
    return out['channel'] === 'sms'
      ? `Emailed to you as a text preview (${str(out['sentToTester'])})`
      : `Emailed to you (${str(out['sentToTester'])})`;
  if (str(out['end'])) return 'The run ended here';
  if (!step) return 'Done';

  switch (step.type) {
    case 'wait': {
      const wake = str(out['wakeAt']);
      if (out['anchorMissing']) return 'No date to wait for, so it moved on';
      if (out['alreadyPast']) return 'That time had passed, so it moved on';
      if (out['fastForwarded']) {
        if (step.until.kind === 'event')
          return out['timedOut'] === false
            ? `Assumed ${waitingFor(step)} came in time`
            : `Assumed no ${waitingFor(step)} came, so it timed out`;
        return wake
          ? `Would wait until ${runWhenText(wake, tz)}; the test skips waits`
          : 'The test skips waits';
      }
      if (step.until.kind === 'event')
        return out['timedOut'] === false
          ? `${waitingFor(step)[0]!.toUpperCase()}${waitingFor(step).slice(1)} came in`
          : `No ${waitingFor(step)} came, so it timed out`;
      return wake ? `Waited until ${runWhenText(wake, tz)}` : 'Waited';
    }
    case 'branch': {
      const id = str(out['branchId']);
      const name =
        str(out['branch']) ?? (id ? step.branches.find((b) => b.id === id)?.name : null) ?? null;
      const matched = str(out['matched']);
      if (!id || matched === 'none') return 'No path matched, so it went past the paths';
      const how =
        matched === 'assumed'
          ? ' (chosen for the test)'
          : matched === 'ai'
            ? ' (the AI picked it)'
            : matched === 'fallback'
              ? ' (the AI couldn’t pick, so the fallback)'
              : '';
      return `Took “${name ?? 'a path'}”${how}`;
    }
    case 'approval':
      if (out['autoApproved']) return 'Approved automatically in the test';
      if (out['decision'] === 'rejected') return 'Rejected';
      return out['edited'] ? 'Approved, with an edit' : 'Approved';
    case 'ai': {
      const value = str(out['value']);
      const task = str(out['task']) ?? step.task;
      const base =
        task === 'classify'
          ? `AI sorted it as ${value ?? 'Other'}`
          : task === 'summarize'
            ? 'AI summarized it'
            : value
              ? `AI wrote: “${runTruncate(value)}”`
              : 'AI wrote nothing, so the fallback was used';
      const why = out['assumed']
        ? ' (chosen for the test)'
        : out['fallback'] === true
          ? str(out['reason']) === 'budget_reached'
            ? ' (today’s AI limit was reached, so the fallback)'
            : ' (the fallback)'
          : '';
      return `${base}${why}`;
    }
    case 'goto': {
      const target = opts.def ? findStep(opts.def, step.target) : null;
      return target
        ? `Went back to “${runStepTitle(target.step, opts.names, opts.def!)}”`
        : 'Went back';
    }
    case 'end':
      return 'The run ended here';
    case 'action':
      break;
  }

  // Actions that ran for real.
  const at = row.finishedAt ? ` at ${runClockText(row.finishedAt, tz)}` : '';
  switch (step.action) {
    case 'send_text':
      if (out['channel'] === 'email')
        return `Emailed ${str(out['to']) ?? 'them'} instead (${skipReasonText(str(out['instead']))})${at}`;
      return `Sent to ${str(out['to']) ?? 'them'}${at}`;
    case 'send_email':
      return `Emailed ${str(out['to']) ?? 'them'}${at}`;
    case 'create_task':
      return 'Created the task';
    case 'complete_task': {
      const n = Array.isArray(out['completed']) ? out['completed'].length : 0;
      return n ? `Completed ${plural(n, 'task')}` : 'No task to complete';
    }
    case 'add_tag':
      return 'Added the tag';
    case 'remove_tag':
      return 'Removed the tag';
    case 'create_lead':
      return 'Created the lead';
    case 'move_lead_stage':
      return 'Moved the lead';
    case 'assign_lead':
      return 'Assigned the lead';
    case 'set_next_action':
      return 'Set the next action';
    case 'add_note':
      return 'Added the note';
    case 'assign_conversation':
      return 'Assigned the conversation';
    case 'close_conversation':
      return 'Closed the conversation';
    case 'update_person': {
      const fields = Array.isArray(out['updated']) ? out['updated'].map(String) : [];
      return fields.length ? `Updated ${fields.join(', ')}` : 'Nothing to change';
    }
    case 'notify_team': {
      const emailed = Array.isArray(out['emailed']) ? out['emailed'].map(String) : [];
      return emailed.length ? `Emailed ${emailed.join(', ')}` : 'Noted, no email';
    }
    case 'webhook_out':
      return `Sent${typeof out['status'] === 'number' ? ` (the other app answered ${out['status']})` : ''}${tries}`;
    case 'enrol_workflow':
      return out['already'] ? 'They were already in it' : 'Started it';
    case 'remove_from_workflow': {
      const n = Array.isArray(out['stopped']) ? out['stopped'].length : 0;
      return n ? `Took them out of ${plural(n, 'run')}` : 'They weren’t in it';
    }
  }
  return 'Done';
}

/** Each step's newest log row, by step id. */
export function latestRows<R extends Pick<RunStepRow, 'stepKey'>>(
  steps: readonly R[],
): Map<string, R> {
  const byStep = new Map<string, R>();
  for (const s of steps) {
    const { stepId, visit } = stepKeyParts(s.stepKey);
    const had = byStep.get(stepId);
    if (!had || stepKeyParts(had.stepKey).visit <= visit) byStep.set(stepId, s);
  }
  return byStep;
}

/** "“Emergency” and “Other” weren’t used", for the branches a run went through. Null when none. */
export function unusedPaths(
  def: WorkflowDefinition,
  rows: ReadonlyMap<string, Pick<RunStepRow, 'status' | 'output'>>,
): string | null {
  const names: string[] = [];
  for (const { step } of allSteps(def)) {
    if (step.type !== 'branch') continue;
    const row = rows.get(step.id);
    if (!row || row.status !== 'done') continue;
    const took = row.output?.['branchId'];
    for (const b of step.branches) if (b.id !== took) names.push(`“${b.name}”`);
  }
  if (!names.length) return null;
  const list =
    names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return `${list} ${names.length === 1 ? 'wasn’t' : 'weren’t'} used`;
}

export type RunTestOutcome = 'running' | 'passed' | 'failed' | 'outdated' | 'stopped';

/** How a test run came out. */
export function testOutcome(
  run: { status: RunStatus; endReason: string | null },
  steps: readonly Pick<RunStepRow, 'status'>[],
): RunTestOutcome {
  if (isLiveRun(run.status)) return 'running';
  if (run.endReason === 'outdated') return 'outdated';
  if (run.status === 'failed' || steps.some((s) => s.status === 'failed' || s.status === 'dead'))
    return 'failed';
  if (run.status === 'stopped') return 'stopped';
  return 'passed';
}

/** The first step that failed, with the step it belongs to. */
export function failedStep<R extends Pick<RunStepRow, 'stepKey' | 'status'>>(
  def: WorkflowDefinition | null,
  steps: readonly R[],
): { row: R; step: Step | undefined } | null {
  const row = [...steps].reverse().find((s) => s.status === 'failed' || s.status === 'dead');
  if (!row) return null;
  const { stepId } = stepKeyParts(row.stepKey);
  return { row, step: def ? findStep(def, stepId)?.step : undefined };
}

// ---- What a step was set to do, and what came back ----

const REF_KEYS: Record<string, RefKind> = {
  assigneeUserId: 'user',
  stageId: 'stage',
  pipelineId: 'pipeline',
  tagId: 'tag',
  workflowId: 'workflow',
};

const LABELS: Record<string, string> = {
  channel: 'Channel',
  to: 'To',
  subject: 'Subject',
  title: 'Title',
  notes: 'Notes',
  dueAt: 'Due',
  assigneeUserId: 'Assigned to',
  stageId: 'Stage',
  pipelineId: 'Pipeline',
  tagId: 'Tag',
  target: 'On the',
  mode: 'Change',
  workflowId: 'Workflow',
  message: 'Message',
  text: 'Text',
  lostReason: 'Lost reason',
  url: 'Address',
  wakeAt: 'Wakes',
  wokeAt: 'Woke',
  until: 'Until',
  expiresAt: 'Expires',
  value: 'Answer',
  status: 'Answer',
  instead: 'Instead, because',
  would: 'Would',
  emailed: 'Emailed',
  completed: 'Completed',
  updated: 'Updated',
  stopped: 'Stopped',
  fields: 'Changes',
  kind: 'Kind',
  timedOut: 'Timed out',
  branch: 'Path',
  matched: 'Chosen by',
  key: 'Saved as',
  task: 'Task',
  model: 'Model',
  tokens: 'AI tokens',
  reason: 'Why',
  note: 'Note',
  sentToTester: 'Sent to',
  via: 'By',
  missing: 'Missing',
  rule: 'Rule',
};

/** Keys shown elsewhere (the message, the checks, knowledge) or that only mean something to the engine. */
const HIDDEN = new Set([
  'decisions',
  'items',
  'body',
  'simulated',
  'messageId',
  'conversationId',
  'taskId',
  'taskIds',
  'tagIds',
  'runId',
  'activityId',
  'deliveryId',
  'approvalId',
  'approvers',
  'branchId',
  'duplicate',
  'held',
  'fastForwarded',
  'manualRetries',
  'retryRequestedBy',
  'skippedBy',
  'skipped',
  'end',
  'autoApproved',
  'events',
  'leadId',
  'fallback',
  'assumed',
  'workspaceId',
  'personId',
]);

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const humanize = (k: string) => {
  const s = k
    .replace(/([A-Z])/g, ' $1')
    .replace(/_/g, ' ')
    .trim()
    .toLowerCase();
  return s ? s[0]!.toUpperCase() + s.slice(1) : k;
};

function fieldValue(
  key: string,
  v: unknown,
  names: WorkflowNames,
  timeZone: string,
): string | null {
  if (v === null || v === undefined || v === '') return null;
  const kind = REF_KEYS[key];
  if (kind && typeof v === 'string') return refName(kind, v, names);
  if (key === 'channel') return v === 'sms' ? 'Text' : v === 'email' ? 'Email' : String(v);
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return ISO.test(v) ? runWhenText(v, timeZone) : v;
  if (Array.isArray(v)) {
    const out = v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(', ');
    return out || null;
  }
  return runTruncate(JSON.stringify(v), 200);
}

/** One line of a step's What it was set to do or What came back, as the run page lists it. */
export interface RunStepField {
  readonly key: string;
  readonly label: string;
  readonly value: string;
}

/**
 * What a step was set to do (its input) or what came back (its output), as the run page lists them: each in words,
 * with names for the ids, leaving out what is shown elsewhere (the message, the checks, the knowledge) or means
 * something only to the engine.
 */
export function runStepFields(
  obj: Readonly<Record<string, unknown>> | null | undefined,
  names: WorkflowNames,
  timeZone: string,
): RunStepField[] {
  if (!obj) return [];
  return Object.entries(obj).flatMap(([k, v]) => {
    if (HIDDEN.has(k)) return [];
    const value = fieldValue(k, v, names, timeZone);
    return value === null ? [] : [{ key: k, label: LABELS[k] ?? humanize(k), value }];
  });
}

// ---- Adding someone ----

/**
 * Whether a workflow can take a customer now, and a line saying why or what happens, as "Add to workflow…" on their
 * page says it. `runs` are theirs, newest first. With `cooldown` (a workflow that lets them start any time, at most so
 * often), a run started within it stops another, as the engine does.
 */
export function workflowAvailability(
  w: {
    status: string;
    reentry: Reentry['mode'] | string;
    description?: string | null;
    cooldown?: Extract<Reentry, { mode: 'always' }>['cooldown'] | null;
  },
  runs: readonly { status: RunStatus; startedAt: string }[],
  first: string,
  timeZone: string,
  now = Date.now(),
): { ok: boolean; note: string } {
  if (w.status === 'paused') return { ok: false, note: 'Paused. Resume it to add people.' };
  const date = (iso: string) =>
    new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric' }).format(
      new Date(iso),
    );
  const live = runs.find((r) => isLiveRun(r.status));
  if (w.reentry === 'once' && runs.length)
    return {
      ok: false,
      note: `${first} went through it on ${date(runs[0]!.startedAt)}. It runs once for each customer.`,
    };
  if (live && w.reentry !== 'always')
    return { ok: false, note: `Already in it. It can start again after ${first} finishes.` };
  if (w.reentry === 'always' && w.cooldown && runs.length) {
    const since = now - Date.parse(runs[0]!.startedAt);
    if (since < durationMinutes(w.cooldown) * 60_000)
      return {
        ok: false,
        note: `${first} started it on ${date(runs[0]!.startedAt)}. It can start for them again ${durationText(w.cooldown)} after that.`,
      };
  }
  return { ok: true, note: w.description || 'Starts at its first step right away.' };
}
