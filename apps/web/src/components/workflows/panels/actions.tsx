'use client';
import {
  formatClock,
  RCS_LIMITS,
  richSmsText,
  stepsBefore,
  UPDATABLE_PERSON_FIELDS,
  variablesAt,
  WEBHOOK_PARTS,
  type ActionStep,
} from '@hfos/core';
import { Moon, Plus, Sparkles, X } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input, Select } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { stepLines } from '@/lib/workflows/steps';
import { useEditor } from '../editor-context';
import { VariableField } from '../variable-field';
import {
  AssignToSelect,
  Note,
  OptionalDuration,
  PanelField,
  PeoplePicker,
  RadioRow,
  RefSelect,
  useDraftText,
  useStepUpdate,
} from './fields';

type Of<A extends ActionStep['action']> = Extract<ActionStep, { action: A }>;

/** The settings for one action step, then what happens if it fails. */
export function ActionPanel({ step }: { step: ActionStep }) {
  const update = useStepUpdate(step.id);
  const { readOnly } = useEditor();
  return (
    <div data-testid={`panel-action-${step.action}`}>
      <ActionFields step={step} />
      <PanelField label="If this step fails" htmlFor={`onerror-${step.id}`}>
        <Select
          id={`onerror-${step.id}`}
          selectSize="sm"
          value={step.onError}
          disabled={readOnly}
          onChange={(e) =>
            update({ onError: e.target.value }, 'Change what happens if the step fails')
          }
        >
          <option value="stop">Stop the run</option>
          <option value="continue">Carry on with the next step</option>
        </Select>
      </PanelField>
    </div>
  );
}

function ActionFields({ step }: { step: ActionStep }) {
  switch (step.action) {
    case 'send_text':
      return <SendText step={step} />;
    case 'send_email':
      return <SendEmail step={step} />;
    case 'update_person':
      return <UpdatePerson step={step} />;
    case 'add_tag':
    case 'remove_tag':
      return <TagFields step={step} />;
    case 'create_lead':
      return <CreateLead step={step} />;
    case 'move_lead_stage':
      return <MoveLead step={step} />;
    case 'assign_lead':
      return <AssignLead step={step} />;
    case 'set_next_action':
      return <NextAction step={step} />;
    case 'create_task':
      return <CreateTask step={step} />;
    case 'complete_task':
      return <CompleteTask step={step} />;
    case 'add_note':
      return <AddNote step={step} />;
    case 'assign_conversation':
    case 'close_conversation':
      return <ConversationFields step={step} />;
    case 'notify_team':
      return <NotifyTeam step={step} />;
    case 'webhook_out':
      return <WebhookOut step={step} />;
    case 'enrol_workflow':
    case 'remove_from_workflow':
      return <WorkflowRef step={step} />;
    case 'hand_to_ai_teammate':
      return <HandToTeammate step={step} />;
  }
}

/** Where the business's AI teammate stands, and that nothing happens at this step while it's off. */
function TeammateStatusNote() {
  const { teammate, workspaceId } = useEditor();
  const href = `/app/w/${workspaceId}/ai-team`;
  const link = (label: string) => (
    <Link href={href} className="font-medium text-accent-text hover:underline">
      {label}
    </Link>
  );
  // An agency template: each business's own teammate takes it from here.
  if (teammate === undefined)
    return (
      <Note icon={Sparkles} className="mb-3.5" testId="hand-to-ai-status">
        Each business’s own AI teammate takes the conversation. While a business’s teammate is off,
        nothing happens at this step.
      </Note>
    );
  if (teammate === null)
    return (
      <Note icon={Sparkles} className="mb-3.5" testId="hand-to-ai-status">
        This business has no AI teammate yet, so nothing happens at this step. {link('Set one up')}
      </Note>
    );
  const status =
    teammate.status === 'off'
      ? `${teammate.name} is off, so nothing happens at this step until someone turns it on.`
      : teammate.status === 'training'
        ? `${teammate.name} is on with training wheels: its messages wait for an OK in the inbox.`
        : `${teammate.name} is on and replies on its own.`;
  return (
    <Note icon={Sparkles} className="mb-3.5" testId="hand-to-ai-status">
      {status} {link(`Open ${teammate.name}`)}
    </Note>
  );
}

/**
 * "Hand to the AI teammate": what it works toward (reply and help, the qualifying questions, or booking), whether
 * it writes first or waits for them, which conversation it takes, and a note it reads before it writes.
 */
function HandToTeammate({ step }: { step: Of<'hand_to_ai_teammate'> }) {
  const update = useStepUpdate(step.id);
  const vars = useVars(step.id);
  const { readOnly, teammate } = useEditor();
  const name = teammate?.name ?? 'The AI teammate';
  const c = step.config;
  const note = useDraftText(c.note, (next) =>
    update({ config: { note: next } }, 'Edit the note', { group: 'note', quiet: true }),
  );
  const goals: { key: typeof c.goal; title: string; detail: string }[] = [
    {
      key: 'respond',
      title: 'Reply and help',
      detail: 'It answers their questions from your Knowledge.',
    },
    {
      key: 'qualify',
      title: 'Ask the qualifying questions',
      detail: 'The questions in its Qualify skill. The answers show on the lead.',
    },
    {
      key: 'book',
      title: 'Get them booked',
      detail: 'It offers times from the calendars in its Book skill.',
    },
  ];
  return (
    <>
      <TeammateStatusNote />
      <PanelField label="What it works toward">
        <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="What it works toward">
          {goals.map((g) => (
            <RadioRow
              key={g.key}
              on={c.goal === g.key}
              onSelect={() => update({ config: { goal: g.key } }, 'Change what it works toward')}
              title={g.title}
              detail={g.detail}
              testId={`hand-to-ai-goal-${g.key}`}
            />
          ))}
        </div>
      </PanelField>
      <PanelField label="First message">
        <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="First message">
          <RadioRow
            on={c.firstMessage === 'ai_writes'}
            onSelect={() =>
              update({ config: { firstMessage: 'ai_writes' } }, 'Change the first message')
            }
            title={`${name} writes first`}
            detail="Consent and quiet hours apply: it never texts first without consent, and it emails instead when it can’t text."
            testId="hand-to-ai-first-ai_writes"
          />
          <RadioRow
            on={c.firstMessage === 'none'}
            onSelect={() =>
              update({ config: { firstMessage: 'none' } }, 'Change the first message')
            }
            title="Wait for them to write"
            detail={`${name} answers their next message.`}
            testId="hand-to-ai-first-none"
          />
        </div>
      </PanelField>
      <PanelField label="Which conversation" htmlFor={`hand-channel-${step.id}`}>
        <Select
          id={`hand-channel-${step.id}`}
          selectSize="sm"
          value={c.channel}
          disabled={readOnly}
          onChange={(e) =>
            update({ config: { channel: e.target.value } }, 'Change the conversation')
          }
          data-testid="hand-to-ai-channel"
        >
          <option value="latest">Whichever they used last</option>
          <option value="sms">Their texts</option>
          <option value="email">Their email</option>
        </Select>
      </PanelField>
      <div className="mb-3.5">
        <VariableField
          id={`hand-note-${step.id}`}
          label={`What ${name} should know (optional)`}
          multiline
          value={note.value}
          onChange={note.change}
          error={note.error}
          variables={vars}
          maxLength={500}
          preview="plain"
          hint={`${name} reads this before it writes. Customers never see it.`}
        />
      </div>
    </>
  );
}

function useVars(stepId: string) {
  const { def } = useEditor();
  return useMemo(() => variablesAt(def, stepId), [def, stepId]);
}

const clock = (hhmm: string) => formatClock(hhmm).replace(':00', '');

/** "Quiet hours are 8 PM to 8 AM. A text due then waits until 8 AM." */
export function QuietHoursNote() {
  const { quietHours, def } = useEditor();
  const qh = quietHours ?? { enabled: true, start: '20:00', end: '08:00' };
  if (!qh.enabled)
    return (
      <Note icon={Moon} className="mb-3.5" testId="quiet-hours-note">
        Quiet hours are off for this business, so texts can go out at any time.
      </Note>
    );
  const then = {
    wait: `A text due then waits until ${clock(qh.end)}.`,
    email_instead: 'A text due then goes as an email instead.',
    skip: 'A text due then is skipped.',
  }[def.settings.quietHours];
  return (
    <Note icon={Moon} className="mb-3.5" testId="quiet-hours-note">
      Quiet hours are {clock(qh.start)} to {clock(qh.end)}. {then}
    </Note>
  );
}

function BookingLink({
  stepId,
  value,
}: {
  stepId: string;
  value: Of<'send_text'>['config']['bookingCalendarId'];
}) {
  const update = useStepUpdate(stepId);
  return (
    <PanelField label="Booking link opens" hint="Where the message says {{links.booking}}.">
      <RefSelect
        kind="calendar"
        label="Booking link opens"
        value={value}
        none="Your main booking page"
        onChange={(v) => update({ config: { bookingCalendarId: v } }, 'Change the booking link')}
      />
    </PanelField>
  );
}

function SendText({ step }: { step: Of<'send_text'> }) {
  const update = useStepUpdate(step.id);
  const { apply, def, readOnly } = useEditor();
  const vars = useVars(step.id);
  const body = useDraftText(step.config.body, (next) =>
    update({ config: { body: next } }, 'Edit the text', { group: 'body', quiet: true }),
  );
  return (
    <>
      <div className="mb-3.5">
        <VariableField
          id={`body-${step.id}`}
          label="Message"
          multiline
          value={body.value}
          onChange={body.change}
          error={body.error}
          variables={vars}
          maxLength={1600}
          preview="sms"
          testId="text-body"
        />
      </div>
      <ReplyButtonsField step={step} />
      <QuietHoursNote />
      <BookingLink stepId={step.id} value={step.config.bookingCalendarId} />
      <PanelField
        label="If they haven’t agreed to texts"
        htmlFor={`consent-${step.id}`}
        hint="STOP always wins. A reply to their own call or text within 24 hours is allowed."
      >
        <Select
          id={`consent-${step.id}`}
          selectSize="sm"
          value={def.settings.noConsent}
          disabled={readOnly}
          onChange={(e) =>
            apply(
              [
                {
                  op: 'set_settings',
                  patch: { noConsent: e.target.value as 'skip' | 'email_fallback' },
                },
              ],
              'Change what happens without text consent',
            )
          }
        >
          <option value="email_fallback">Send an email instead</option>
          <option value="skip">Skip the text</option>
        </Select>
      </PanelField>
    </>
  );
}

/** "Reply 1 for Yes or 2 for No.": how a phone without RCS shows the buttons, in core's own words. */
function choicesLine(titles: readonly string[]): string {
  return richSmsText('', {
    kind: 'buttons',
    title: null,
    cards: [],
    buttons: titles.map((title, i) => ({ type: 'reply' as const, title, id: `preview.r${i + 1}` })),
  });
}

/**
 * Reply buttons under the text (0103): tapped where the customer's phone shows RCS, answered with a number where
 * it doesn't. Either way the reply names the button, so a later check can branch on "Button they chose in
 * their reply". Kept as typed while a name is still wrong, like the text itself.
 */
function ReplyButtonsField({ step }: { step: Of<'send_text'> }) {
  const update = useStepUpdate(step.id);
  const { readOnly } = useEditor();
  const saved = step.config.replyButtons;
  const [local, setLocal] = useState<string[]>([...saved]);
  const [seen, setSeen] = useState(saved);
  const [error, setError] = useState<string | null>(null);
  if (saved !== seen) {
    setSeen(saved);
    // Undo, or another editor's change: show what is saved, unless it is what is being typed.
    if (saved.join('\n') !== local.map((t) => t.trim()).join('\n')) {
      setLocal([...saved]);
      setError(null);
    }
  }
  const change = (next: string[], label: string) => {
    setLocal(next);
    const out = update({ config: { replyButtons: next } }, label, {
      group: 'reply-buttons',
      quiet: true,
    });
    setError(out.ok ? null : out.message);
  };
  const named = local.map((t) => t.trim()).filter(Boolean);
  return (
    <PanelField
      label="Reply buttons"
      error={error}
      hint={
        named.length
          ? `Phones without RCS get them written out: “${choicesLine(named)}”`
          : 'Optional. Customers tap one where their phone supports RCS, or text back its number.'
      }
    >
      <div className="flex flex-col gap-1.5" data-testid="reply-buttons">
        {local.map((t, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <Input
              inputSize="sm"
              value={t}
              maxLength={RCS_LIMITS.buttonTitle}
              placeholder={i === 0 ? 'Yes' : i === 1 ? 'No' : 'Another choice'}
              aria-label={`Reply button ${i + 1}`}
              disabled={readOnly}
              onChange={(e) =>
                change(
                  local.map((x, j) => (j === i ? e.target.value : x)),
                  'Edit a reply button',
                )
              }
              data-testid="reply-button"
            />
            {readOnly ? null : (
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Remove reply button ${i + 1}`}
                onClick={() =>
                  change(
                    local.filter((_, j) => j !== i),
                    'Remove a reply button',
                  )
                }
              >
                <X className="h-4 w-4" strokeWidth={1.75} />
              </Button>
            )}
          </div>
        ))}
        {!readOnly && local.length < RCS_LIMITS.cardButtons ? (
          <button
            type="button"
            onClick={() => setLocal([...local, ''])}
            className="inline-flex w-fit items-center gap-1 text-xs font-medium text-accent-text hover:underline"
            data-testid="add-reply-button"
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={2} />
            Add a reply button
          </button>
        ) : null}
      </div>
    </PanelField>
  );
}

function SendEmail({ step }: { step: Of<'send_email'> }) {
  const update = useStepUpdate(step.id);
  const vars = useVars(step.id);
  const subject = useDraftText(step.config.subject, (next) =>
    update({ config: { subject: next } }, 'Edit the subject', { group: 'subject', quiet: true }),
  );
  const body = useDraftText(step.config.body, (next) =>
    update({ config: { body: next } }, 'Edit the email', { group: 'body', quiet: true }),
  );
  return (
    <>
      <div className="mb-3.5">
        <VariableField
          id={`subject-${step.id}`}
          label="Subject"
          value={subject.value}
          onChange={subject.change}
          error={subject.error}
          variables={vars}
          maxLength={200}
          testId="email-subject"
        />
      </div>
      <div className="mb-3.5">
        <VariableField
          id={`email-${step.id}`}
          label="Email"
          multiline
          rows={6}
          value={body.value}
          onChange={body.change}
          error={body.error}
          variables={vars}
          maxLength={10000}
          preview="email"
          testId="email-body"
        />
      </div>
      <BookingLink stepId={step.id} value={step.config.bookingCalendarId} />
    </>
  );
}

const PERSON_FIELD_LABELS: Record<(typeof UPDATABLE_PERSON_FIELDS)[number], string> = {
  first_name: 'First name',
  last_name: 'Last name',
  email: 'Email',
  phone: 'Phone',
  city: 'City',
  source: 'Source',
  notes: 'Notes',
};

function UpdatePerson({ step }: { step: Of<'update_person'> }) {
  const update = useStepUpdate(step.id);
  const { readOnly } = useEditor();
  const fields = step.config.fields;
  const set = (next: typeof fields, label: string, group?: string) =>
    update({ config: { fields: next } }, label, { group, quiet: !!group });
  const unused = UPDATABLE_PERSON_FIELDS.filter((k) => !fields.some((f) => f.field === k));
  return (
    <PanelField label="Set these details" hint="Use {{ to copy in a detail, like {{ai.summary}}.">
      <div className="flex flex-col gap-1.5">
        {fields.map((f) => (
          <PersonFieldRow
            key={f.field}
            field={f.field}
            value={f.value}
            options={UPDATABLE_PERSON_FIELDS.filter((k) => k === f.field || unused.includes(k))}
            canRemove={fields.length > 1}
            onField={(k) =>
              set(
                fields.map((x) => (x.field === f.field ? { ...x, field: k } : x)),
                'Change a detail',
              )
            }
            onValue={(v) =>
              set(
                fields.map((x) => (x.field === f.field ? { ...x, value: v } : x)),
                'Change a detail',
                `field-${f.field}`,
              )
            }
            onRemove={() =>
              set(
                fields.filter((x) => x.field !== f.field),
                'Remove a detail',
              )
            }
          />
        ))}
        {unused.length && !readOnly ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 self-start px-1.5"
            onClick={() => set([...fields, { field: unused[0]!, value: '' }], 'Add a detail')}
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
            Add a detail
          </Button>
        ) : null}
      </div>
    </PanelField>
  );
}

function PersonFieldRow({
  field,
  value,
  options,
  canRemove,
  onField,
  onValue,
  onRemove,
}: {
  field: (typeof UPDATABLE_PERSON_FIELDS)[number];
  value: string;
  options: readonly (typeof UPDATABLE_PERSON_FIELDS)[number][];
  canRemove: boolean;
  onField: (k: (typeof UPDATABLE_PERSON_FIELDS)[number]) => void;
  onValue: (v: string) => ReturnType<ReturnType<typeof useStepUpdate>>;
  onRemove: () => void;
}) {
  const { readOnly } = useEditor();
  const text = useDraftText(value, onValue);
  return (
    <div className="grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.3fr)_26px] items-center gap-1.5">
      <Select
        selectSize="sm"
        aria-label="Detail"
        value={field}
        disabled={readOnly}
        onChange={(e) => onField(e.target.value as (typeof UPDATABLE_PERSON_FIELDS)[number])}
      >
        {options.map((k) => (
          <option key={k} value={k}>
            {PERSON_FIELD_LABELS[k]}
          </option>
        ))}
      </Select>
      <Input
        inputSize="sm"
        aria-label={`New ${PERSON_FIELD_LABELS[field].toLowerCase()}`}
        value={text.value}
        invalid={!!text.error}
        readOnly={readOnly}
        onChange={(e) => text.change(e.target.value)}
      />
      {canRemove && !readOnly ? (
        <Button
          variant="ghost"
          size="icon"
          className="h-[26px] w-[26px]"
          aria-label="Remove"
          onClick={onRemove}
        >
          <X className="h-3.5 w-3.5" strokeWidth={1.75} />
        </Button>
      ) : (
        <span />
      )}
    </div>
  );
}

function hasLead(vars: ReturnType<typeof variablesAt>) {
  return vars.some((v) => v.source === 'lead');
}

function TagFields({ step }: { step: Of<'add_tag'> | Of<'remove_tag'> }) {
  const update = useStepUpdate(step.id);
  const { catalogs, readOnly } = useEditor();
  const vars = useVars(step.id);
  return (
    <>
      <PanelField
        label={step.action === 'add_tag' ? 'Add' : 'Remove'}
        hint={
          catalogs.tags.length
            ? undefined
            : 'This business has no tags yet. Add them from a customer’s page.'
        }
      >
        <RefSelect
          kind="tag"
          label="Tag"
          value={step.config.tagId}
          onChange={(v) => {
            if (v) return update({ config: { tagId: v } }, 'Change the tag');
          }}
        />
      </PanelField>
      <PanelField label="To">
        <Segmented
          ariaLabel="Tag"
          value={step.config.target}
          onChange={(target) => {
            if (!readOnly) update({ config: { target } }, 'Change what gets the tag');
          }}
          options={[
            { value: 'person', label: 'The customer' },
            {
              value: 'lead',
              label: 'Their lead',
              disabled: !hasLead(vars) && step.config.target !== 'lead',
              title: 'Only when the workflow has a lead',
            },
          ]}
        />
      </PanelField>
    </>
  );
}

function StageFields({
  stepId,
  pipelineId,
  stageId,
}: {
  stepId: string;
  pipelineId: Of<'create_lead'>['config']['pipelineId'];
  stageId: Of<'create_lead'>['config']['stageId'];
}) {
  const update = useStepUpdate(stepId);
  const { catalogs, readOnly } = useEditor();
  const pipeline = catalogs.pipelines.find((p) => p.id === pipelineId);
  const stages = pipeline?.stages.filter((s) => !s.archived) ?? [];
  const stageKnown = stages.some((s) => s.id === stageId);
  return (
    <>
      <PanelField label="Pipeline">
        <RefSelect
          kind="pipeline"
          label="Pipeline"
          value={pipelineId}
          onChange={(v) => {
            if (!v) return;
            const first = catalogs.pipelines
              .find((p) => p.id === v)
              ?.stages.find((s) => !s.archived);
            if (first)
              return update(
                { config: { pipelineId: v, stageId: first.id } },
                'Change the pipeline',
              );
          }}
        />
      </PanelField>
      <PanelField label="Stage">
        <Select
          selectSize="sm"
          aria-label="Stage"
          className={stageKnown ? undefined : 'border-danger'}
          value={stageKnown ? String(stageId) : ''}
          disabled={readOnly || !pipeline}
          onChange={(e) => update({ config: { stageId: e.target.value } }, 'Change the stage')}
        >
          {!stageKnown ? (
            <option value="" disabled>
              Pick a stage
            </option>
          ) : null}
          {stages.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      </PanelField>
    </>
  );
}

function CreateLead({ step }: { step: Of<'create_lead'> }) {
  const update = useStepUpdate(step.id);
  const { readOnly } = useEditor();
  const vars = useVars(step.id);
  const title = useDraftText(step.config.title, (next) =>
    update({ config: { title: next } }, 'Name the lead', { group: 'title', quiet: true }),
  );
  const value = useDraftText(step.config.value === null ? '' : String(step.config.value), (next) =>
    update(
      { config: { value: next.trim() === '' ? null : Number(next) } },
      'Change the lead’s value',
      { group: 'value', quiet: true },
    ),
  );
  return (
    <>
      <div className="mb-3.5">
        <VariableField
          id={`lead-title-${step.id}`}
          label="Lead title"
          value={title.value}
          onChange={title.change}
          error={title.error}
          variables={vars}
          maxLength={160}
        />
      </div>
      <StageFields
        stepId={step.id}
        pipelineId={step.config.pipelineId}
        stageId={step.config.stageId}
      />
      <PanelField
        label="Value ($)"
        htmlFor={`lead-value-${step.id}`}
        error={value.error}
        hint="Optional."
      >
        <Input
          id={`lead-value-${step.id}`}
          inputSize="sm"
          inputMode="decimal"
          value={value.value}
          readOnly={readOnly}
          onChange={(e) => value.change(e.target.value)}
        />
      </PanelField>
      <PanelField label="Assign to">
        <AssignToSelect
          label="Assign to"
          value={step.config.assignTo}
          withLead={false}
          onChange={(assignTo) => update({ config: { assignTo } }, 'Change who gets the lead')}
        />
      </PanelField>
    </>
  );
}

function MoveLead({ step }: { step: Of<'move_lead_stage'> }) {
  const update = useStepUpdate(step.id);
  const { readOnly } = useEditor();
  const reason = useDraftText(step.config.lostReason ?? '', (next) =>
    update({ config: { lostReason: next.trim() ? next : null } }, 'Change the lost reason', {
      group: 'lost',
      quiet: true,
    }),
  );
  return (
    <>
      <StageFields
        stepId={step.id}
        pipelineId={step.config.pipelineId}
        stageId={step.config.stageId}
      />
      <PanelField
        label="Lost reason"
        htmlFor={`lost-${step.id}`}
        hint="Used when the stage is a lost stage."
        error={reason.error}
      >
        <Input
          id={`lost-${step.id}`}
          inputSize="sm"
          value={reason.value}
          readOnly={readOnly}
          onChange={(e) => reason.change(e.target.value)}
        />
      </PanelField>
      <Note>
        Only a lead the workflow knows about moves: the one that started it, or one it made.
      </Note>
    </>
  );
}

function AssignLead({ step }: { step: Of<'assign_lead'> }) {
  const update = useStepUpdate(step.id);
  return (
    <PanelField label="Assign the lead to">
      <AssignToSelect
        label="Assign the lead to"
        value={step.config.assignTo}
        withLead={false}
        onChange={(assignTo) => update({ config: { assignTo } }, 'Change who gets the lead')}
      />
    </PanelField>
  );
}

function NextAction({ step }: { step: Of<'set_next_action'> }) {
  const update = useStepUpdate(step.id);
  const vars = useVars(step.id);
  const text = useDraftText(step.config.text, (next) =>
    update({ config: { text: next } }, 'Edit the next action', { group: 'text', quiet: true }),
  );
  return (
    <>
      <div className="mb-3.5">
        <VariableField
          id={`next-${step.id}`}
          label="Next action"
          value={text.value}
          onChange={text.change}
          error={text.error}
          variables={vars}
          maxLength={200}
        />
      </div>
      <PanelField label="Due">
        <OptionalDuration
          label="Due"
          noneLabel="No due time"
          value={step.config.due}
          onChange={(due) => update({ config: { due } }, 'Change when it’s due')}
        />
      </PanelField>
    </>
  );
}

function CreateTask({ step }: { step: Of<'create_task'> }) {
  const update = useStepUpdate(step.id);
  const vars = useVars(step.id);
  const title = useDraftText(step.config.title, (next) =>
    update({ config: { title: next } }, 'Name the task', { group: 'title', quiet: true }),
  );
  const notes = useDraftText(step.config.notes, (next) =>
    update({ config: { notes: next } }, 'Edit the task notes', { group: 'notes', quiet: true }),
  );
  return (
    <>
      <div className="mb-3.5">
        <VariableField
          id={`task-${step.id}`}
          label="Task"
          value={title.value}
          onChange={title.change}
          error={title.error}
          variables={vars}
          maxLength={200}
          testId="task-title"
        />
      </div>
      <PanelField label="For">
        <AssignToSelect
          label="For"
          value={step.config.assignTo}
          withLead={hasLead(vars)}
          onChange={(assignTo) => update({ config: { assignTo } }, 'Change who the task is for')}
        />
      </PanelField>
      <PanelField label="Due">
        <OptionalDuration
          label="Due"
          noneLabel="No due time"
          value={step.config.due}
          onChange={(due) => update({ config: { due } }, 'Change when it’s due')}
        />
      </PanelField>
      <div className="mb-3.5">
        <VariableField
          id={`task-notes-${step.id}`}
          label="Notes (optional)"
          multiline
          rows={3}
          value={notes.value}
          onChange={notes.change}
          error={notes.error}
          variables={vars}
          maxLength={2000}
        />
      </div>
    </>
  );
}

function CompleteTask({ step }: { step: Of<'complete_task'> }) {
  const update = useStepUpdate(step.id);
  const { def, names, readOnly } = useEditor();
  const tasks = stepsBefore(def, step.id).filter(
    (s) => s.type === 'action' && s.action === 'create_task',
  );
  return (
    <PanelField label="Complete" htmlFor={`complete-${step.id}`}>
      <Select
        id={`complete-${step.id}`}
        selectSize="sm"
        value={step.config.taskStepId ?? ''}
        disabled={readOnly}
        onChange={(e) =>
          update({ config: { taskStepId: e.target.value || null } }, 'Change which task')
        }
      >
        <option value="">Every open task this run made</option>
        {tasks.map((s) => (
          <option key={s.id} value={s.id}>
            {stepLines(s, names, def).detail ?? stepLines(s, names, def).title}
          </option>
        ))}
      </Select>
    </PanelField>
  );
}

function AddNote({ step }: { step: Of<'add_note'> }) {
  const update = useStepUpdate(step.id);
  const vars = useVars(step.id);
  const body = useDraftText(step.config.body, (next) =>
    update({ config: { body: next } }, 'Edit the note', { group: 'body', quiet: true }),
  );
  return (
    <div className="mb-3.5">
      <VariableField
        id={`note-${step.id}`}
        label="Note"
        multiline
        value={body.value}
        onChange={body.change}
        error={body.error}
        variables={vars}
        maxLength={5000}
        preview="plain"
        hint="Added to the customer’s timeline."
      />
    </div>
  );
}

function ConversationFields({
  step,
}: {
  step: Of<'assign_conversation'> | Of<'close_conversation'>;
}) {
  const update = useStepUpdate(step.id);
  const vars = useVars(step.id);
  const { readOnly } = useEditor();
  return (
    <>
      {step.action === 'assign_conversation' ? (
        <PanelField label="Assign to">
          <AssignToSelect
            label="Assign to"
            value={step.config.assignTo}
            withLead={hasLead(vars)}
            onChange={(assignTo) => update({ config: { assignTo } }, 'Change who gets it')}
          />
        </PanelField>
      ) : null}
      <PanelField label="Which conversation" htmlFor={`channel-${step.id}`}>
        <Select
          id={`channel-${step.id}`}
          selectSize="sm"
          value={step.config.channel}
          disabled={readOnly}
          onChange={(e) =>
            update({ config: { channel: e.target.value } }, 'Change the conversation')
          }
        >
          <option value="latest">Whichever they used last</option>
          <option value="sms">Their texts</option>
          <option value="email">Their email</option>
        </Select>
      </PanelField>
    </>
  );
}

function NotifyTeam({ step }: { step: Of<'notify_team'> }) {
  const update = useStepUpdate(step.id);
  const { catalogs, readOnly } = useEditor();
  const vars = useVars(step.id);
  const who = step.config.who;
  const message = useDraftText(step.config.message, (next) =>
    update({ config: { message: next } }, 'Edit the message', { group: 'message', quiet: true }),
  );
  const firstUser = catalogs.team.find((p) => p.active)?.userId;
  const setWho = (next: typeof who) => update({ config: { who: next } }, 'Change who’s told');
  return (
    <>
      <PanelField label="Who">
        <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="Who">
          <RadioRow
            on={who.kind === 'admins'}
            onSelect={() => setWho({ kind: 'admins' })}
            title="Owners and admins"
          />
          <RadioRow
            on={who.kind === 'users'}
            onSelect={() => {
              if (who.kind !== 'users' && firstUser)
                setWho({ kind: 'users', userIds: [firstUser] });
            }}
            title="Named people"
          >
            {who.kind === 'users' ? (
              <PeoplePicker
                label="People to tell"
                userIds={who.userIds}
                onChange={(ids) => {
                  if (ids.length) return setWho({ kind: 'users', userIds: ids });
                }}
              />
            ) : null}
          </RadioRow>
          {hasLead(vars) ? (
            <RadioRow
              on={who.kind === 'lead_assignee'}
              onSelect={() => setWho({ kind: 'lead_assignee' })}
              title="The lead’s assignee"
            />
          ) : null}
          <RadioRow
            on={who.kind === 'person_owner'}
            onSelect={() => setWho({ kind: 'person_owner' })}
            title="The customer’s owner"
          />
        </div>
      </PanelField>
      <div className="mb-3.5">
        <VariableField
          id={`notify-${step.id}`}
          label="Message"
          multiline
          rows={3}
          value={message.value}
          onChange={message.change}
          error={message.error}
          variables={vars}
          maxLength={500}
          preview="plain"
        />
      </div>
      <PanelField label="How">
        <Checkbox
          label="Email them too"
          checked={step.config.email}
          disabled={readOnly}
          onChange={(e) =>
            update({ config: { email: e.target.checked } }, 'Change how they’re told')
          }
        />
      </PanelField>
      <Note>
        They always see it in HandsFreeOS. Messages to the team ignore quiet hours; texts to
        customers never do.
      </Note>
    </>
  );
}

const PART_LABELS: Record<(typeof WEBHOOK_PARTS)[number], string> = {
  person: 'The customer',
  lead: 'The lead',
  appointment: 'The appointment',
  conversation: 'The conversation',
  trigger: 'What started it',
};

function WebhookOut({ step }: { step: Of<'webhook_out'> }) {
  const update = useStepUpdate(step.id);
  const { readOnly } = useEditor();
  const url = useDraftText(step.config.url, (next) =>
    update({ config: { url: next.trim() } }, 'Change the web address', {
      group: 'url',
      quiet: true,
    }),
  );
  const include = step.config.include;
  return (
    <>
      <PanelField
        label="Send to"
        htmlFor={`url-${step.id}`}
        error={url.error}
        hint="An https:// address."
      >
        <Input
          id={`url-${step.id}`}
          inputSize="sm"
          value={url.value}
          invalid={!!url.error}
          readOnly={readOnly}
          placeholder="https://"
          onChange={(e) => url.change(e.target.value)}
        />
      </PanelField>
      <PanelField label="Include">
        <div className="flex flex-col gap-1.5">
          {WEBHOOK_PARTS.map((p) => (
            <Checkbox
              key={p}
              label={PART_LABELS[p]}
              checked={include.includes(p)}
              disabled={readOnly}
              onChange={(e) =>
                update(
                  {
                    config: {
                      include: e.target.checked ? [...include, p] : include.filter((x) => x !== p),
                    },
                  },
                  'Change what’s sent',
                )
              }
            />
          ))}
        </div>
      </PanelField>
      <Note>
        Sent as JSON and signed, so the other app can check it came from here. It gives up after 10
        seconds.
      </Note>
    </>
  );
}

function WorkflowRef({ step }: { step: Of<'enrol_workflow'> | Of<'remove_from_workflow'> }) {
  const update = useStepUpdate(step.id);
  const { workflowId } = useEditor();
  return (
    <>
      <PanelField label={step.action === 'enrol_workflow' ? 'Start' : 'Remove them from'}>
        <RefSelect
          kind="workflow"
          label="Workflow"
          value={step.config.workflowId}
          exclude={[workflowId]}
          onChange={(v) => {
            if (v) return update({ config: { workflowId: v } }, 'Change the workflow');
          }}
        />
      </PanelField>
      <Note>
        {step.action === 'enrol_workflow'
          ? 'It starts only while that workflow is on, and follows its own rules for starting again.'
          : 'Any run of that workflow going for this customer stops.'}
      </Note>
    </>
  );
}
