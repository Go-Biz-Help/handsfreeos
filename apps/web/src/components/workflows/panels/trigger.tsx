'use client';
import {
  DATE_ANCHORS,
  emptyGroup,
  TRIGGER_EVENT_GROUPS,
  TRIGGER_EVENTS,
  type ConditionGroup,
  type DateAnchorKey,
  type Trigger,
  type TriggerEventKey,
  type TriggerInput,
  type TriggerKind,
} from '@hfos/core';
import { Globe } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { Input, Select } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import type { ApplyOutcome } from '@/lib/workflows/use-draft';
import { useEditor } from '../editor-context';
import { ConditionsEditor } from './conditions';
import { ChipChoice, DayPicker, DurationInput, Note, PanelField } from './fields';

const KINDS: readonly { value: TriggerKind; label: string }[] = [
  { value: 'event', label: 'Event' },
  { value: 'schedule', label: 'Schedule' },
  { value: 'date', label: 'Date' },
  { value: 'webhook', label: 'Webhook' },
  { value: 'manual', label: 'By hand' },
];

const DEFAULTS: Record<TriggerKind, TriggerInput> = {
  event: { kind: 'event', event: 'lead.created', filters: emptyGroup() },
  schedule: {
    kind: 'schedule',
    cadence: { every: 'weekly', days: [1], at: '09:00' },
    audience: emptyGroup(),
  },
  date: {
    kind: 'date',
    anchor: 'appointment.ends_at',
    offset: { amount: 2, unit: 'hours', direction: 'after' },
    at: null,
    filters: emptyGroup(),
  },
  webhook: { kind: 'webhook', personBy: 'phone_or_email', createPerson: true },
  manual: { kind: 'manual' },
};

/** "Europe/London" reads as "Europe/London"; the common US zones read as their names. */
function zoneName(tz: string): string {
  const US: Record<string, string> = {
    'America/Chicago': 'Central Time',
    'America/New_York': 'Eastern Time',
    'America/Denver': 'Mountain Time',
    'America/Phoenix': 'Arizona time',
    'America/Los_Angeles': 'Pacific Time',
  };
  return US[tz] ?? tz.replace(/_/g, ' ');
}

/** What starts the workflow: an event with filters, a schedule, a date, a webhook or by hand. */
export function TriggerPanel() {
  const { def, apply, timeZone, readOnly } = useEditor();
  const t = def.trigger;
  const set = (next: TriggerInput, label = 'Change the trigger'): ApplyOutcome =>
    apply([{ op: 'set_trigger', trigger: next }], label, { group: 'trigger', quiet: true });
  const setGroup = (key: 'filters' | 'audience', group: ConditionGroup) =>
    set({ ...t, [key]: group } as TriggerInput, 'Change the trigger’s rules');

  return (
    <div data-testid="panel-trigger">
      <PanelField label="Starts when">
        <ChipChoice
          label="Starts when"
          value={t.kind}
          options={KINDS}
          onChange={(k) => {
            if (k !== t.kind) set(DEFAULTS[k]);
          }}
        />
      </PanelField>

      {t.kind === 'event' ? <EventFields t={t} set={set} setGroup={setGroup} /> : null}

      {t.kind === 'schedule' ? (
        <>
          <PanelField label="How often" hint={`In ${zoneName(timeZone)}.`}>
            <div className="flex flex-col gap-2">
              <Segmented
                ariaLabel="How often"
                value={t.cadence.every}
                onChange={(every) => {
                  if (every === t.cadence.every || readOnly) return;
                  set({
                    ...t,
                    cadence:
                      every === 'weekly'
                        ? { every: 'weekly', days: [1], at: t.cadence.at }
                        : { every: 'monthly', day: 1, at: t.cadence.at },
                  });
                }}
                options={[
                  { value: 'weekly', label: 'Weekly' },
                  { value: 'monthly', label: 'Monthly' },
                ]}
              />
              {t.cadence.every === 'weekly' ? (
                <DayPicker
                  label="On"
                  days={t.cadence.days}
                  onChange={(days) => {
                    if (days.length && t.cadence.every === 'weekly')
                      set({ ...t, cadence: { ...t.cadence, days } });
                  }}
                />
              ) : (
                <Select
                  selectSize="sm"
                  aria-label="Day of the month"
                  value={String(t.cadence.day)}
                  disabled={readOnly}
                  onChange={(e) =>
                    t.cadence.every === 'monthly' &&
                    set({
                      ...t,
                      cadence: {
                        ...t.cadence,
                        day: e.target.value === 'last' ? 'last' : Number(e.target.value),
                      },
                    })
                  }
                >
                  {Array.from({ length: 28 }, (_, i) => (
                    <option key={i + 1} value={String(i + 1)}>
                      On the {i + 1}
                      {[1, 21].includes(i + 1)
                        ? 'st'
                        : [2, 22].includes(i + 1)
                          ? 'nd'
                          : [3, 23].includes(i + 1)
                            ? 'rd'
                            : 'th'}
                    </option>
                  ))}
                  <option value="last">On the last day</option>
                </Select>
              )}
              <label className="flex items-center gap-2 text-[13px]">
                At
                <Input
                  type="time"
                  inputSize="sm"
                  aria-label="Time"
                  className="w-[130px]"
                  value={t.cadence.at}
                  readOnly={readOnly}
                  onChange={(e) =>
                    e.target.value && set({ ...t, cadence: { ...t.cadence, at: e.target.value } })
                  }
                />
              </label>
            </div>
          </PanelField>
          <ConditionsEditor
            label="Who’s included"
            group={t.audience}
            onChange={(g) => setGroup('audience', g)}
            place={{ kind: 'trigger' }}
            emptyNote="Every customer, each time it runs."
            hint="Each customer goes in once per run of the schedule."
          />
        </>
      ) : null}

      {t.kind === 'date' ? (
        <>
          <PanelField
            label="When"
            hint={`In ${zoneName(timeZone)}. The date is checked again just before it runs.`}
          >
            <div className="flex flex-col gap-2">
              <span className="flex flex-wrap items-center gap-1.5">
                <DurationInput
                  label="How long"
                  min={0}
                  value={{ amount: t.offset.amount, unit: t.offset.unit }}
                  onChange={(d) =>
                    set({
                      ...t,
                      offset: { ...t.offset, ...d },
                      at: d.unit === 'days' || d.unit === 'weeks' ? t.at : null,
                    })
                  }
                />
                <Select
                  selectSize="sm"
                  aria-label="Before or after"
                  className="w-auto"
                  value={t.offset.direction}
                  disabled={readOnly}
                  onChange={(e) =>
                    set({
                      ...t,
                      offset: { ...t.offset, direction: e.target.value as 'before' | 'after' },
                    })
                  }
                >
                  <option value="after">after</option>
                  <option value="before">before</option>
                </Select>
              </span>
              <Select
                selectSize="sm"
                aria-label="Date"
                value={t.anchor}
                disabled={readOnly}
                onChange={(e) => set({ ...t, anchor: e.target.value as DateAnchorKey })}
              >
                {(Object.keys(DATE_ANCHORS) as DateAnchorKey[]).map((k) => (
                  <option key={k} value={k}>
                    {DATE_ANCHORS[k].label}
                  </option>
                ))}
              </Select>
              {t.offset.unit === 'days' || t.offset.unit === 'weeks' ? (
                <span className="flex flex-wrap items-center gap-2">
                  <Checkbox
                    label="At a set time of day"
                    checked={t.at !== null}
                    disabled={readOnly}
                    onChange={(e) => set({ ...t, at: e.target.checked ? '09:00' : null })}
                  />
                  {t.at !== null ? (
                    <Input
                      type="time"
                      inputSize="sm"
                      aria-label="Time of day"
                      className="w-[130px]"
                      value={t.at}
                      readOnly={readOnly}
                      onChange={(e) => e.target.value && set({ ...t, at: e.target.value })}
                    />
                  ) : null}
                </span>
              ) : null}
            </div>
          </PanelField>
          <ConditionsEditor
            label="Only when all of these are true"
            group={t.filters}
            onChange={(g) => setGroup('filters', g)}
            place={{ kind: 'trigger' }}
            emptyNote="Every time. Add a filter to narrow it down."
            addLabel="Add a filter"
          />
        </>
      ) : null}

      {t.kind === 'webhook' ? (
        <>
          <PanelField label="Find the customer by">
            <Select
              selectSize="sm"
              aria-label="Find the customer by"
              value={t.personBy}
              disabled={readOnly}
              onChange={(e) =>
                set({ ...t, personBy: e.target.value as 'phone' | 'email' | 'phone_or_email' })
              }
            >
              <option value="phone_or_email">Their phone, or else their email</option>
              <option value="phone">Their phone</option>
              <option value="email">Their email</option>
            </Select>
          </PanelField>
          <PanelField label="Someone new">
            <Checkbox
              label="Add them as a new customer"
              checked={t.createPerson}
              disabled={readOnly}
              onChange={(e) => set({ ...t, createPerson: e.target.checked })}
            />
          </PanelField>
          <Note icon={Globe}>
            The address appears after you publish. Each request is checked with its own secret, so
            only the apps you give it to can start this workflow.
          </Note>
        </>
      ) : null}

      {t.kind === 'manual' ? (
        <Note>
          Start it from a customer’s or a lead’s page with Add to workflow…, or ask the Assistant.
          It starts for one customer at a time, and never on its own.
        </Note>
      ) : null}
    </div>
  );
}

function EventFields({
  t,
  set,
  setGroup,
}: {
  t: Extract<Trigger, { kind: 'event' }>;
  set: (next: TriggerInput, label?: string) => ApplyOutcome;
  setGroup: (key: 'filters', group: ConditionGroup) => ApplyOutcome;
}) {
  const { readOnly } = useEditor();
  return (
    <>
      <PanelField label="Event" htmlFor="trigger-event">
        <Select
          id="trigger-event"
          selectSize="sm"
          value={t.event}
          disabled={readOnly}
          data-testid="trigger-event"
          onChange={(e) =>
            set({ ...t, event: e.target.value as TriggerEventKey }, 'Change what starts it')
          }
        >
          {TRIGGER_EVENT_GROUPS.map((g) => (
            <optgroup key={g.label} label={g.label}>
              {g.events.map((k) => (
                <option key={k} value={k}>
                  {TRIGGER_EVENTS[k].label}
                </option>
              ))}
            </optgroup>
          ))}
        </Select>
      </PanelField>
      <ConditionsEditor
        label={`Only when ${t.filters.match === 'any' ? 'any' : 'all'} of these are true`}
        group={t.filters}
        onChange={(g) => setGroup('filters', g)}
        place={{ kind: 'trigger' }}
        emptyNote="Every time. Add a filter to narrow it down."
        addLabel="Add a filter"
        testId="trigger-filters"
      />
    </>
  );
}
