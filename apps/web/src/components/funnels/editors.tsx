'use client';
/**
 * The parts of a funnel the steps edit (HANDSFREEOS_TEAMMATE_FUNNELS_IMPLEMENTATION_PLAN.md, steps 3 to 5): who gets
 * in, what moves someone on, and each message (when, only if, what to say, how, good until). Each edits a copy of its
 * part and hands it back whole; the builder keeps the funnel.
 */
import {
  FUNNEL_EVENTS,
  FUNNEL_EVENT_KEYS,
  FUNNEL_LIMITS,
  INTAKE_KINDS,
  INTAKE_NAMES,
  funnelGoodFor,
  funnelWhenWords,
  newFunnelPartId,
  type FunnelEntry,
  type FunnelEntryRule,
  type FunnelEvent,
  type FunnelMessage,
  type FunnelMove,
  type FunnelWhen,
  type IntakeKind,
} from '@hfos/core';
import { Plus, Trash2 } from 'lucide-react';
import { useId } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Hint, Label } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';

export interface Picks {
  readonly forms: readonly { readonly id: string; readonly name: string }[];
  readonly calendars: readonly { readonly id: string; readonly name: string }[];
}

export interface StageOption {
  readonly id: string;
  readonly name: string;
  readonly kind: 'open' | 'won' | 'lost';
}

// ---- Lengths of time ----

type Unit = 'minutes' | 'hours' | 'days';
const UNIT_MIN: Readonly<Record<Unit, number>> = { minutes: 1, hours: 60, days: 1440 };
const unitOf = (minutes: number): Unit =>
  minutes !== 0 && minutes % 1440 === 0
    ? 'days'
    : minutes !== 0 && minutes % 60 === 0
      ? 'hours'
      : 'minutes';

/** A length of time as a number and a unit, kept in minutes. */
export function Duration({
  minutes,
  onChange,
  label,
  units = ['minutes', 'hours', 'days'],
  min = 0,
}: {
  minutes: number;
  onChange: (minutes: number) => void;
  label: string;
  units?: readonly Unit[];
  min?: number;
}) {
  const unit = units.includes(unitOf(minutes)) ? unitOf(minutes) : units[units.length - 1]!;
  const n = Math.round(Math.abs(minutes) / UNIT_MIN[unit]);
  return (
    <span className="inline-flex items-center gap-1.5" role="group" aria-label={label}>
      <Input
        type="number"
        inputSize="sm"
        min={0}
        value={Number.isFinite(n) ? n : 0}
        aria-label={`${label}: how many`}
        onChange={(e) =>
          onChange(Math.max(min, Math.round(Number(e.target.value || 0) * UNIT_MIN[unit])))
        }
        className="w-[72px]"
      />
      <Select
        selectSize="sm"
        value={unit}
        aria-label={`${label}: in`}
        onChange={(e) => onChange(Math.max(min, n * UNIT_MIN[e.target.value as Unit]))}
        className="w-[104px]"
      >
        {units.map((u) => (
          <option key={u} value={u}>
            {u}
          </option>
        ))}
      </Select>
    </span>
  );
}

// ---- Who gets in ----

export function EntryEditor({
  entry,
  onChange,
  stages,
  picks,
  pipelineName,
  teammateName,
}: {
  entry: FunnelEntry;
  onChange: (next: FunnelEntry) => void;
  stages: readonly StageOption[];
  picks: Picks;
  pipelineName: string;
  teammateName: string;
}) {
  const id = useId();
  const setRule = (i: number, r: FunnelEntryRule) =>
    onChange({ ...entry, rules: entry.rules.map((x, j) => (j === i ? r : x)) });
  const open = stages.filter((s) => s.kind === 'open');
  return (
    <div className="flex flex-col gap-4" data-testid="funnel-entry">
      <div>
        <Label>Rules that bring people in</Label>
        {entry.rules.length === 0 ? (
          <p className="text-[13px] text-text-2">
            No rules yet: only people added by hand or suggested get in.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {entry.rules.map((r, i) => (
              <li
                key={r.id}
                className="flex flex-wrap items-center gap-2 rounded-menu border border-border p-2.5"
              >
                <Select
                  selectSize="sm"
                  value={r.kind}
                  aria-label="Who this rule brings in"
                  onChange={(e) =>
                    setRule(i, ruleOfKind(e.target.value as FunnelEntryRule['kind'], r.id, picks))
                  }
                  className="w-[220px]"
                >
                  <option value="new_lead">Any new lead in {pipelineName}</option>
                  <option value="came_in">A new lead that came in by…</option>
                  <option value="form" disabled={!picks.forms.length}>
                    Someone who sends a form
                  </option>
                  <option value="booking" disabled={!picks.calendars.length}>
                    Someone who books on a calendar
                  </option>
                </Select>
                {r.kind === 'form' ? (
                  <Select
                    selectSize="sm"
                    value={r.formId}
                    aria-label="Which form"
                    onChange={(e) => setRule(i, { ...r, formId: e.target.value })}
                    className="min-w-[180px] flex-1"
                  >
                    {picks.forms.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </Select>
                ) : r.kind === 'booking' ? (
                  <Select
                    selectSize="sm"
                    value={r.calendarId}
                    aria-label="Which calendar"
                    onChange={(e) => setRule(i, { ...r, calendarId: e.target.value })}
                    className="min-w-[180px] flex-1"
                  >
                    {picks.calendars.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <span className="flex-1" />
                )}
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Remove this rule"
                  onClick={() =>
                    onChange({ ...entry, rules: entry.rules.filter((_, j) => j !== i) })
                  }
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
                {r.kind === 'came_in' ? (
                  <div className="flex w-full flex-wrap gap-x-4 gap-y-1.5 pl-1">
                    {INTAKE_KINDS.map((k: IntakeKind) => (
                      <Checkbox
                        key={k}
                        label={INTAKE_NAMES[k]}
                        className="text-[13px]"
                        checked={r.ways.includes(k)}
                        onChange={(e) => {
                          const ways = e.target.checked
                            ? [...r.ways, k]
                            : r.ways.filter((w) => w !== k);
                          if (ways.length) setRule(i, { ...r, ways });
                        }}
                      />
                    ))}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <Button
          size="sm"
          variant="secondary"
          className="mt-2"
          disabled={entry.rules.length >= FUNNEL_LIMITS.entryRules}
          onClick={() =>
            onChange({
              ...entry,
              rules: [...entry.rules, { id: newFunnelPartId('r'), kind: 'new_lead' }],
            })
          }
          data-testid="funnel-rule-add"
        >
          <Plus className="h-4 w-4" aria-hidden />
          Add a rule
        </Button>
      </div>
      <div className="flex items-start gap-3">
        <Switch
          checked={entry.byHand}
          onChange={(byHand) => onChange({ ...entry, byHand })}
          label="Add people by hand"
        />
        <div>
          <div className="text-[13.5px] font-medium">Add people by hand</div>
          <Hint>“Add to funnel” on a customer or a lead.</Hint>
        </div>
      </div>
      <div className="flex items-start gap-3">
        <Switch
          checked={entry.aiSuggests}
          onChange={(aiSuggests) => onChange({ ...entry, aiSuggests })}
          label={`${teammateName} suggests people`}
        />
        <div>
          <div className="text-[13.5px] font-medium">{teammateName} suggests people who fit</div>
          <Hint>Someone on the team says yes or no on Approvals before anyone is added.</Hint>
        </div>
      </div>
      <div>
        <Label htmlFor={`${id}-start`}>Where people start</Label>
        <Select
          id={`${id}-start`}
          value={entry.startStageId ?? ''}
          onChange={(e) => onChange({ ...entry, startStageId: e.target.value || null })}
          className="max-w-[320px]"
        >
          <option value="">The first stage ({open[0]?.name ?? 'none yet'})</option>
          {open.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
        <Hint>Someone whose lead is already at a stage of the funnel starts there instead.</Hint>
      </div>
    </div>
  );
}

function ruleOfKind(kind: FunnelEntryRule['kind'], id: string, picks: Picks): FunnelEntryRule {
  switch (kind) {
    case 'new_lead':
      return { id, kind };
    case 'came_in':
      return { id, kind, ways: ['facebook_lead_ad'] };
    case 'form':
      return { id, kind, formId: picks.forms[0]?.id ?? '' };
    case 'booking':
      return { id, kind, calendarId: picks.calendars[0]?.id ?? '' };
  }
}

// ---- What moves someone on ----

export function MovesEditor({
  stageId,
  moves,
  onChange,
  stages,
  picks,
}: {
  stageId: string;
  moves: readonly FunnelMove[];
  onChange: (next: FunnelMove[]) => void;
  /** The funnel's stages, for where a move goes. */
  stages: readonly StageOption[];
  picks: Picks;
}) {
  const others = stages.filter((s) => s.id !== stageId);
  const set = (i: number, m: FunnelMove) => onChange(moves.map((x, j) => (j === i ? m : x)));
  return (
    <div className="flex flex-col gap-2" data-testid="funnel-moves">
      {moves.length === 0 ? (
        <p className="text-[13px] text-text-2">
          Nothing moves people on from here yet: they stay at this stage.
        </p>
      ) : null}
      {moves.map((m, i) => (
        <div
          key={m.id}
          className="flex flex-wrap items-center gap-2 rounded-menu border border-border p-2.5"
        >
          <span className="text-[13px] text-text-2">When</span>
          <Select
            selectSize="sm"
            value={m.kind === 'event' ? m.event : m.kind}
            aria-label="What moves them on"
            onChange={(e) => {
              const v = e.target.value;
              if (v === 'reply')
                set(i, { id: m.id, kind: 'reply', says: 'they say they’re interested', to: m.to });
              else if (v === 'quiet')
                set(i, { id: m.id, kind: 'quiet', minutes: 3 * 1440, to: m.to });
              else
                set(i, {
                  id: m.id,
                  kind: 'event',
                  event: v as FunnelEvent,
                  formId: null,
                  calendarId: null,
                  to: m.to,
                });
            }}
            className="w-[230px]"
          >
            <optgroup label="What they do">
              {FUNNEL_EVENT_KEYS.map((k) => (
                <option key={k} value={k}>
                  {FUNNEL_EVENTS[k].label}
                </option>
              ))}
            </optgroup>
            <option value="reply">they write something like…</option>
            <option value="quiet">they’re quiet for…</option>
          </Select>
          {m.kind === 'event' && FUNNEL_EVENTS[m.event].filter === 'form' && picks.forms.length ? (
            <Select
              selectSize="sm"
              value={m.formId ?? ''}
              aria-label="Which form"
              onChange={(e) => set(i, { ...m, formId: e.target.value || null })}
              className="w-[180px]"
            >
              <option value="">Any form</option>
              {picks.forms.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </Select>
          ) : null}
          {m.kind === 'event' &&
          FUNNEL_EVENTS[m.event].filter === 'calendar' &&
          picks.calendars.length ? (
            <Select
              selectSize="sm"
              value={m.calendarId ?? ''}
              aria-label="Which calendar"
              onChange={(e) => set(i, { ...m, calendarId: e.target.value || null })}
              className="w-[180px]"
            >
              <option value="">Any calendar</option>
              {picks.calendars.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          ) : null}
          {m.kind === 'reply' ? (
            <Input
              inputSize="sm"
              value={m.says}
              maxLength={200}
              aria-label="What they write, as the teammate judges it"
              onChange={(e) => set(i, { ...m, says: e.target.value })}
              className="min-w-[200px] flex-1"
            />
          ) : null}
          {m.kind === 'quiet' ? (
            <Duration
              minutes={m.minutes}
              min={60}
              units={['hours', 'days']}
              label="How long quiet"
              onChange={(minutes) => set(i, { ...m, minutes })}
            />
          ) : null}
          <span className="text-[13px] text-text-2">→</span>
          <Select
            selectSize="sm"
            value={m.to}
            aria-label="Where it moves them"
            onChange={(e) => set(i, { ...m, to: e.target.value })}
            className="w-[180px]"
          >
            {others.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.kind !== 'open' ? ` (${s.kind})` : ''}
              </option>
            ))}
          </Select>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Remove this move"
            onClick={() => onChange(moves.filter((_, j) => j !== i))}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
      <div>
        <Button
          size="sm"
          variant="secondary"
          disabled={moves.length >= FUNNEL_LIMITS.moves || !others.length}
          onClick={() =>
            onChange([
              ...moves,
              {
                id: newFunnelPartId('v'),
                kind: 'event',
                event: 'appointment.booked',
                formId: null,
                calendarId: null,
                to: others.find((s) => s.kind === 'open')?.id ?? others[0]!.id,
              },
            ])
          }
          data-testid="funnel-move-add"
        >
          <Plus className="h-4 w-4" aria-hidden />
          Add a move
        </Button>
      </div>
    </div>
  );
}

// ---- Messages ----

const FILLS = [
  { key: '{first_name}', label: 'First name' },
  { key: '{session_time}', label: 'Session time' },
  { key: '{join_link}', label: 'Join link' },
  { key: '{business}', label: 'Business name' },
] as const;

export function newMessage(wording: 'ai' | 'exact'): FunnelMessage {
  return {
    id: newFunnelPartId('m'),
    when: { kind: 'arrive', minutes: 0 },
    onlyIf: null,
    wording,
    text: '',
    how: 'best',
    goodForMinutes: null,
  };
}

export function MessageEditor({
  message,
  onChange,
  onRemove,
  teammateName,
}: {
  message: FunnelMessage;
  onChange: (next: FunnelMessage) => void;
  onRemove: () => void;
  teammateName: string;
}) {
  const id = useId();
  const m = message;
  const setWhen = (when: FunnelWhen) => onChange({ ...m, when });
  const exact = m.wording === 'exact';
  return (
    <div
      className="flex flex-col gap-3 rounded-menu border border-border p-3.5"
      data-testid={`funnel-message-${m.id}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13.5px] font-semibold">{funnelWhenWords(m.when)}</span>
        <span className="flex-1" />
        <Button size="icon" variant="ghost" aria-label="Remove this message" onClick={onRemove}>
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          selectSize="sm"
          value={m.when.kind}
          aria-label="When it goes"
          onChange={(e) => {
            const k = e.target.value as FunnelWhen['kind'];
            setWhen(
              k === 'arrive'
                ? { kind: 'arrive', minutes: 0 }
                : k === 'booking'
                  ? { kind: 'booking', minutes: -60 }
                  : { kind: 'booking_day', daysBefore: 1, at: '16:00' },
            );
          }}
          className="w-[250px]"
        >
          <option value="arrive">After they reach this stage</option>
          <option value="booking">Around their booking’s start</option>
          <option value="booking_day">On their booking’s day</option>
        </Select>
        {m.when.kind === 'arrive' ? (
          <Duration
            minutes={m.when.minutes}
            label="How long after they arrive"
            onChange={(minutes) => setWhen({ kind: 'arrive', minutes })}
          />
        ) : m.when.kind === 'booking' ? (
          <>
            <Duration
              minutes={m.when.minutes}
              units={['minutes', 'hours', 'days']}
              label="How long from the start"
              onChange={(minutes) =>
                setWhen({
                  kind: 'booking',
                  minutes: m.when.kind === 'booking' && m.when.minutes < 0 ? -minutes : minutes,
                })
              }
            />
            <Select
              selectSize="sm"
              value={m.when.minutes < 0 ? 'before' : 'after'}
              aria-label="Before or after it starts"
              onChange={(e) =>
                setWhen({
                  kind: 'booking',
                  minutes:
                    Math.abs(m.when.kind === 'booking' ? m.when.minutes : 0) *
                    (e.target.value === 'before' ? -1 : 1),
                })
              }
              className="w-[140px]"
            >
              <option value="before">before it starts</option>
              <option value="after">after it starts</option>
            </Select>
          </>
        ) : (
          <>
            <Select
              selectSize="sm"
              value={String(m.when.daysBefore)}
              aria-label="Which day"
              onChange={(e) =>
                m.when.kind === 'booking_day' &&
                setWhen({ ...m.when, daysBefore: Number(e.target.value) })
              }
              className="w-[150px]"
            >
              <option value="0">On the day</option>
              <option value="1">The day before</option>
              {[2, 3, 4, 5, 6, 7].map((d) => (
                <option key={d} value={d}>
                  {d} days before
                </option>
              ))}
            </Select>
            <span className="text-[13px] text-text-2">at</span>
            <Input
              type="time"
              inputSize="sm"
              value={m.when.at}
              aria-label="At what time"
              onChange={(e) =>
                m.when.kind === 'booking_day' &&
                e.target.value &&
                setWhen({ ...m.when, at: e.target.value.slice(0, 5) })
              }
              className="w-[120px]"
            />
          </>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          selectSize="sm"
          value={m.onlyIf ? (m.onlyIf.has ? 'has' : 'hasnt') : 'always'}
          aria-label="Only if"
          onChange={(e) =>
            onChange({
              ...m,
              onlyIf:
                e.target.value === 'always'
                  ? null
                  : { has: e.target.value === 'has', event: m.onlyIf?.event ?? 'attendee.joined' },
            })
          }
          className="w-[230px]"
        >
          <option value="always">Whatever they’ve done</option>
          <option value="has">Only if they’ve…</option>
          <option value="hasnt">Only if they haven’t…</option>
        </Select>
        {m.onlyIf ? (
          <Select
            selectSize="sm"
            value={m.onlyIf.event}
            aria-label="Done what"
            onChange={(e) =>
              onChange({ ...m, onlyIf: { ...m.onlyIf!, event: e.target.value as FunnelEvent } })
            }
            className="w-[200px]"
          >
            {FUNNEL_EVENT_KEYS.map((k) => (
              <option key={k} value={k}>
                {FUNNEL_EVENTS[k].past}
              </option>
            ))}
          </Select>
        ) : null}
        <Select
          selectSize="sm"
          value={m.how}
          aria-label="How it goes"
          onChange={(e) => onChange({ ...m, how: e.target.value as FunnelMessage['how'] })}
          className="w-[190px]"
        >
          <option value="best">The best way to reach them</option>
          <option value="text">By text</option>
          <option value="email">By email</option>
        </Select>
      </div>
      <div>
        <div className="mb-1.5 flex flex-wrap items-center gap-2">
          <Label htmlFor={`${id}-text`} className="mb-0">
            {exact ? 'The exact words' : `What ${teammateName} should say`}
          </Label>
          <span className="flex-1" />
          <Segmented
            value={m.wording}
            onChange={(wording) => onChange({ ...m, wording })}
            ariaLabel="Who writes it"
            options={[
              { value: 'ai', label: `${teammateName} writes it` },
              { value: 'exact', label: 'Exact words' },
            ]}
          />
        </div>
        <Textarea
          id={`${id}-text`}
          value={m.text}
          maxLength={1000}
          onChange={(e) => onChange({ ...m, text: e.target.value })}
          className="min-h-[64px]"
          placeholder={
            exact
              ? 'Starts in an hour, {first_name}. Your link: {join_link}'
              : 'Remind them it starts in an hour, with their Join link.'
          }
        />
        {exact ? (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {FILLS.map((f) => (
              <button
                key={f.key}
                type="button"
                className="inline-flex h-6 items-center rounded-full border border-border bg-card-2 px-2 text-[12px] hover:bg-card"
                onClick={() =>
                  onChange({
                    ...m,
                    text: `${m.text}${m.text && !m.text.endsWith(' ') ? ' ' : ''}${f.key}`,
                  })
                }
              >
                + {f.label}
              </button>
            ))}
          </div>
        ) : (
          <Hint>
            {teammateName} writes it in its own voice, knowing the stage’s goal and talking points.
          </Hint>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[13px] text-text-2">
        <Checkbox
          label="Good until"
          className="text-[13px] text-text-2"
          checked={m.goodForMinutes !== null}
          onChange={(e) =>
            onChange({
              ...m,
              goodForMinutes: e.target.checked
                ? funnelGoodFor({ ...m, goodForMinutes: null })
                : null,
            })
          }
        />
        {m.goodForMinutes !== null ? (
          <>
            <Duration
              minutes={m.goodForMinutes}
              min={5}
              label="How late it may still go"
              onChange={(goodForMinutes) =>
                onChange({ ...m, goodForMinutes: Math.max(5, goodForMinutes) })
              }
            />
            <span>after it was due</span>
          </>
        ) : (
          <span>
            the usual:{' '}
            {Math.round(funnelGoodFor(m) / 60) >= 24 ? 'a day' : `${funnelGoodFor(m)} minutes`}{' '}
            after it was due
          </span>
        )}
      </div>
    </div>
  );
}
