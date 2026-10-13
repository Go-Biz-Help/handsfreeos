'use client';
import {
  formatNotice,
  LOCATION_NAMES,
  money,
  parseClock,
  minutesToClock,
  type AssignmentMode,
  type CalendarCatalogs,
  type CalendarConfig,
  type ConfigPatch,
  type DepositTerms,
  type LocationKind,
  type Reminder,
  type WeeklyHours,
} from '@hfos/core';
import { ArrowDown, ArrowUp, Info, Plus, Trash2, UserPlus, X } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { SetRow } from '@/components/settings/set-row';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input, Select } from '@/components/ui/input';
import { RadioCard } from '@/components/ui/radio-card';
import { Segmented } from '@/components/ui/segmented';
import { Stepper } from '@/components/ui/stepper';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { CalendarAutomations } from '@/components/workflows/calendar-automations';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { Ok, Pipeline, ResourceItem, ServiceItem, TerritoryItem } from '@/lib/api/types';
import { teamSentence, type ModuleKey } from '@/lib/calendar/describe';
import { dateOf, fmtAt, fmtLength, fmtWhen, TIME_OPTIONS } from '@/lib/calendar/time';
import { useLiveVersion } from '@/lib/realtime/live-provider';
import { WeeklyHoursEditor } from './weekly-hours';

export interface BuilderPerson {
  readonly userId: string;
  readonly fullName: string;
  /** "Owner", "Admin", "Member". */
  readonly role: string;
  readonly weekly: WeeklyHours | null;
}

/** One connected payment account, as the Payments module names it. */
export interface BuilderPayAccount {
  readonly id: string;
  /** The business's own name for it, else the provider's. */
  readonly name: string;
  readonly provider: string;
  readonly isDefault: boolean;
}

/** What Settings → Payments says, for the Payments module to show rather than ask again. */
export interface BuilderPayments {
  readonly accounts: readonly BuilderPayAccount[];
  readonly deposit: DepositTerms;
}

export interface ModuleProps {
  readonly workspaceId: string;
  readonly draft: CalendarConfig;
  /** Merges a settings patch into the draft (validated; a refused value explains itself). */
  readonly patch: (p: ConfigPatch) => void;
  readonly catalogs: CalendarCatalogs;
  readonly people: readonly BuilderPerson[];
  readonly services: readonly ServiceItem[];
  readonly resources: readonly ResourceItem[];
  readonly territories: readonly TerritoryItem[];
  readonly pipelines: readonly Pipeline[];
  /** The calendar itself, for Automations (its workflows and "Add automation"). */
  readonly calendarId?: string;
  readonly calendarName?: string;
  /** Settings → Payments, for the Payments module. */
  readonly payments?: BuilderPayments;
}

const WEEKDAYS_9_TO_5: WeeklyHours = [1, 2, 3, 4, 5].map((day) => ({
  day,
  start: '09:00',
  end: '17:00',
}));
const minutesLabel = (m: number) => (m === 0 ? 'None' : fmtLength(m));
const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;
const capital = (s: string) => s[0]!.toUpperCase() + s.slice(1);

function Heading({ title, description }: { title: string; description: string }) {
  return (
    <div className="mb-3">
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      <p className="mt-1 text-[13px] text-text-2">{description}</p>
    </div>
  );
}

function Callout({ children }: { children: ReactNode }) {
  return (
    <div className="mt-2 flex items-start gap-2.5 rounded-menu bg-accent-soft px-3.5 py-3 text-[13.5px] text-accent-text">
      <Info className="mt-0.5 h-4 w-4 flex-none" strokeWidth={1.75} />
      <span>{children}</span>
    </div>
  );
}

/** A number box that lets you type freely and only takes whole numbers in range. */
function NumberField({
  value,
  onChange,
  min,
  max,
  label,
  suffix,
  nullable,
  placeholder,
  testId,
}: {
  value: number | null;
  onChange: (next: number | null) => void;
  min: number;
  max: number;
  label: string;
  suffix?: string;
  nullable?: boolean;
  placeholder?: string;
  testId?: string;
}) {
  const [text, setText] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-2">
      <Input
        type="number"
        inputSize="sm"
        className="w-24"
        aria-label={label}
        data-testid={testId}
        min={min}
        max={max}
        placeholder={placeholder}
        value={text ?? (value === null ? '' : String(value))}
        onChange={(e) => {
          setText(e.target.value);
          const raw = e.target.value.trim();
          if (!raw) {
            if (nullable) onChange(null);
            return;
          }
          const n = Math.round(Number(raw));
          if (Number.isFinite(n) && n >= min && n <= max) onChange(n);
        }}
        onBlur={() => setText(null)}
      />
      {suffix ? <span className="text-[13px] text-text-2">{suffix}</span> : null}
    </span>
  );
}

/** A text box that saves into the draft when you leave it (addresses, links, questions). */
function CommitInput({
  value,
  onCommit,
  label,
  placeholder,
  className,
}: {
  value: string;
  onCommit: (next: string) => void;
  label: string;
  placeholder?: string;
  className?: string;
}) {
  const [text, setText] = useState<string | null>(null);
  return (
    <Input
      inputSize="sm"
      aria-label={label}
      placeholder={placeholder}
      className={className}
      value={text ?? value}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (text !== null && text !== value) onCommit(text);
        setText(null);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

// ---------- Team & assignment ----------

const ASSIGNMENT: readonly { value: AssignmentMode; title: string; description: string }[] = [
  { value: 'fixed', title: 'Fixed person', description: 'Every booking goes to one person.' },
  {
    value: 'customer_choice',
    title: 'Customer’s choice',
    description: 'Customers pick who comes.',
  },
  {
    value: 'round_robin',
    title: 'Round robin',
    description: 'Take turns. Whoever went longest ago goes next.',
  },
  {
    value: 'weighted',
    title: 'Weighted round robin',
    description: 'Take turns, but some people get more.',
  },
  {
    value: 'first_available',
    title: 'First available',
    description: 'The first free person, in the order you set.',
  },
  {
    value: 'collective',
    title: 'Collective',
    description: 'Everyone goes together. All must be free.',
  },
  {
    value: 'none',
    title: 'No staff needed',
    description: 'Bookings depend only on your open hours and free equipment, like beds or rooms.',
  },
];

function TeamModule({ draft, patch, catalogs, people, territories }: ModuleProps) {
  const members = draft.team.members;
  const mode = draft.team.assignment;
  /** No staff needed: nobody to add or order, only a note and how it works. */
  const staffless = mode === 'none';
  const byId = new globalThis.Map(people.map((p) => [p.userId, p]));
  const setMembers = (next: typeof members) => patch({ team: { members: [...next] } });
  const available = people.filter((p) => !members.some((m) => m.userId === p.userId));
  const move = (i: number, d: number) => {
    const next = [...members];
    const [x] = next.splice(i, 1);
    next.splice(i + d, 0, x!);
    setMembers(next);
  };
  return (
    <>
      <Heading
        title="Team & assignment"
        description="Who takes bookings on this calendar, and how each booking picks a person."
      />
      {staffless ? (
        <p
          className="border-t border-border py-3 text-[13px] leading-[1.5] text-text-2"
          data-testid="team-none-note"
        >
          Nobody is assigned to these bookings, so there’s nobody to add. Your open hours
          (Availability) and free equipment (Resources) decide what customers can book.
        </p>
      ) : (
        <div data-testid="team-members">
          {members.map((m, i) => {
            const p = byId.get(m.userId);
            const name = p?.fullName ?? 'A former teammate';
            const areas = territories
              .filter((t) => t.userIds.includes(m.userId))
              .map((t) => t.name)
              .join(', ');
            return (
              <div
                key={m.userId}
                className="flex items-center gap-3 border-t border-border py-2.5"
                data-testid={`team-member-${m.userId}`}
              >
                <Avatar name={name} seed={m.userId} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[13px] font-medium">{name}</span>
                  <span className="truncate text-xs text-text-3">
                    {p ? p.role : 'No longer on the team'}
                    {draft.territory.routing === 'zip' ? ` · ${areas || 'No territory yet'}` : ''}
                  </span>
                </span>
                {mode === 'collective' ? (
                  <Checkbox
                    label="Must go"
                    checked={m.required}
                    onChange={(e) =>
                      setMembers(
                        members.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)),
                      )
                    }
                  />
                ) : null}
                {mode === 'first_available' ? (
                  <span className="flex flex-none items-center">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Move ${firstName(name)} up`}
                      disabled={i === 0}
                      onClick={() => move(i, -1)}
                    >
                      <ArrowUp className="h-4 w-4" strokeWidth={1.5} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Move ${firstName(name)} down`}
                      disabled={i === members.length - 1}
                      onClick={() => move(i, 1)}
                    >
                      <ArrowDown className="h-4 w-4" strokeWidth={1.5} />
                    </Button>
                  </span>
                ) : null}
                {/* Weights only count for weighted turns; shown otherwise only when set, so it can be cleared. */}
                {mode === 'weighted' || m.weight !== 1 ? (
                  <span
                    className={`flex flex-none items-center ${mode === 'weighted' ? '' : 'opacity-60'}`}
                  >
                    <span className="mr-2 hidden text-xs text-text-3 @md:inline">Weight</span>
                    <Stepper
                      value={m.weight}
                      min={1}
                      max={100}
                      label={`Weight for ${firstName(name)}`}
                      onChange={(weight) =>
                        setMembers(members.map((x, j) => (j === i ? { ...x, weight } : x)))
                      }
                    />
                  </span>
                ) : null}
                <Button
                  variant="ghost"
                  size="icon"
                  className="flex-none"
                  title={`Take ${firstName(name)} off this calendar`}
                  aria-label={`Take ${firstName(name)} off this calendar`}
                  onClick={() => setMembers(members.filter((x) => x.userId !== m.userId))}
                >
                  <X className="h-4 w-4" strokeWidth={1.5} />
                </Button>
              </div>
            );
          })}
          <div className="flex items-center justify-between border-t border-border pt-3">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!available.length}
                  title={available.length ? undefined : 'Everyone is on this calendar'}
                  data-testid="team-add"
                >
                  <UserPlus className="h-4 w-4" strokeWidth={1.5} />
                  Add a teammate
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {available.map((p) => (
                  <DropdownMenuItem
                    key={p.userId}
                    onSelect={() =>
                      setMembers([
                        ...members,
                        { userId: p.userId, weight: 1, priority: 0, required: false },
                      ])
                    }
                  >
                    <Avatar name={p.fullName} seed={p.userId} size="sm" />
                    {p.fullName}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <span className="text-xs text-text-3">
              {members.length === 1 ? '1 person' : `${members.length} people`}
            </span>
          </div>
        </div>
      )}

      <div className="mb-2 mt-[22px] text-[13px] font-medium">How a booking picks a person</div>
      <div
        role="radiogroup"
        aria-label="How a booking picks a person"
        className="grid gap-2.5 @md:grid-cols-2"
      >
        {ASSIGNMENT.map((a) => (
          <RadioCard
            key={a.value}
            selected={mode === a.value}
            onSelect={() => patch({ team: { assignment: a.value } })}
            title={<span className="text-[13px]">{a.title}</span>}
            description={<span className="text-xs">{a.description}</span>}
            className="px-3 py-2.5"
            testId={`assignment-${a.value}`}
          />
        ))}
      </div>
      {staffless ? (
        <div className="mt-3.5">
          <Callout>{teamSentence(draft, catalogs)}</Callout>
        </div>
      ) : (
        <>
          <SetRow
            className="mt-[18px]"
            center
            title="People per booking"
            description="Raise it to send a crew. Each person is picked the same way, without repeats."
          >
            <Stepper
              value={draft.team.crewSize}
              min={1}
              max={10}
              label="People per booking"
              onChange={(crewSize) => patch({ team: { crewSize } })}
            />
          </SetRow>
          <Callout>{teamSentence(draft, catalogs)}</Callout>
        </>
      )}
    </>
  );
}

// ---------- Services & lengths ----------

const LENGTHS = [15, 20, 30, 45, 60, 75, 90, 120, 150, 180, 240, 300, 360, 480];
const STEPS = [5, 10, 15, 20, 30, 45, 60, 90, 120];

function ServicesModule({ draft, patch, services, resources, workspaceId }: ModuleProps) {
  const mode = draft.services.mode;
  const items = draft.services.items;
  const listed = services.filter((s) => !s.archivedAt || items.some((i) => i.serviceId === s.id));
  const minutes = draft.durations.minutes;
  const resourceName = (id: string) => resources.find((r) => r.id === id)?.name ?? 'a resource';
  return (
    <>
      <Heading
        title="Services & lengths"
        description="What customers book, and how long it takes."
      />
      <SetRow
        first
        center
        title="Services"
        description="Off books plain time. One service puts every booking on it. Customer picks lets them choose."
      >
        <Segmented
          value={mode}
          ariaLabel="Services"
          onChange={(v) => patch({ services: { mode: v } })}
          options={[
            { value: 'none', label: 'Off', testId: 'services-none' },
            { value: 'one', label: 'One service', testId: 'services-one' },
            { value: 'choice', label: 'Customer picks', testId: 'services-choice' },
          ]}
        />
      </SetRow>
      {mode !== 'none' ? (
        <div className="border-t border-border py-3" data-testid="service-picks">
          {listed.length === 0 ? (
            <p className="text-[13px] text-text-2">
              No services yet.{' '}
              <Link
                href={`/app/w/${workspaceId}/settings/calendars/services`}
                className="font-medium text-accent-text hover:underline"
              >
                Add services
              </Link>{' '}
              first, then pick them here.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {listed.map((s) => {
                const on = items.some((i) => i.serviceId === s.id);
                return (
                  <Checkbox
                    key={s.id}
                    checked={on}
                    onChange={() =>
                      patch({
                        services: {
                          items: on
                            ? items.filter((i) => i.serviceId !== s.id)
                            : [...items, { serviceId: s.id, overrides: {} }],
                        },
                      })
                    }
                    label={
                      <span className="flex flex-col">
                        <span className="font-medium">
                          {s.name}
                          {s.archivedAt ? ' (archived)' : ''}
                        </span>
                        <span className="text-xs text-text-3">
                          {s.durations.map(fmtLength).join(', ')}
                          {s.resources.length
                            ? ` · Needs ${s.resources.map((r) => resourceName(r.resourceId)).join(', ')}`
                            : ''}
                        </span>
                      </span>
                    }
                  />
                );
              })}
            </div>
          )}
        </div>
      ) : null}
      <SetRow
        title="Lengths"
        description={
          mode === 'none'
            ? 'How long a booking lasts. The first is the default.'
            : 'Used when a service has no lengths of its own. The first is the default.'
        }
        body={
          <span className="mt-1.5 flex flex-wrap items-center gap-1.5" data-testid="lengths">
            {minutes.map((m) => (
              <span
                key={m}
                className="inline-flex h-[30px] items-center gap-1.5 rounded-full bg-accent-soft pl-3 pr-2 text-[13px] font-medium text-accent-text"
              >
                {fmtLength(m)}
                {minutes.length > 1 ? (
                  <button
                    type="button"
                    aria-label={`Remove ${fmtLength(m)}`}
                    onClick={() =>
                      patch({ durations: { minutes: minutes.filter((x) => x !== m) } })
                    }
                  >
                    <X className="h-3.5 w-3.5" strokeWidth={1.75} />
                  </button>
                ) : null}
              </span>
            ))}
            {minutes.length < 6 ? (
              <Select
                selectSize="sm"
                className="h-[30px] w-[130px] text-[13px]"
                aria-label="Add a length"
                value=""
                onChange={(e) =>
                  e.target.value &&
                  patch({ durations: { minutes: [...minutes, Number(e.target.value)] } })
                }
              >
                <option value="">Add a length</option>
                {LENGTHS.filter((m) => !minutes.includes(m)).map((m) => (
                  <option key={m} value={m}>
                    {fmtLength(m)}
                  </option>
                ))}
              </Select>
            ) : null}
          </span>
        }
      />
      <SetRow
        center
        title="Customers pick the length"
        description="Otherwise every booking uses the first length."
      >
        <Switch
          checked={draft.durations.customerChooses}
          label="Customers pick the length"
          onChange={(v) => patch({ durations: { customerChooses: v } })}
        />
      </SetRow>
      <SetRow center title="Start times every" description="How far apart the times offered are.">
        <Select
          selectSize="sm"
          className="w-[120px]"
          aria-label="Start times every"
          value={String(draft.durations.step)}
          onChange={(e) => patch({ durations: { step: Number(e.target.value) } })}
        >
          {STEPS.map((m) => (
            <option key={m} value={m}>
              {fmtLength(m)}
            </option>
          ))}
        </Select>
      </SetRow>
    </>
  );
}

// ---------- Availability ----------

function AvailabilityModule({ draft, patch }: ModuleProps) {
  const hours = draft.schedule.hours;
  const staffless = draft.team.assignment === 'none';
  return (
    <>
      <Heading
        title="Availability"
        description={
          staffless
            ? 'When this calendar can be booked. With no staff, these are your open hours, so set them to the shop’s.'
            : 'When this calendar can be booked. Each person’s own hours and time off always apply too.'
        }
      />
      <div role="radiogroup" aria-label="How it books" className="grid gap-2.5 @md:grid-cols-2">
        <RadioCard
          selected={draft.schedule.mode === 'hours'}
          onSelect={() => patch({ schedule: { mode: 'hours' } })}
          title={<span className="text-[13px]">Open hours</span>}
          description={<span className="text-xs">Customers pick any open time.</span>}
          testId="schedule-hours"
        />
        <RadioCard
          selected={draft.schedule.mode === 'sessions'}
          onSelect={() => patch({ schedule: { mode: 'sessions' } })}
          title={<span className="text-[13px]">Fixed sessions</span>}
          description={<span className="text-xs">You publish dates and customers take seats.</span>}
          testId="schedule-sessions"
        />
      </div>
      <SetRow
        className="mt-3"
        center
        title="Calendar hours"
        description={
          staffless
            ? 'Only offer times inside these hours. Off means any hour of every day.'
            : 'Only offer times inside these hours, on top of each person’s own.'
        }
      >
        <Switch
          checked={!!hours}
          label="Calendar hours"
          onChange={(on) => patch({ schedule: { hours: on ? WEEKDAYS_9_TO_5 : null } })}
        />
      </SetRow>
      {hours ? (
        <WeeklyHoursEditor
          value={hours}
          onChange={(h) => patch({ schedule: { hours: h } })}
          idPrefix="calendar-hours"
        />
      ) : null}
    </>
  );
}

// ---------- Capacity ----------

function CapacityModule({ draft, patch }: ModuleProps) {
  const c = draft.capacity;
  return (
    <>
      <Heading title="Capacity" description="How many customers one time can take." />
      <SetRow
        first
        center
        title="Seats per time"
        description="How many customers can book the same time."
      >
        <NumberField
          value={c.seats}
          min={1}
          max={500}
          label="Seats per time"
          testId="capacity-seats"
          onChange={(v) => v !== null && patch({ capacity: { seats: v } })}
        />
      </SetRow>
      <SetRow center title="Largest group" description="How many seats one booking can take.">
        <NumberField
          value={c.maxPartySize}
          min={1}
          max={500}
          label="Largest group"
          testId="capacity-party"
          onChange={(v) => v !== null && patch({ capacity: { maxPartySize: v } })}
        />
      </SetRow>
      <SetRow center title="Show seats left" description="The booking page says how many are left.">
        <Switch
          checked={c.showSeatsLeft}
          label="Show seats left"
          onChange={(v) => patch({ capacity: { showSeatsLeft: v } })}
        />
      </SetRow>
    </>
  );
}

// ---------- Locations ----------

const KINDS: LocationKind[] = ['customer_address', 'business', 'virtual', 'phone'];

function LocationsModule({ draft, patch }: ModuleProps) {
  const options = draft.locations.options;
  const set = (next: typeof options) => patch({ locations: { options: [...next] } });
  return (
    <>
      <Heading title="Locations" description="Where appointments happen." />
      <div data-testid="locations">
        {options.length === 0 ? (
          <p className="border-t border-border py-3 text-[13px] text-text-3">
            No place set. Appointments show without a location.
          </p>
        ) : null}
        {options.map((o, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2 border-t border-border py-2.5">
            <Select
              selectSize="sm"
              className="w-[190px]"
              aria-label={`Place ${i + 1}`}
              value={o.kind}
              onChange={(e) =>
                set(
                  options.map((x, j) =>
                    j === i
                      ? {
                          kind: e.target.value as LocationKind,
                          address: null,
                          meetingUrl: null,
                          video: 'none' as const,
                        }
                      : x,
                  ),
                )
              }
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {capital(LOCATION_NAMES[k])}
                </option>
              ))}
            </Select>
            {o.kind === 'business' ? (
              <CommitInput
                label="Business address"
                placeholder="Address"
                className="min-w-[200px] flex-1"
                value={o.address ?? ''}
                onCommit={(v) =>
                  set(options.map((x, j) => (j === i ? { ...x, address: v.trim() || null } : x)))
                }
              />
            ) : o.kind === 'virtual' ? (
              <>
                <Select
                  selectSize="sm"
                  className="w-[200px]"
                  aria-label="Video link"
                  value={o.video}
                  onChange={(e) =>
                    set(
                      options.map((x, j) =>
                        j === i
                          ? {
                              ...x,
                              video: e.target.value as 'none' | 'google_meet' | 'zoom',
                              meetingUrl: null,
                            }
                          : x,
                      ),
                    )
                  }
                >
                  <option value="none">Use my link</option>
                  <option value="google_meet">Make a Google Meet link</option>
                  <option value="zoom">Make a Zoom link</option>
                </Select>
                {o.video !== 'none' ? (
                  <span className="min-w-[200px] flex-1 text-xs text-text-3">
                    Each appointment gets its own link, made in the host’s{' '}
                    {o.video === 'zoom' ? 'Zoom account' : 'Google Calendar'}. They connect it in
                    Settings → My calendar.
                  </span>
                ) : (
                  <CommitInput
                    label="Meeting link"
                    placeholder="https://"
                    className="min-w-[200px] flex-1"
                    value={o.meetingUrl ?? ''}
                    onCommit={(v) =>
                      set(
                        options.map((x, j) =>
                          j === i ? { ...x, meetingUrl: v.trim() || null } : x,
                        ),
                      )
                    }
                  />
                )}
              </>
            ) : (
              <span className="flex-1 text-xs text-text-3">
                {o.kind === 'customer_address'
                  ? 'The customer gives their address when they book.'
                  : 'You call the customer.'}
              </span>
            )}
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Remove ${LOCATION_NAMES[o.kind]}`}
              onClick={() => set(options.filter((_, j) => j !== i))}
            >
              <Trash2 className="h-4 w-4" strokeWidth={1.5} />
            </Button>
          </div>
        ))}
        {options.length < 10 ? (
          <div className="border-t border-border pt-3">
            <Select
              selectSize="sm"
              className="w-[190px]"
              aria-label="Add a place"
              value=""
              onChange={(e) =>
                e.target.value &&
                set([
                  ...options,
                  {
                    kind: e.target.value as LocationKind,
                    address: null,
                    meetingUrl: null,
                    video: 'none' as const,
                  },
                ])
              }
            >
              <option value="">Add a place</option>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {capital(LOCATION_NAMES[k])}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
      </div>
      {options.length > 1 ? (
        <SetRow
          center
          title="Customers pick the place"
          description="Otherwise the first one is used."
        >
          <Switch
            checked={draft.locations.customerChooses}
            label="Customers pick the place"
            onChange={(v) => patch({ locations: { customerChooses: v } })}
          />
        </SetRow>
      ) : null}
    </>
  );
}

// ---------- Resources ----------

function ResourcesModule({ draft, patch, resources, workspaceId }: ModuleProps) {
  const required = draft.resources.required;
  const set = (next: typeof required) => patch({ resources: { required: [...next] } });
  const addable = resources.filter(
    (r) => !r.archivedAt && !required.some((x) => x.resourceId === r.id),
  );
  return (
    <>
      <Heading
        title="Resources"
        description="Rooms, trucks or equipment every booking here reserves. Services can need their own too."
      />
      {required.map((r, i) => {
        const res = resources.find((x) => x.id === r.resourceId);
        return (
          <div key={r.resourceId} className="flex items-center gap-3 border-t border-border py-2.5">
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-[13px] font-medium">
                {res?.name ?? 'A resource'}
                {res?.archivedAt ? ' (archived)' : ''}
              </span>
              <span className="text-xs text-text-3">{res ? `${res.quantity} in all` : ''}</span>
            </span>
            <Stepper
              value={r.quantity}
              min={1}
              max={100}
              label={`How many ${res?.name ?? 'of it'}`}
              onChange={(quantity) =>
                set(required.map((x, j) => (j === i ? { ...x, quantity } : x)))
              }
            />
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Remove ${res?.name ?? 'resource'}`}
              onClick={() => set(required.filter((_, j) => j !== i))}
            >
              <Trash2 className="h-4 w-4" strokeWidth={1.5} />
            </Button>
          </div>
        );
      })}
      <div className="border-t border-border pt-3">
        {resources.length === 0 ? (
          <p className="text-[13px] text-text-2">
            No resources yet.{' '}
            <Link
              href={`/app/w/${workspaceId}/settings/calendars/resources`}
              className="font-medium text-accent-text hover:underline"
            >
              Add one
            </Link>
            .
          </p>
        ) : addable.length ? (
          <Select
            selectSize="sm"
            className="w-[220px]"
            aria-label="Add a resource"
            value=""
            onChange={(e) =>
              e.target.value && set([...required, { resourceId: e.target.value, quantity: 1 }])
            }
          >
            <option value="">Add a resource</option>
            {addable.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        ) : (
          <p className="text-xs text-text-3">Every resource is on this calendar.</p>
        )}
      </div>
    </>
  );
}

// ---------- Buffers & travel ----------

const BUFFERS = [0, 5, 10, 15, 20, 30, 45, 60, 90, 120];
const TRAVEL = [0, 10, 15, 20, 30, 45, 60, 90, 120];

function MinutesSelect({
  value,
  options,
  label,
  onChange,
}: {
  value: number;
  options: readonly number[];
  label: string;
  onChange: (v: number) => void;
}) {
  const list = options.includes(value) ? options : [...options, value].sort((a, b) => a - b);
  return (
    <Select
      selectSize="sm"
      className="w-[130px]"
      aria-label={label}
      value={String(value)}
      onChange={(e) => onChange(Number(e.target.value))}
    >
      {list.map((m) => (
        <option key={m} value={m}>
          {minutesLabel(m)}
        </option>
      ))}
    </Select>
  );
}

function BuffersModule({ draft, patch }: ModuleProps) {
  const b = draft.buffers;
  return (
    <>
      <Heading title="Buffers & travel" description="Time kept free around each booking." />
      <SetRow first center title="Before each booking" description="Setup time nobody can book.">
        <MinutesSelect
          value={b.before}
          options={BUFFERS}
          label="Before each booking"
          onChange={(before) => patch({ buffers: { before } })}
        />
      </SetRow>
      <SetRow center title="After each booking" description="Cleanup time nobody can book.">
        <MinutesSelect
          value={b.after}
          options={BUFFERS}
          label="After each booking"
          onChange={(after) => patch({ buffers: { after } })}
        />
      </SetRow>
      <SetRow
        center
        title="Travel time"
        description="Kept before and after visits at the customer’s address."
      >
        <MinutesSelect
          value={b.travelMinutes}
          options={TRAVEL}
          label="Travel time"
          onChange={(travelMinutes) => patch({ buffers: { travelMinutes } })}
        />
      </SetRow>
    </>
  );
}

// ---------- Territories ----------

function TerritoriesModule({ draft, patch, territories, people, workspaceId }: ModuleProps) {
  const ids = draft.territory.territoryIds;
  const zip = draft.territory.routing === 'zip';
  const name = (id: string) => people.find((p) => p.userId === id)?.fullName ?? 'Someone';
  return (
    <>
      <Heading
        title="Territories"
        description="Send each booking to someone who covers the customer’s ZIP code."
      />
      <SetRow
        first
        center
        title="Route by ZIP code"
        description="Customers enter their ZIP first. Only people in a territory that covers it can take the booking."
      >
        <Switch
          checked={zip}
          label="Route by ZIP code"
          onChange={(on) => patch({ territory: { routing: on ? 'zip' : 'off' } })}
        />
      </SetRow>
      {zip ? (
        <div className="border-t border-border py-3">
          {territories.length === 0 ? (
            <p className="text-[13px] text-text-2">No territories yet.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {territories.map((t) => (
                <Checkbox
                  key={t.id}
                  checked={ids.includes(t.id)}
                  onChange={(e) =>
                    patch({
                      territory: {
                        territoryIds: e.target.checked
                          ? [...ids, t.id]
                          : ids.filter((x) => x !== t.id),
                      },
                    })
                  }
                  label={
                    <span className="flex flex-col">
                      <span className="font-medium">{t.name}</span>
                      <span className="text-xs text-text-3">
                        {t.postalCodes.length} ZIP codes ·{' '}
                        {t.userIds.length
                          ? t.userIds.map((u) => firstName(name(u))).join(', ')
                          : 'nobody yet'}
                      </span>
                    </span>
                  }
                />
              ))}
              <p className="text-xs text-text-3">
                {ids.length
                  ? 'Only the ticked territories count.'
                  : 'None ticked means every territory counts.'}
              </p>
            </div>
          )}
          <Link
            href={`/app/w/${workspaceId}/settings/calendars/territories`}
            className="mt-2 inline-block text-[13px] font-medium text-accent-text hover:underline"
          >
            Edit territories
          </Link>
        </div>
      ) : null}
    </>
  );
}

// ---------- Booking window ----------

const NOTICE = [0, 30, 60, 120, 240, 480, 720, 1440, 2880, 4320, 10080];

function WindowModule({ draft, patch }: ModuleProps) {
  const w = draft.window;
  const notice = NOTICE.includes(w.minNoticeMinutes)
    ? NOTICE
    : [...NOTICE, w.minNoticeMinutes].sort((a, b) => a - b);
  return (
    <>
      <Heading
        title="Booking window"
        description="How soon, and how far ahead, customers can book."
      />
      <SetRow first center title="Minimum notice" description="The soonest a customer can book.">
        <Select
          selectSize="sm"
          className="w-[130px]"
          aria-label="Minimum notice"
          value={String(w.minNoticeMinutes)}
          onChange={(e) => patch({ window: { minNoticeMinutes: Number(e.target.value) } })}
        >
          {notice.map((m) => (
            <option key={m} value={m}>
              {m === 0 ? 'None' : formatNotice(m)}
            </option>
          ))}
        </Select>
      </SetRow>
      <SetRow center title="Books up to" description="The furthest ahead a customer can book.">
        <NumberField
          value={w.maxDaysAhead}
          min={1}
          max={365}
          label="Days ahead"
          suffix="days ahead"
          onChange={(v) => v !== null && patch({ window: { maxDaysAhead: v } })}
        />
      </SetRow>
      <SetRow
        title="Only between"
        description="Leave empty to keep taking bookings with no end date."
        body={
          <span className="mt-1.5 flex flex-wrap items-center gap-2">
            <Input
              type="date"
              inputSize="sm"
              className="w-[150px]"
              aria-label="From date"
              value={w.dateFrom ?? ''}
              onChange={(e) => patch({ window: { dateFrom: e.target.value || null } })}
            />
            <span className="text-text-3">to</span>
            <Input
              type="date"
              inputSize="sm"
              className="w-[150px]"
              aria-label="To date"
              value={w.dateTo ?? ''}
              onChange={(e) => patch({ window: { dateTo: e.target.value || null } })}
            />
            {w.dateFrom || w.dateTo ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => patch({ window: { dateFrom: null, dateTo: null } })}
              >
                Clear
              </Button>
            ) : null}
          </span>
        }
      />
      <SetRow
        center
        title="Daily limit per person"
        description="The most bookings one person takes from this calendar in a day."
      >
        <NumberField
          value={w.dailyLimitPerPerson}
          nullable
          placeholder="No limit"
          min={1}
          max={50}
          label="Daily limit per person"
          onChange={(v) => patch({ window: { dailyLimitPerPerson: v } })}
        />
      </SetRow>
    </>
  );
}

// ---------- Repeats, waitlist ----------

function RepeatsModule({ draft, patch }: ModuleProps) {
  const r = draft.recurring;
  return (
    <>
      <Heading title="Repeats" description="Visits that happen weekly or monthly." />
      <SetRow
        first
        center
        title="Staff can repeat visits"
        description="Book a series from the calendar."
      >
        <Switch
          checked={r.staffSeries}
          label="Staff can repeat visits"
          onChange={(v) => patch({ recurring: { staffSeries: v } })}
        />
      </SetRow>
      <SetRow
        center
        title="Customers can repeat"
        description="Customers book a series on the booking page."
      >
        <Switch
          checked={r.customerSeries}
          label="Customers can repeat"
          onChange={(v) => patch({ recurring: { customerSeries: v } })}
        />
      </SetRow>
      <SetRow center title="Most visits in a series" description="Up to 52.">
        <NumberField
          value={r.maxOccurrences}
          min={1}
          max={52}
          label="Most visits in a series"
          onChange={(v) => v !== null && patch({ recurring: { maxOccurrences: v } })}
        />
      </SetRow>
    </>
  );
}

const OFFERS = [15, 30, 60, 120, 240, 720, 1440];

type WaitlistEntry = Ok<'/v1/queries/waitlist.list'>['items'][number];

/** "Fri, Sep 18 · 9:00 AM–12:00 PM", or both ends when the window runs over more than a day. */
function windowLabel(w: WaitlistEntry, timeZone: string): string {
  const from = w.wantedFrom!;
  const to = w.wantedTo!;
  return dateOf(from, timeZone) === dateOf(to, timeZone)
    ? fmtWhen(from, to, timeZone)
    : `${fmtAt(from, timeZone)} – ${fmtAt(to, timeZone)}`;
}

/**
 * Customers waiting for a window of time. They’re on no appointment, so this is the one place they show.
 * Remove takes them off right away (waitlist.remove), like Automations’ switches, not with Save.
 */
function WaitingForTimes({
  workspaceId,
  calendarId,
  hideWhenEmpty,
}: {
  workspaceId: string;
  calendarId: string;
  /** The waitlist is off, or the calendar books fixed sessions: nobody new waits for a time. */
  hideWhenEmpty: boolean;
}) {
  const [list, setList] = useState<{ timezone: string; items: WaitlistEntry[] } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  // Joins, offers and removals are the calendar’s events.
  const changes = useLiveVersion(['calendar']);

  const load = useCallback(async () => {
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/queries/waitlist.list', {
          body: { workspaceId, calendarId },
        }),
      );
      setList({ timezone: out.timezone, items: out.items.filter((e) => !e.appointment) });
    } catch (e) {
      toast.error(errorMessage(e));
      setList((had) => had ?? { timezone: 'UTC', items: [] });
    }
  }, [workspaceId, calendarId]);

  useEffect(() => {
    void load();
  }, [load, changes]);

  async function remove(e: WaitlistEntry) {
    const first = firstName(e.fullName);
    if (!confirm(`Take ${first} off the waitlist?`)) return;
    setRemoving(e.id);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/waitlist.remove', {
          body: { workspaceId, entryId: e.id },
        }),
      );
      toast.success(`${first} is off the waitlist.`);
      await load();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setRemoving(null);
    }
  }

  if (hideWhenEmpty && list && !list.items.length) return null;
  return (
    <div className="border-t border-border pt-3.5" data-testid="waitlist-times">
      <div className="text-[13px] font-medium">Waiting for a time</div>
      <div className="mt-1 max-w-[420px] text-xs text-text-3">
        Customers who want any opening in a window of time. A time that frees up in their window is
        offered to them, first come first served.
      </div>
      {list === null ? (
        <p className="mt-3 text-[13px] text-text-3">Loading…</p>
      ) : !list.items.length ? (
        <p className="mt-3 text-[13px] text-text-2">Nobody is waiting for a time.</p>
      ) : (
        <div className="mt-2">
          {list.items.map((e) => (
            <div
              key={e.id}
              className="flex items-center gap-3 border-t border-border py-2.5 first:border-t-0"
              data-testid={`waitlist-entry-${e.id}`}
            >
              <Avatar name={e.fullName} seed={e.personId} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[13px] font-medium">
                  {e.fullName}
                  {e.seats > 1 ? ` · ${e.seats} people` : ''}
                </span>
                <span className="truncate text-xs text-text-3">
                  {windowLabel(e, list.timezone)}
                  {e.status === 'offered' && e.offerExpiresAt
                    ? ` · Offered a time until ${fmtAt(e.offerExpiresAt, list.timezone)}`
                    : ''}
                </span>
              </span>
              <Button
                variant="secondary"
                size="sm"
                className="flex-none"
                disabled={removing === e.id}
                aria-label={`Take ${firstName(e.fullName)} off the waitlist`}
                onClick={() => void remove(e)}
              >
                Remove
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function WaitlistModule({ workspaceId, calendarId, draft, patch }: ModuleProps) {
  const w = draft.waitlist;
  return (
    <>
      <Heading title="Waitlist" description="What happens when there’s no room." />
      <SetRow
        first
        center
        title="Waitlist"
        description="When it’s full, customers can join a waitlist. A freed seat goes to the first person waiting."
      >
        <Switch
          checked={w.enabled}
          label="Waitlist"
          onChange={(v) => patch({ waitlist: { enabled: v } })}
        />
      </SetRow>
      <SetRow
        center
        title="Offers last"
        description="For single appointments, how long the first person waiting has to take an opening."
      >
        <MinutesSelect
          value={w.offerMinutes}
          options={OFFERS}
          label="Offers last"
          onChange={(offerMinutes) => patch({ waitlist: { offerMinutes } })}
        />
      </SetRow>
      {calendarId ? (
        <WaitingForTimes
          workspaceId={workspaceId}
          calendarId={calendarId}
          hideWhenEmpty={!w.enabled || draft.schedule.mode === 'sessions'}
        />
      ) : null}
    </>
  );
}

// ---------- Intake questions ----------

const QUESTION_KINDS = [
  ['short_text', 'Short answer'],
  ['long_text', 'Long answer'],
  ['select', 'Pick one'],
  ['multi_select', 'Pick any'],
  ['checkbox', 'Yes or no'],
  ['number', 'Number'],
  ['date', 'Date'],
] as const;
type QuestionKind = (typeof QUESTION_KINDS)[number][0];

function IntakeModule({ draft, patch }: ModuleProps) {
  const questions = draft.intake.questions;
  const set = (next: typeof questions) => patch({ intake: { questions: [...next] } });
  const change = (i: number, q: Partial<(typeof questions)[number]>) =>
    set(questions.map((x, j) => (j === i ? { ...x, ...q } : x)));
  return (
    <>
      <Heading title="Intake questions" description="What customers answer when they book." />
      {questions.map((q, i) => (
        <div
          key={q.id}
          className="mb-2.5 flex flex-col gap-2 rounded-menu border border-border p-3"
        >
          <div className="flex flex-wrap items-center gap-2">
            <CommitInput
              label={`Question ${i + 1}`}
              className="min-w-[200px] flex-1"
              value={q.label}
              onCommit={(label) => label.trim() && change(i, { label: label.trim() })}
            />
            <Select
              selectSize="sm"
              className="w-[140px]"
              aria-label={`Answer for question ${i + 1}`}
              value={q.kind}
              onChange={(e) => {
                const kind = e.target.value as QuestionKind;
                const choices = kind === 'select' || kind === 'multi_select';
                change(i, {
                  kind,
                  options: choices && !q.options.length ? ['Option 1'] : q.options,
                });
              }}
            >
              {QUESTION_KINDS.map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </Select>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Remove question ${i + 1}`}
              onClick={() => set(questions.filter((_, j) => j !== i))}
            >
              <Trash2 className="h-4 w-4" strokeWidth={1.5} />
            </Button>
          </div>
          {q.kind === 'select' || q.kind === 'multi_select' ? (
            <CommitInput
              label={`Choices for question ${i + 1}`}
              placeholder="Choices, separated by commas"
              value={q.options.join(', ')}
              onCommit={(v) => {
                const options = v
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean);
                if (options.length) change(i, { options });
              }}
            />
          ) : null}
          <label className="flex items-center gap-2 text-[13px] text-text-2">
            <Switch
              checked={q.required}
              label={`Question ${i + 1} required`}
              onChange={(required) => change(i, { required })}
            />
            Required
          </label>
        </div>
      ))}
      {questions.length < 20 ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            set([
              ...questions,
              {
                id: `q${Math.random().toString(36).slice(2, 8)}`,
                label: 'New question',
                kind: 'short_text',
                required: false,
                options: [],
              },
            ])
          }
        >
          <Plus className="h-4 w-4" strokeWidth={1.75} />
          Add a question
        </Button>
      ) : null}
    </>
  );
}

// ---------- Cancel & reschedule rules ----------

function RulesModule({ draft, patch }: ModuleProps) {
  const p = draft.policies;
  return (
    <>
      <Heading
        title="Cancel & reschedule rules"
        description="What customers can change themselves, from their confirmation."
      />
      <SetRow first center title="Customers can cancel">
        <Switch
          checked={p.cancel.allowed}
          label="Customers can cancel"
          onChange={(v) => patch({ policies: { cancel: { allowed: v } } })}
        />
      </SetRow>
      {p.cancel.allowed ? (
        <SetRow center title="Cancel up to" description="0 means any time before.">
          <NumberField
            value={p.cancel.cutoffHours}
            min={0}
            max={720}
            label="Cancel up to"
            suffix="hours before"
            onChange={(v) => v !== null && patch({ policies: { cancel: { cutoffHours: v } } })}
          />
        </SetRow>
      ) : null}
      <SetRow center title="Customers can reschedule">
        <Switch
          checked={p.reschedule.allowed}
          label="Customers can reschedule"
          onChange={(v) => patch({ policies: { reschedule: { allowed: v } } })}
        />
      </SetRow>
      {p.reschedule.allowed ? (
        <>
          <SetRow center title="Reschedule up to" description="0 means any time before.">
            <NumberField
              value={p.reschedule.cutoffHours}
              min={0}
              max={720}
              label="Reschedule up to"
              suffix="hours before"
              onChange={(v) =>
                v !== null && patch({ policies: { reschedule: { cutoffHours: v } } })
              }
            />
          </SetRow>
          <SetRow center title="Most reschedules" description="Per booking.">
            <NumberField
              value={p.reschedule.maxTimes}
              min={0}
              max={20}
              label="Most reschedules"
              suffix="times"
              onChange={(v) => v !== null && patch({ policies: { reschedule: { maxTimes: v } } })}
            />
          </SetRow>
        </>
      ) : null}
      <SetRow
        title="Policy"
        description="Shown on the booking page and in confirmations."
        className="flex-col"
        body={
          <PolicyText
            value={p.policyText}
            onCommit={(policyText) => patch({ policies: { policyText } })}
          />
        }
      />
    </>
  );
}

function PolicyText({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [text, setText] = useState<string | null>(null);
  return (
    <Textarea
      aria-label="Policy"
      className="mt-1.5 w-full min-w-[280px] text-[14px]"
      value={text ?? value}
      maxLength={2000}
      placeholder="Please give us a day’s notice if you need to cancel."
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (text !== null && text !== value) onCommit(text.trim());
        setText(null);
      }}
    />
  );
}

// ---------- Notifications ----------

const BEFORE = [15, 30, 60, 120, 180, 240, 1440];

function NotifyModule({ draft, patch }: ModuleProps) {
  const n = draft.notifications;
  const reminders = n.reminders;
  const setReminders = (next: Reminder[]) => patch({ notifications: { reminders: next } });
  return (
    <>
      <Heading title="Notifications" description="What customers and the team hear about." />
      <SetRow
        first
        title="Confirmation"
        description="Sent when someone books."
        body={
          <span className="mt-1.5 flex gap-5">
            <Checkbox
              label="Text"
              checked={n.confirmation.text}
              onChange={(e) =>
                patch({ notifications: { confirmation: { text: e.target.checked } } })
              }
            />
            <Checkbox
              label="Email"
              checked={n.confirmation.email}
              onChange={(e) =>
                patch({ notifications: { confirmation: { email: e.target.checked } } })
              }
            />
          </span>
        }
      />
      <SetRow
        title="Reminders"
        description="Before each appointment."
        body={
          <span className="mt-1.5 flex flex-col gap-2" data-testid="reminders">
            {reminders.map((r, i) => (
              <span key={i} className="flex flex-wrap items-center gap-2">
                <Select
                  selectSize="sm"
                  className="w-[150px]"
                  aria-label={`Reminder ${i + 1}`}
                  value={r.kind}
                  onChange={(e) =>
                    setReminders(
                      reminders.map((x, j) =>
                        j === i
                          ? e.target.value === 'day_before'
                            ? { kind: 'day_before', at: '16:00' }
                            : { kind: 'before', minutes: 120 }
                          : x,
                      ),
                    )
                  }
                >
                  <option value="day_before">The day before</option>
                  <option value="before">Hours before</option>
                </Select>
                {r.kind === 'day_before' ? (
                  <Select
                    selectSize="sm"
                    className="w-[120px]"
                    aria-label={`Reminder ${i + 1} time`}
                    value={String(parseClock(r.at))}
                    onChange={(e) =>
                      setReminders(
                        reminders.map((x, j) =>
                          j === i
                            ? { kind: 'day_before', at: minutesToClock(Number(e.target.value)) }
                            : x,
                        ),
                      )
                    }
                  >
                    {TIME_OPTIONS.map(([m, label]) => (
                      <option key={m} value={m}>
                        at {label}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <MinutesSelect
                    value={r.minutes}
                    options={BEFORE}
                    label={`Reminder ${i + 1} lead time`}
                    onChange={(minutes) =>
                      setReminders(
                        reminders.map((x, j) => (j === i ? { kind: 'before', minutes } : x)),
                      )
                    }
                  />
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove reminder ${i + 1}`}
                  onClick={() => setReminders(reminders.filter((_, j) => j !== i))}
                >
                  <Trash2 className="h-4 w-4" strokeWidth={1.5} />
                </Button>
              </span>
            ))}
            {reminders.length < 5 ? (
              <span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setReminders([...reminders, { kind: 'before', minutes: 120 }])}
                >
                  <Plus className="h-4 w-4" strokeWidth={1.75} />
                  Add a reminder
                </Button>
              </span>
            ) : null}
          </span>
        }
      />
      <SetRow
        title="Send reminders by"
        body={
          <span className="mt-1.5 flex gap-5">
            <Checkbox
              label="Text"
              checked={n.reminderChannels.text}
              onChange={(e) =>
                patch({ notifications: { reminderChannels: { text: e.target.checked } } })
              }
            />
            <Checkbox
              label="Email"
              checked={n.reminderChannels.email}
              onChange={(e) =>
                patch({ notifications: { reminderChannels: { email: e.target.checked } } })
              }
            />
          </span>
        }
      />
      <SetRow
        center
        title="Email the team about new bookings"
        description="The person booked gets an email."
      >
        <Switch
          checked={n.staffEmail}
          label="Email the team about new bookings"
          onChange={(v) => patch({ notifications: { staffEmail: v } })}
        />
      </SetRow>
      <Callout>
        Texts never go out in the workspace’s quiet hours. A 2-hour text that lands in quiet hours
        goes when they end if the visit is still 45 minutes or more away, or by email otherwise.
        People who don’t take texts get email.
      </Callout>
    </>
  );
}

// ---------- Connections, CRM, and what's coming ----------

function ConnectionsModule({ draft, patch }: ModuleProps) {
  const c = draft.integrations;
  return (
    <>
      <Heading
        title="Calendar connections"
        description="People’s own Google and Outlook calendars. Each person connects theirs in Settings, then My calendar."
      />
      <SetRow
        first
        center
        title="Check people’s calendars"
        description="Busy times there block booking. We only see that they’re busy, never what it is."
      >
        <Switch
          checked={c.checkStaffCalendars}
          label="Check people’s calendars"
          onChange={(v) => patch({ integrations: { checkStaffCalendars: v } })}
        />
      </SetRow>
      <SetRow
        center
        title="Add appointments to their calendars"
        description="Each appointment shows in the person’s own calendar as an event."
      >
        <Switch
          checked={c.writeEvents}
          label="Add appointments to their calendars"
          onChange={(v) => patch({ integrations: { writeEvents: v } })}
        />
      </SetRow>
    </>
  );
}

function CrmModule({ draft, patch, pipelines }: ModuleProps) {
  const crm = draft.crm;
  const open = pipelines.filter((p) => !p.archivedAt);
  const pipeline = crm.createLead
    ? pipelines.find((p) => p.id === crm.createLead!.pipelineId)
    : undefined;
  const openStages = (p: Pipeline | undefined) => p?.stages.filter((s) => s.kind === 'open') ?? [];
  return (
    <>
      <Heading title="CRM" description="What a booking does to your customers and leads." />
      <SetRow
        first
        center
        title="Customer’s owner"
        description="Who owns a new customer booked here."
      >
        <Select
          selectSize="sm"
          className="w-[200px]"
          aria-label="Customer’s owner"
          value={crm.ownership}
          onChange={(e) =>
            patch({ crm: { ownership: e.target.value as CalendarConfig['crm']['ownership'] } })
          }
        >
          <option value="assigned_staff">Who takes the booking</option>
          <option value="calendar_owner">The calendar’s owner</option>
          <option value="none">Nobody</option>
        </Select>
      </SetRow>
      <SetRow
        center
        title="Set the customer’s owner"
        description="Also make them the owner of a customer who has none."
      >
        <Switch
          checked={crm.assignContactOwner}
          label="Set the customer’s owner"
          onChange={(v) => patch({ crm: { assignContactOwner: v } })}
        />
      </SetRow>
      <SetRow
        center
        title="Create a lead"
        description="Each online booking starts a lead in a pipeline."
      >
        <Switch
          checked={!!crm.createLead}
          label="Create a lead"
          disabled={!open.length}
          onChange={(on) => {
            const p = open[0];
            const stage = openStages(p)[0] ?? p?.stages[0];
            patch({
              crm: {
                createLead: on && p && stage ? { pipelineId: p.id, stageId: stage.id } : null,
              },
            });
          }}
        />
      </SetRow>
      {crm.createLead ? (
        <div className="flex flex-wrap gap-2 border-t border-border py-3">
          <Select
            selectSize="sm"
            className="w-[200px]"
            aria-label="Pipeline"
            value={crm.createLead.pipelineId}
            onChange={(e) => {
              const p = pipelines.find((x) => x.id === e.target.value);
              const stage = openStages(p)[0] ?? p?.stages[0];
              if (p && stage)
                patch({ crm: { createLead: { pipelineId: p.id, stageId: stage.id } } });
            }}
          >
            {open.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
          <Select
            selectSize="sm"
            className="w-[200px]"
            aria-label="Stage"
            value={crm.createLead.stageId}
            onChange={(e) =>
              patch({
                crm: {
                  createLead: { pipelineId: crm.createLead!.pipelineId, stageId: e.target.value },
                },
              })
            }
          >
            {(pipeline?.stages ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </div>
      ) : null}
    </>
  );
}

/**
 * Payments: whether a time is held before money arrives, how much is asked for, and which account it lands in.
 * The business's own deposit (Settings → Payments) is the default, so changing it there changes it everywhere;
 * a calendar that needs its own figure sets one here and keeps it.
 */
function PaymentsModule({ workspaceId, draft, patch, catalogs, payments }: ModuleProps) {
  const mode = draft.payments.mode;
  const own = draft.payments.deposit;
  const accounts = payments?.accounts ?? catalogs.paymentAccounts;
  const chosen = accounts.find((a) => a.id === draft.payments.connectionId) ?? null;
  const fallback = accounts.find((a) => a.isDefault) ?? accounts[0] ?? null;
  const account = chosen ?? fallback;
  const deposit = payments?.deposit ?? { kind: 'none' as const };
  const paySettings = `/app/w/${workspaceId}/settings/payments`;
  const depositWords = (terms: DepositTerms): string =>
    terms.kind === 'percent'
      ? `${(terms.percentBp ?? 0) / 100}% of the price`
      : terms.kind === 'amount'
        ? money(terms.amountCents ?? 0)
        : 'nothing yet';
  /** Which of the three the "How much" picker is on. */
  const depositChoice = own === null ? 'business' : own.kind;

  return (
    <>
      <Heading
        title="Payments"
        description="Take a deposit or the full price when customers book. The time is held while they pay."
      />
      {catalogs.paymentsAvailable ? null : (
        <Callout>
          No payment account is connected yet, so this calendar can only be booked without paying.{' '}
          <Link href={paySettings} className="font-medium underline">
            Connect one in Settings → Payments
          </Link>
          .
        </Callout>
      )}
      <div className="mt-3 flex flex-col gap-2 sm:flex-row" role="radiogroup" aria-label="Payment">
        <RadioCard
          selected={mode === 'none'}
          onSelect={() => patch({ payments: { mode: 'none' } })}
          title="No payment"
          description="Anyone can book without paying."
          testId="pay-mode-none"
        />
        <RadioCard
          selected={mode === 'deposit'}
          onSelect={() => patch({ payments: { mode: 'deposit' } })}
          title="A deposit"
          description="Part now, the rest on the invoice for the job."
          testId="pay-mode-deposit"
        />
        <RadioCard
          selected={mode === 'full'}
          onSelect={() => patch({ payments: { mode: 'full' } })}
          title="The full price"
          description="The whole price before the time is held."
          testId="pay-mode-full"
        />
      </div>
      {mode === 'none' ? null : (
        <div className="mt-3" data-testid="pay-module-detail">
          {mode === 'full' ? (
            <SetRow
              first
              center
              title="How much"
              description="The price of what they book, in full."
            >
              <Link href={paySettings} className="text-[13px] text-accent-text hover:underline">
                Deposits
              </Link>
            </SetRow>
          ) : (
            <SetRow
              first
              title="How much"
              description={
                depositChoice === 'business'
                  ? deposit.kind === 'none'
                    ? 'The business asks for no deposit yet, so nothing is taken up front.'
                    : `The business asks for ${depositWords(deposit)}, then the rest on the invoice for the job.`
                  : `This calendar asks for ${depositWords(own!)}, then the rest on the invoice for the job.`
              }
              body={
                depositChoice === 'business' ? (
                  <Link href={paySettings} className="text-[13px] text-accent-text hover:underline">
                    Change what the business asks for
                  </Link>
                ) : depositChoice === 'percent' ? (
                  <NumberField
                    value={own?.percentBp ? own.percentBp / 100 : null}
                    onChange={(v) =>
                      patch({
                        payments: {
                          deposit: { kind: 'percent', percentBp: Math.round((v ?? 0) * 100) },
                        },
                      })
                    }
                    min={1}
                    max={100}
                    label="Share of the price"
                    suffix="% of the price"
                    nullable
                    testId="deposit-percent"
                  />
                ) : (
                  <NumberField
                    value={own?.amountCents ? Math.round(own.amountCents / 100) : null}
                    onChange={(v) =>
                      patch({
                        payments: { deposit: { kind: 'amount', amountCents: (v ?? 0) * 100 } },
                      })
                    }
                    min={1}
                    max={1_000_000}
                    label="Deposit amount"
                    suffix="dollars"
                    nullable
                    testId="deposit-amount"
                  />
                )
              }
            >
              <Select
                aria-label="How much"
                value={depositChoice}
                data-testid="deposit-kind"
                onChange={(e) =>
                  patch({
                    payments: {
                      deposit:
                        e.target.value === 'business'
                          ? null
                          : e.target.value === 'percent'
                            ? { kind: 'percent', percentBp: own?.percentBp ?? 2_500 }
                            : { kind: 'amount', amountCents: own?.amountCents ?? 10_000 },
                    },
                  })
                }
              >
                <option value="business">What the business asks for</option>
                <option value="percent">A share of the price</option>
                <option value="amount">A set amount</option>
              </Select>
            </SetRow>
          )}
          <SetRow
            center
            title="Paid into"
            description={
              account
                ? `${capital(account.provider)}${account.name ? ` · ${account.name}` : ''}${
                    chosen ? '' : ' — the account everything is paid into'
                  }`
                : 'No account is connected, so nothing can be taken yet.'
            }
          >
            {accounts.length ? (
              <Select
                aria-label="Paid into"
                value={draft.payments.connectionId ?? ''}
                data-testid="pay-account"
                onChange={(e) => patch({ payments: { connectionId: e.target.value || null } })}
              >
                <option value="">The business’s account</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name || capital(a.provider)}
                  </option>
                ))}
              </Select>
            ) : (
              <Link href={paySettings} className="text-[13px] text-accent-text hover:underline">
                Connect one
              </Link>
            )}
          </SetRow>
          <Callout>
            A card is held, not charged, until the time is confirmed — if the time goes while they
            are typing, nothing is taken. A bank transfer can’t be held, so one on a lost time is
            sent back in full, at once.
          </Callout>
        </div>
      )}
    </>
  );
}

function SoonModule({ title, what }: { title: string; what: string }) {
  return (
    <>
      <Heading title={title} description={what} />
      <Callout>
        Coming with Workflows. Run a workflow when someone books, reschedules or cancels.
      </Callout>
    </>
  );
}

export function ModuleForm(props: ModuleProps & { module: ModuleKey }) {
  switch (props.module) {
    case 'team':
      return <TeamModule {...props} />;
    case 'services':
      return <ServicesModule {...props} />;
    case 'availability':
      return <AvailabilityModule {...props} />;
    case 'capacity':
      return <CapacityModule {...props} />;
    case 'locations':
      return <LocationsModule {...props} />;
    case 'resources':
      return <ResourcesModule {...props} />;
    case 'buffers':
      return <BuffersModule {...props} />;
    case 'territories':
      return <TerritoriesModule {...props} />;
    case 'window':
      return <WindowModule {...props} />;
    case 'repeats':
      return <RepeatsModule {...props} />;
    case 'waitlist':
      return <WaitlistModule {...props} />;
    case 'intake':
      return <IntakeModule {...props} />;
    case 'rules':
      return <RulesModule {...props} />;
    case 'notify':
      return <NotifyModule {...props} />;
    case 'connections':
      return <ConnectionsModule {...props} />;
    case 'crm':
      return <CrmModule {...props} />;
    case 'payments':
      return <PaymentsModule {...props} />;
    case 'automations':
      return props.calendarId ? (
        <CalendarAutomations
          workspaceId={props.workspaceId}
          calendarId={props.calendarId}
          calendarName={props.calendarName ?? 'this calendar'}
          notifications={props.draft.notifications}
          legacyIds={props.draft.automations.workflowIds}
        />
      ) : (
        <SoonModule title="Automations" what="Workflows that run when bookings happen." />
      );
  }
}
