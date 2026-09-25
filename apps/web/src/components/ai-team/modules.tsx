'use client';
import {
  APPROVALS_NEEDED_MAX,
  APPROVALS_NEEDED_MIN,
  EXPECTATION_SLOT,
  followUpLadderWords,
  formatClock,
  formatDuration,
  formatHours,
  PHONE_ANSWER_MODES,
  PHONE_VOICES,
  QUIET_FOLLOW_UP_MINUTES,
  TEAMMATE_LINKS,
  type NotifyWho,
  type PhoneAnswerMode,
  type PhoneVoice,
  type TeammateCatalogs,
  type TeammateConfig,
} from '@hfos/core';
import {
  AlertTriangle,
  Check,
  Clock,
  Globe,
  Hourglass,
  Moon,
  Plus,
  ShieldCheck,
  Siren,
  Zap,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Fragment, type MouseEvent } from 'react';
import { WeeklyHoursEditor } from '@/components/calendars/weekly-hours';
import { SetRow } from '@/components/settings/set-row';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Select } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Stepper } from '@/components/ui/stepper';
import { Switch } from '@/components/ui/switch';
import {
  afterHoursWords,
  BUILT_IN_TOPICS,
  EXPECTATION_EXAMPLES,
  firstTextPreview,
  lengthsWords,
  notifyWords,
  percentOfLimit,
  plural,
  progressView,
  type ModuleKey,
} from '@/lib/ai-team/describe';
import type { TeammateProgress } from '@/lib/ai-team/types';
import type { PatchFn } from '@/lib/ai-team/use-draft';
import { cn } from '@/lib/utils';
import { AI_FILL } from './mark';
import {
  AddChip,
  Callout,
  Choice,
  Chip,
  DraftText,
  GroupLabel,
  Locked,
  ModuleHeading,
  Note,
} from './parts';
import { QualifyModule } from './qualify-module';
import { ProgressBlock } from './rail';

export interface ModuleProps {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly draft: TeammateConfig;
  /** Applies a settings patch as one edit (checked; a refused value explains itself). */
  readonly patch: PatchFn;
  readonly catalogs: TeammateCatalogs;
  /** Training-wheels progress, which Autonomy shows. */
  readonly progress: TeammateProgress | null;
  readonly readOnly: boolean;
  /** Saves any change still waiting, before leaving for a page that reads these settings. */
  readonly flush: () => Promise<unknown>;
}

const withCurrent = (list: readonly number[], v: number) =>
  list.includes(v) ? [...list] : [...list, v].sort((a, b) => a - b);
const capital = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const onOff = (on: boolean, what: string) => `${on ? 'Turn on' : 'Turn off'} ${what}`;
const LINK = 'text-[13px] font-medium text-accent-text hover:underline';

/** A calendar's colour as stored, or the accent when it isn't a plain hex colour. */
const calendarColor = (c: string) => (/^#[0-9a-f]{3,8}$/i.test(c) ? c : 'var(--accent)');

const DELAYS = [0, 1, 2, 5, 10, 15, 30, 60, 120];
const EXPIRY = [15, 30, 60, 120, 240, 480, 720, 1440];
const SHARES = [40, 60, 80];
const DISCOUNTS = [5, 10, 15, 20, 25, 30, 40, 50];

// ---------- Identity ----------

function IdentityModule({ draft, patch, workspaceName }: ModuleProps) {
  const id = draft.identity;
  const name = id.name;
  const askedOnly = id.disclosure === 'when_asked';
  return (
    <>
      <ModuleHeading
        title="Identity"
        description={`Who ${name} is and how it introduces itself to customers.`}
      />
      <div className="grid grid-cols-1 gap-3.5 @lg:grid-cols-2">
        <DraftText
          id="teammate-identity-name"
          label="Name"
          value={name}
          maxLength={40}
          hint={`In the inbox it shows as “${name} (AI)”.`}
          testId="identity-name"
          onChange={(v) =>
            patch({ identity: { name: v } }, 'Rename', { group: 'identity.name', quiet: true })
          }
        />
        <DraftText
          id="teammate-identity-signature"
          label="Email signature"
          value={id.signature}
          maxLength={120}
          placeholder={`${name} (AI) · ${workspaceName}`}
          hint="Texts and chats say its name in the first line instead."
          onChange={(v) =>
            patch({ identity: { signature: v } }, 'Change the signature', {
              group: 'identity.signature',
              quiet: true,
            })
          }
        />
      </div>
      <GroupLabel id="identity-disclosure">How {name} tells people it’s AI</GroupLabel>
      <div role="radiogroup" aria-labelledby="identity-disclosure" className="flex flex-col gap-2">
        <Choice
          on={!askedOnly}
          onSelect={() => patch({ identity: { disclosure: 'first_message' } }, 'Say it’s AI first')}
          title="Says it’s AI in its first message"
          badge={
            <Badge variant="ok" className="h-5 text-[11.5px]">
              Recommended
            </Badge>
          }
          description="The first message to each customer starts by saying who it is."
          testId="disclosure-first_message"
        />
        <Choice
          on={askedOnly}
          onSelect={() =>
            patch({ identity: { disclosure: 'when_asked' } }, 'Say it’s AI when asked')
          }
          title="Only when asked"
          description="It answers truthfully whenever someone asks if they’re talking to a bot."
          testId="disclosure-when_asked"
        >
          {askedOnly ? null : (
            <span className="flex items-center gap-1.5 text-xs text-warning-text">
              <AlertTriangle className="h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
              Not for California customers.
            </span>
          )}
        </Choice>
      </div>
      {askedOnly ? (
        <Callout tone="warning" icon={AlertTriangle} className="mt-3" testId="california-warning">
          <strong className="font-semibold">California law.</strong> A bot that helps sell to or
          book California customers has to say it’s a bot up front. If you have customers there,
          keep the first option, or check with a lawyer.
        </Callout>
      ) : null}
      <Callout icon={ShieldCheck} className="mt-3">
        <strong className="font-semibold">Always on.</strong> {name} never says it’s a person. If
        someone sincerely asks, it says it’s an AI assistant, and a check blocks any reply that
        claims otherwise.
      </Callout>
      <DraftText
        id="teammate-identity-tone"
        className="mt-4"
        label="Tone"
        multiline
        rows={3}
        maxLength={300}
        value={id.toneNote}
        placeholder="Friendly and short. Use first names."
        hint="Added to your tone of voice in Knowledge."
        onChange={(v) =>
          patch({ identity: { toneNote: v } }, 'Change the tone', {
            group: 'identity.toneNote',
            quiet: true,
          })
        }
      />
      <GroupLabel>How its first text to someone starts</GroupLabel>
      <div className="flex flex-col gap-1.5 rounded-xl border border-border bg-card-2 px-4 py-3.5">
        <div
          className="max-w-[92%] self-start whitespace-pre-wrap rounded-2xl bg-accent px-[13px] py-[9px] text-sm leading-[1.45] text-white"
          data-testid="identity-first-text"
        >
          {firstTextPreview(name, id.disclosure, workspaceName)}
        </div>
        <span className="text-xs text-text-3">
          An example for a customer named Mike. The rest is written for each conversation.
        </span>
      </div>
    </>
  );
}

// ---------- Channels ----------

function ChannelsModule({ draft, patch, catalogs, workspaceId }: ModuleProps) {
  const c = draft.channels;
  const name = draft.identity.name;
  const base = `/app/w/${workspaceId}`;
  const address = catalogs.emailAddresses[0];
  const widget = catalogs.chatWidgets[0];
  const addressKnown = catalogs.emailAddresses.some((a) => a.id === c.emailAddressId);
  const widgetKnown = catalogs.chatWidgets.some((w) => w.id === c.widgetId);
  return (
    <>
      <ModuleHeading title="Channels" description={`Where ${name} answers your customers.`} />
      <SetRow
        first
        center
        title="Texts"
        description={
          catalogs.textingReady ? (
            'Replies to texts on your business number.'
          ) : (
            <>
              Texting isn’t set up yet.{' '}
              <Link href={`${base}/${TEAMMATE_LINKS.texting}`} className={LINK}>
                Set up texting
              </Link>
            </>
          )
        }
      >
        <Switch
          checked={c.sms}
          label="Texts"
          testId="channel-sms"
          onChange={(v) => patch({ channels: { sms: v } }, onOff(v, 'texting'))}
        />
      </SetRow>
      <SetRow
        center
        title="Email"
        description={c.email ? 'It emails from this address.' : 'Answers emails to your business.'}
        body={
          c.email ? (
            catalogs.emailAddresses.length ? (
              <Select
                selectSize="sm"
                className="mt-1 w-[260px] max-w-full"
                aria-label="The address it emails from"
                value={c.emailAddressId ?? ''}
                data-testid="channel-email-address"
                onChange={(e) =>
                  patch(
                    { channels: { emailAddressId: e.target.value || null } },
                    'Change the email address',
                  )
                }
              >
                {!c.emailAddressId ? <option value="">Pick an address</option> : null}
                {c.emailAddressId && !addressKnown ? (
                  <option value={c.emailAddressId}>A removed address</option>
                ) : null}
                {catalogs.emailAddresses.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.address}
                  </option>
                ))}
              </Select>
            ) : (
              <Link href={`${base}/${TEAMMATE_LINKS.email}`} className={LINK}>
                Add an email address
              </Link>
            )
          ) : null
        }
      >
        <Switch
          checked={c.email}
          label="Email"
          testId="channel-email"
          onChange={(v) =>
            patch(
              {
                channels: {
                  email: v,
                  ...(v && !c.emailAddressId && address ? { emailAddressId: address.id } : {}),
                },
              },
              onOff(v, 'email'),
            )
          }
        />
      </SetRow>
      <SetRow
        center
        title="Website chat"
        description={
          c.chat ? 'It answers this chat on your website.' : 'Answers the chat on your website.'
        }
        body={
          c.chat ? (
            catalogs.chatWidgets.length ? (
              <Select
                selectSize="sm"
                className="mt-1 w-[260px] max-w-full"
                aria-label="The website chat it answers"
                value={c.widgetId ?? ''}
                data-testid="channel-chat-widget"
                onChange={(e) =>
                  patch({ channels: { widgetId: e.target.value || null } }, 'Change the chat')
                }
              >
                {!c.widgetId ? <option value="">Pick a website chat</option> : null}
                {c.widgetId && !widgetKnown ? (
                  <option value={c.widgetId}>A removed chat</option>
                ) : null}
                {catalogs.chatWidgets.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </Select>
            ) : (
              <Link href={`${base}/${TEAMMATE_LINKS.websiteChat}`} className={LINK}>
                Set up website chat
              </Link>
            )
          ) : null
        }
      >
        <Switch
          checked={c.chat}
          label="Website chat"
          testId="channel-chat"
          onChange={(v) =>
            patch(
              {
                channels: {
                  chat: v,
                  ...(v && !c.widgetId && widget ? { widgetId: widget.id } : {}),
                },
              },
              onOff(v, 'website chat'),
            )
          }
        />
      </SetRow>
      <SetRow
        center
        title="Phone calls"
        description={
          catalogs.textingReady ? (
            draft.phone.enabled ? (
              `${name} picks up your business number and talks with callers live.`
            ) : (
              'Answers calls to your business number, live.'
            )
          ) : (
            <>
              Your business number isn’t set up yet.{' '}
              <Link href={`${base}/${TEAMMATE_LINKS.texting}`} className={LINK}>
                Set it up
              </Link>
            </>
          )
        }
        body={draft.phone.enabled ? <PhoneSettings draft={draft} patch={patch} /> : null}
      >
        <Switch
          checked={draft.phone.enabled}
          label="Phone calls"
          testId="channel-phone"
          onChange={(v) => patch({ phone: { enabled: v } }, onOff(v, 'phone calls'))}
        />
      </SetRow>
      <Note className="mt-3" icon={Moon}>
        Quiet hours apply to texts only. Email, website chat and calls have none.
      </Note>
    </>
  );
}

const PHONE_ANSWER_WORDS: Readonly<Record<PhoneAnswerMode, string>> = {
  no_answer: 'When nobody picks up',
  after_hours: 'When you’re closed',
  always: 'Every call',
};

const PHONE_VOICE_WORDS: Readonly<Record<PhoneVoice, string>> = {
  warm: 'Warm',
  bright: 'Bright',
  calm: 'Calm',
  deep: 'Deep',
};

/** When it picks up, how it sounds, and what it says first (M18 step 5). */
function PhoneSettings({ draft, patch }: Pick<ModuleProps, 'draft' | 'patch'>) {
  const p = draft.phone;
  const name = draft.identity.name;
  return (
    <div className="mt-1.5 flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          selectSize="sm"
          className="w-[220px] max-w-full"
          aria-label="When it answers"
          value={p.answer}
          data-testid="phone-answer"
          onChange={(e) =>
            patch(
              { phone: { answer: e.target.value as PhoneAnswerMode } },
              'Change when it answers',
            )
          }
        >
          {PHONE_ANSWER_MODES.map((m) => (
            <option key={m} value={m}>
              {PHONE_ANSWER_WORDS[m]}
            </option>
          ))}
        </Select>
        <Select
          selectSize="sm"
          className="w-[140px] max-w-full"
          aria-label="Its voice"
          value={p.voice}
          data-testid="phone-voice"
          onChange={(e) =>
            patch({ phone: { voice: e.target.value as PhoneVoice } }, 'Change its voice')
          }
        >
          {PHONE_VOICES.map((v) => (
            <option key={v} value={v}>
              {PHONE_VOICE_WORDS[v]} voice
            </option>
          ))}
        </Select>
      </div>
      <DraftText
        id="teammate-phone-greeting"
        label="What it says when it picks up"
        value={p.greeting}
        maxLength={200}
        placeholder={
          draft.identity.disclosure === 'first_message'
            ? `Thanks for calling. This is ${name}, the AI assistant. How can I help?`
            : `Thanks for calling, this is ${name}. How can I help?`
        }
        hint={
          draft.identity.disclosure === 'first_message'
            ? 'It says it’s an AI assistant, as Identity says. Leave empty for the usual greeting.'
            : 'It says it’s an AI assistant when a caller asks. Leave empty for the usual greeting.'
        }
        testId="phone-greeting"
        onChange={(v) =>
          patch({ phone: { greeting: v } }, 'Change the greeting', {
            group: 'phone.greeting',
            quiet: true,
          })
        }
      />
      <span className="text-xs text-text-3">
        Same tools and rules as texts. Money still waits for your OK: callers hear the team will
        text the link. Asking for a person rings your team on the same call.
      </span>
    </div>
  );
}

// ---------- Respond ----------

function RespondModule({ draft, patch, catalogs }: ModuleProps) {
  const r = draft.respond;
  const wf = catalogs.newLeadTextWorkflows;
  return (
    <>
      <ModuleHeading
        title="Respond"
        description="Replies to leads who write in, and can send new leads the first message."
        skill={{
          on: r.enabled,
          onChange: (v) => patch({ respond: { enabled: v } }, onOff(v, 'Respond')),
          label: 'Respond',
          testId: 'skill-respond',
        }}
      />
      <SetRow
        first
        center
        title="Message new leads first"
        description="A text when they’ve agreed to texts or just texted you, otherwise an email."
      >
        <Switch
          checked={r.newLeads.enabled}
          label="Message new leads first"
          testId="respond-new-leads"
          onChange={(v) =>
            patch({ respond: { newLeads: { enabled: v } } }, onOff(v, 'first messages'))
          }
        />
      </SetRow>
      {r.newLeads.enabled ? (
        <>
          <SetRow center title="First message by">
            <Segmented
              value={r.newLeads.channel}
              ariaLabel="First message by"
              onChange={(v) =>
                patch({ respond: { newLeads: { channel: v } } }, 'Change how new leads hear first')
              }
              options={[
                { value: 'sms', label: 'Text', testId: 'respond-channel-sms' },
                { value: 'email', label: 'Email', testId: 'respond-channel-email' },
              ]}
            />
          </SetRow>
          <SetRow
            center
            title="Wait before the first message"
            description="Imported leads and booking-page leads never get one."
          >
            <Select
              selectSize="sm"
              className="w-[150px]"
              aria-label="Wait before the first message"
              value={String(r.newLeads.delayMinutes)}
              data-testid="respond-delay"
              onChange={(e) =>
                patch(
                  { respond: { newLeads: { delayMinutes: Number(e.target.value) } } },
                  'Change the wait',
                )
              }
            >
              {withCurrent(DELAYS, r.newLeads.delayMinutes).map((m) => (
                <option key={m} value={m}>
                  {m === 0 ? 'Right away' : formatDuration(m)}
                </option>
              ))}
            </Select>
          </SetRow>
        </>
      ) : null}
      {wf.length ? (
        <Note className="mt-3" icon={AlertTriangle}>
          {wf.length === 1
            ? `“${wf[0]!.name}” also texts new leads.`
            : `${wf.length} workflows also text new leads.`}{' '}
          Keep one of them, so leads don’t get two texts.
        </Note>
      ) : null}
    </>
  );
}

// ---------- Answer ----------

function AnswerModule({ draft, patch, catalogs, workspaceId }: ModuleProps) {
  const a = draft.answer;
  const n = catalogs.knowledge.published;
  return (
    <>
      <ModuleHeading
        title="Answer"
        description="Answers questions from your Knowledge. It never guesses."
        skill={{
          on: a.enabled,
          onChange: (v) => patch({ answer: { enabled: v } }, onOff(v, 'Answer')),
          label: 'Answer',
          testId: 'skill-answer',
        }}
      />
      <SetRow
        first
        center
        title="What it answers from"
        description={`${plural(n, 'published answer', 'published answers')} in Knowledge, and your business profile.`}
      >
        <Link href={`/app/w/${workspaceId}/knowledge`} className={LINK}>
          Open Knowledge
        </Link>
      </SetRow>
      <GroupLabel id="answer-unsure">When Knowledge doesn’t have the answer</GroupLabel>
      <div role="radiogroup" aria-labelledby="answer-unsure" className="flex flex-col gap-2">
        <Choice
          on={a.whenUnsure === 'hand_off'}
          onSelect={() => patch({ answer: { whenUnsure: 'hand_off' } }, 'Hand off when unsure')}
          title="Hand it to a person"
          description="The conversation goes to Needs a person, with a note of what they asked."
          testId="unsure-hand_off"
        />
        <Choice
          on={a.whenUnsure === 'take_message'}
          onSelect={() =>
            patch({ answer: { whenUnsure: 'take_message' } }, 'Take a message when unsure')
          }
          title="Take a message"
          description="It says someone will get back to them, and leaves your team a task."
          testId="unsure-take_message"
        />
      </div>
      <GroupLabel id="answer-photos">Photos customers send</GroupLabel>
      <SetRow
        first
        center
        title={`${draft.identity.name} looks at photos`}
        description="Says what they show in a note for your team, whether it looks like work you do, and asks for a better one when it can’t tell. Texts and emails; up to 3 photos a reply."
      >
        <Switch
          checked={draft.photos.enabled}
          label="Photos"
          testId="photos-enabled"
          onChange={(v) => patch({ photos: { enabled: v } }, onOff(v, 'Photos'))}
        />
      </SetRow>
      {draft.photos.enabled ? (
        <SetRow
          center
          title="Rough price ranges"
          description={
            catalogs.pricesAllowed
              ? 'It may say a rough range from what it sees, only from your price list and Knowledge (a “sizing guide” article helps). Always a range, never a quote.'
              : 'Turn on prices in your business profile first. Until then it never says a price.'
          }
        >
          <Switch
            checked={draft.photos.priceRanges}
            label="Price ranges from photos"
            testId="photos-price-ranges"
            onChange={(v) =>
              patch({ photos: { priceRanges: v } }, onOff(v, 'Price ranges from photos'))
            }
          />
        </SetRow>
      ) : null}
    </>
  );
}

// ---------- Book ----------

function BookModule({ draft, patch, catalogs, workspaceId }: ModuleProps) {
  const b = draft.book;
  const name = draft.identity.name;
  const base = `/app/w/${workspaceId}`;
  const shown = catalogs.calendars.filter((cal) => !cal.archived || b.calendarIds.includes(cal.id));
  const toggle = (id: string, on: boolean) =>
    patch(
      {
        book: {
          calendarIds: on ? [...b.calendarIds, id] : b.calendarIds.filter((x) => x !== id),
        },
      },
      on ? 'Add a calendar' : 'Remove a calendar',
    );
  return (
    <>
      <ModuleHeading
        title="Book"
        description={`${name} finds times, books the customer it’s talking to, and can move or cancel their visits. It follows each calendar’s rules and only offers times its booking page would show.`}
        skill={{
          on: b.enabled,
          onChange: (v) => patch({ book: { enabled: v } }, onOff(v, 'booking')),
          label: 'Book',
          testId: 'skill-book',
        }}
      />
      <GroupLabel className="mt-0">Calendars {name} books</GroupLabel>
      <div data-testid="book-calendars">
        {shown.map((cal) => {
          const on = b.calendarIds.includes(cal.id);
          const id = `book-cal-${cal.id}`;
          return (
            <div
              key={cal.id}
              className="flex items-start gap-3 border-t border-border py-[11px]"
              data-testid={`book-calendar-${cal.id}`}
            >
              <input
                id={id}
                type="checkbox"
                checked={on}
                onChange={(e) => toggle(cal.id, e.target.checked)}
                className="mt-px h-[18px] w-[18px] flex-none cursor-pointer rounded-[5px] border border-border-strong accent-accent"
              />
              <span
                aria-hidden
                className="mt-[5px] h-2.5 w-2.5 flex-none rounded-full"
                style={{ background: calendarColor(cal.color) }}
              />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <label htmlFor={id} className="flex min-w-0 cursor-pointer flex-col gap-0.5">
                  <span className="truncate text-[13px] font-semibold">{cal.name}</span>
                  {cal.lengths.length ? (
                    <span className="truncate text-xs text-text-3">
                      {lengthsWords(cal.lengths)}
                    </span>
                  ) : null}
                  {cal.description ? (
                    <span
                      className="line-clamp-2 text-xs text-text-2"
                      data-testid={`book-calendar-for-${cal.id}`}
                    >
                      {cal.description}
                    </span>
                  ) : null}
                </label>
                {/* It picks a calendar by what it's for: without a description it has only the name to go on. */}
                {on && !cal.description && !cal.archived ? (
                  <Link
                    href={`${base}/${TEAMMATE_LINKS.calendarDetails(cal.id)}`}
                    className="self-start text-xs font-medium text-accent-text hover:underline"
                    data-testid={`book-calendar-say-for-${cal.id}`}
                  >
                    Tell {name} what it’s for
                  </Link>
                ) : null}
              </span>
              {cal.archived ? (
                <Badge variant="danger" className="h-5 text-[11.5px]">
                  Archived
                </Badge>
              ) : cal.bookableOnline ? (
                <Badge variant="ok" className="h-5 text-[11.5px]">
                  <Globe className="h-3 w-3" strokeWidth={1.75} />
                  Books online
                </Badge>
              ) : (
                <span className="flex flex-none flex-col items-end gap-1">
                  <Badge variant="pending" className="h-5 text-[11.5px]">
                    <AlertTriangle className="h-3 w-3" strokeWidth={1.75} />
                    Can’t be booked online
                  </Badge>
                  <Link
                    href={`${base}/${TEAMMATE_LINKS.calendar(cal.id)}`}
                    className="text-xs font-medium text-accent-text hover:underline"
                  >
                    Let customers book it
                  </Link>
                </span>
              )}
            </div>
          );
        })}
        {!shown.length ? (
          <p className="border-t border-border py-3 text-[13px] text-text-2">
            No calendars yet.{' '}
            <Link href={`${base}/${TEAMMATE_LINKS.newCalendar}`} className={LINK}>
              Create a calendar
            </Link>
          </p>
        ) : null}
      </div>
      <SetRow
        center
        title={`Customers can reschedule through ${name}`}
        description="Within each calendar’s rules, like up to 24 hours before."
      >
        <Switch
          checked={b.reschedule}
          label="Reschedule"
          testId="book-reschedule"
          onChange={(v) => patch({ book: { reschedule: v } }, onOff(v, 'rescheduling'))}
        />
      </SetRow>
      <SetRow
        center
        title={`Customers can cancel through ${name}`}
        description="Same rules. The calendar’s own messages go out as usual."
      >
        <Switch
          checked={b.cancel}
          label="Cancel"
          testId="book-cancel"
          onChange={(v) => patch({ book: { cancel: v } }, onOff(v, 'cancelling'))}
        />
      </SetRow>
      <SetRow
        center
        title={`${name} can add customers to a waitlist`}
        description="When nothing open suits them, on calendars that keep a waitlist. They hear when a spot opens."
      >
        <Switch
          checked={b.waitlist}
          label="Waitlist"
          testId="book-waitlist"
          onChange={(v) => patch({ book: { waitlist: v } }, onOff(v, 'the waitlist'))}
        />
      </SetRow>
      <SetRow
        center
        title={`${name} can book repeat visits`}
        description="Weekly or monthly, on calendars that let customers repeat a visit."
      >
        <Switch
          checked={b.repeats}
          label="Repeat visits"
          testId="book-repeats"
          onChange={(v) => patch({ book: { repeats: v } }, onOff(v, 'repeat visits'))}
        />
      </SetRow>
      <SetRow
        center
        title={`${name} checks your service area`}
        description="Asks for the ZIP code and checks it against your areas before offering times."
      >
        <Switch
          checked={b.serviceArea}
          label="Service area"
          testId="book-service-area"
          onChange={(v) => patch({ book: { serviceArea: v } }, onOff(v, 'the service area check'))}
        />
      </SetRow>
      <Callout className="mt-3">
        In the website chat, {name} never changes a visit that’s already booked. It sends a link to
        the phone or email on file, because anyone can type a name into a chat.
      </Callout>
      <Note className="mt-3" icon={ShieldCheck}>
        With training wheels, a booking waits in the draft. Approving checks the time again first.
        If it was taken, you pick another.
      </Note>
    </>
  );
}

// ---------- Follow up ----------

function FollowUpModule({ draft, patch, workspaceId, flush }: ModuleProps) {
  const f = draft.followUp;
  const router = useRouter();
  // Straight to its Adjust sheet on Automations, once a change made here has saved.
  const schedule = `/app/w/${workspaceId}/settings/automations?adjust=follow_ups_after_silence`;
  const openSchedule = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    void flush().then(() => router.push(schedule));
  };
  return (
    <>
      <ModuleHeading
        title="Follow up"
        description="Nudges a customer who stops replying, on a schedule."
        skill={{
          on: f.enabled,
          onChange: (v) => patch({ followUp: { enabled: v } }, onOff(v, 'Follow up')),
          label: 'Follow up',
          testId: 'skill-followUp',
        }}
      />
      <SetRow
        first
        center
        title="Then once a month for"
        description={`After ${followUpLadderWords(f.ladder)}. Change the schedule in Settings, Automations.`}
      >
        <Stepper
          value={f.monthlyForMonths}
          min={0}
          max={12}
          label="Then once a month for this many months"
          testId="followup-monthly-months"
          onChange={(v) =>
            patch({ followUp: { monthlyForMonths: v } }, 'Change the monthly follow-ups', {
              group: 'followUp.monthly',
            })
          }
        />
      </SetRow>
      <Note className="mt-3" icon={Moon}>
        Follow-ups set for more than {QUIET_FOLLOW_UP_MINUTES} minutes wait until quiet hours end,
        then go at a random time early that morning. They stop once they reply, book, or text STOP.
        The schedule is in{' '}
        <Link
          href={schedule}
          onClick={openSchedule}
          className="underline"
          data-testid="followup-schedule-link"
        >
          Settings, Automations
        </Link>
        .
      </Note>
    </>
  );
}

// ---------- Hours ----------

function HoursModule({ draft, patch, catalogs }: ModuleProps) {
  const h = draft.hours;
  const name = draft.identity.name;
  const q = catalogs.quietHours;
  const open = catalogs.businessHours;
  return (
    <>
      <ModuleHeading
        title="Hours"
        description={`When ${name} answers. Outside its hours, messages wait for the team, and the website chat shows your away message.`}
      />
      <div role="radiogroup" aria-label={`When ${name} answers`} className="flex flex-col gap-2">
        <Choice
          on={h.mode === 'always'}
          onSelect={() => patch({ hours: { mode: 'always' } }, 'Work all the time')}
          title="Always"
          description="Day and night, every day. Emergencies always get safety steps, whatever the hours."
          testId="hours-always"
        />
        <Choice
          on={h.mode === 'after_hours'}
          onSelect={() => patch({ hours: { mode: 'after_hours' } }, 'Work after hours')}
          title="After hours only"
          description={afterHoursWords(open)}
          testId="hours-after_hours"
        />
        <Choice
          on={h.mode === 'custom'}
          onSelect={() => patch({ hours: { mode: 'custom' } }, 'Set its own hours')}
          title="Custom"
          description="Pick the days and times."
          testId="hours-custom"
        />
      </div>
      {h.mode === 'custom' ? (
        <div className="mt-3 rounded-menu border border-border px-3 py-1">
          <WeeklyHoursEditor
            value={h.custom}
            idPrefix="teammate-hours"
            onChange={(next) => patch({ hours: { custom: next } }, 'Change its hours')}
          />
        </div>
      ) : null}
      {draft.channels.sms && q.enabled ? (
        <div className="mt-4 flex items-start gap-2.5 rounded-menu bg-warning-soft px-3 py-2.5 text-[13px] leading-[1.45] text-warning-text">
          <Moon className="mt-0.5 h-4 w-4 flex-none" strokeWidth={1.75} />
          <span>
            <strong className="font-semibold">
              Quiet hours, {formatClock(q.start)} to {formatClock(q.end)}.
            </strong>{' '}
            {name} can reply to a customer’s own text that arrived in the last 15 minutes, up to 3
            replies a night. Texts it starts itself wait until {formatClock(q.end)}. Chat and email
            have no quiet hours.
          </span>
        </div>
      ) : null}
      <p className="mt-3 flex items-start gap-2 text-xs text-text-3">
        <Clock className="mt-px h-3.5 w-3.5 flex-none" strokeWidth={1.5} />
        <span>
          {open?.length
            ? `Your open hours are ${formatHours(open)} (Settings, Workspace).`
            : 'Your open hours aren’t set yet (Settings, Workspace).'}{' '}
          Hand-offs use them to tell customers when someone will reply.
        </span>
      </p>
    </>
  );
}

// ---------- Autonomy ----------

function AutonomyModule({ draft, patch, progress }: ModuleProps) {
  const a = draft.autonomy;
  const name = draft.identity.name;
  const view = progressView(progress, a.approvalsNeeded);
  return (
    <>
      <ModuleHeading
        title="Autonomy"
        description="How long the training wheels stay on, and what waits for an OK."
      />
      <SetRow
        first
        center
        title={`Approvals before ${name} works on its own`}
        description={`Any number from ${APPROVALS_NEEDED_MIN} to ${APPROVALS_NEEDED_MAX}.`}
      >
        <Stepper
          value={a.approvalsNeeded}
          min={APPROVALS_NEEDED_MIN}
          max={APPROVALS_NEEDED_MAX}
          label="Approvals needed"
          testId="autonomy-approvals"
          onChange={(v) =>
            patch({ autonomy: { approvalsNeeded: v } }, 'Change the approvals needed', {
              group: 'autonomy.approvals',
            })
          }
        />
      </SetRow>
      <div className="pb-3.5 pt-1">
        <ProgressBlock progress={view} name={name} showRejected />
        <p className="mt-1.5 text-xs text-text-3">
          Edited approvals count too. Restoring an old version never changes these numbers.
        </p>
      </div>
      <SetRow
        center
        title="Drafts expire after"
        description="Then the conversation goes to a person, so no customer waits forever."
      >
        <Select
          selectSize="sm"
          className="w-[140px]"
          aria-label="Drafts expire after"
          value={String(a.draftExpiresMinutes)}
          data-testid="autonomy-expiry"
          onChange={(e) =>
            patch(
              { autonomy: { draftExpiresMinutes: Number(e.target.value) } },
              'Change when drafts expire',
            )
          }
        >
          {withCurrent(EXPIRY, a.draftExpiresMinutes).map((m) => (
            <option key={m} value={m}>
              {formatDuration(m)}
            </option>
          ))}
        </Select>
      </SetRow>
      <GroupLabel>What waits for an OK</GroupLabel>
      <div className="flex flex-col gap-2 text-[13px] leading-[1.45]">
        <div className="flex items-start gap-2.5">
          <span className="inline-flex h-5 w-5 flex-none items-center justify-center rounded-full bg-warning-soft text-warning-text">
            <Hourglass className="h-3 w-3" strokeWidth={2.2} />
          </span>
          <span>
            <strong className="font-semibold">Anything the customer sees</strong> becomes one draft:
            the reply, plus any booking, reschedule or cancellation that goes with it.
          </span>
        </div>
        <div className="flex items-start gap-2.5">
          <span className="inline-flex h-5 w-5 flex-none items-center justify-center rounded-full bg-success-soft text-success-text">
            <Check className="h-3 w-3" strokeWidth={2.2} />
          </span>
          <span>
            <strong className="font-semibold">Work inside HandsFreeOS</strong> happens right away:
            notes, tasks, qualifying answers and stage moves.
          </span>
        </div>
      </div>
      <Note className="mt-4" icon={Zap}>
        “Switch to automatic now” works at any time, from the status card. “Back to training” starts
        the count again at 0.
      </Note>
    </>
  );
}

// ---------- Limits (and money, as on the canvas) ----------

function LimitsModule({ draft, patch, workspaceId, catalogs }: ModuleProps) {
  const l = draft.limits;
  const m = draft.money;
  const name = draft.identity.name;
  const usage = catalogs.aiUsage;
  const usedWidth = usage.dailyTokens
    ? Math.min(100, (usage.teammateTokens / usage.dailyTokens) * 100)
    : 0;
  const prices = catalogs.pricesAllowed;
  return (
    <>
      <ModuleHeading
        title="Limits"
        description="So a chatty stranger, or another bot, can’t use up your AI allowance."
      />
      <SetRow
        first
        center
        title="Replies to one customer a day"
        description="After that, the conversation goes to a person."
      >
        <Stepper
          value={l.repliesPerConversationPerDay}
          min={1}
          max={50}
          label="Replies to one customer a day"
          testId="limits-replies"
          onChange={(v) =>
            patch({ limits: { repliesPerConversationPerDay: v } }, 'Change the daily replies', {
              group: 'limits.replies',
            })
          }
        />
      </SetRow>
      <SetRow
        center
        title="Look-ups per reply"
        description="Knowledge searches, times, bookings and notes."
      >
        <Stepper
          value={l.toolRounds}
          min={1}
          max={12}
          label="Look-ups per reply"
          testId="limits-lookups"
          onChange={(v) =>
            patch({ limits: { toolRounds: v } }, 'Change the look-ups', { group: 'limits.tools' })
          }
        />
      </SetRow>
      <div className="flex flex-col gap-1.5 border-t border-border py-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[13px] font-medium">{name}’s share of the daily AI limit</span>
          <Segmented
            value={String(l.dailySharePercent)}
            ariaLabel={`${name}’s share of the daily AI limit`}
            onChange={(v) =>
              patch({ limits: { dailySharePercent: Number(v) } }, 'Change its share of AI')
            }
            options={withCurrent(SHARES, l.dailySharePercent).map((s) => ({
              value: String(s),
              label: `${s}%`,
              testId: `limits-share-${s}`,
            }))}
          />
        </div>
        <span className="text-xs text-text-3">
          Keeps room for the Assistant and your workflows. When its share runs out, new messages go
          to a person until midnight.
        </span>
        <div className="relative h-2 overflow-hidden rounded-full bg-card-3" aria-hidden>
          <span
            className={cn('absolute inset-y-0 left-0 rounded-full opacity-35', AI_FILL)}
            style={{ width: `${l.dailySharePercent}%` }}
          />
          <span
            className={cn('absolute inset-y-0 left-0 rounded-full', AI_FILL)}
            style={{ width: `${usedWidth}%` }}
          />
        </div>
        <div className="flex flex-wrap justify-between gap-x-2 text-xs text-text-3">
          <span data-testid="limits-usage">
            Today so far: {name} {percentOfLimit(usage.teammateTokens, usage.dailyTokens)} of the
            limit
          </span>
          <span>Its share ends at {l.dailySharePercent}%</span>
        </div>
      </div>
      <GroupLabel className="mt-2" id="limits-discounts">
        Discounts
      </GroupLabel>
      <div role="radiogroup" aria-labelledby="limits-discounts" className="flex flex-col gap-2">
        <Choice
          on={m.discounts === 'never'}
          onSelect={() => patch({ money: { discounts: 'never' } }, 'Never offer discounts')}
          title="Never"
          description={`${name} says it can’t offer one and hands it to a person if they push.`}
          testId="discounts-never"
        />
        <Choice
          on={m.discounts === 'with_approval'}
          onSelect={() =>
            patch({ money: { discounts: 'with_approval' } }, 'Offer discounts with your OK')
          }
          title={`With your OK, up to ${m.maxPercent}%`}
          description="Any offer becomes a draft for an owner or admin, even after training wheels."
          testId="discounts-with_approval"
        />
      </div>
      {m.discounts === 'with_approval' ? (
        <SetRow center title="Largest discount it can offer">
          <Select
            selectSize="sm"
            className="w-[110px]"
            aria-label="Largest discount it can offer"
            value={String(m.maxPercent)}
            data-testid="discounts-max"
            onChange={(e) =>
              patch(
                { money: { maxPercent: Number(e.target.value) } },
                'Change the largest discount',
              )
            }
          >
            {withCurrent(DISCOUNTS, m.maxPercent).map((p) => (
              <option key={p} value={p}>
                {p}%
              </option>
            ))}
          </Select>
        </SetRow>
      ) : null}
      <GroupLabel className="mt-4">Bills, quotes and plans</GroupLabel>
      <Note icon={ShieldCheck}>
        Anything that asks a customer for money waits for an owner or admin to OK it, even after
        training wheels. Until then {name} tells them the team is getting it ready.
      </Note>
      <SetRow
        center
        title="Bills and payments"
        description={`${name} tells customers what they owe and what they’ve paid, and can resend a bill’s pay link.`}
      >
        <Switch
          checked={m.bills}
          label="Bills and payments"
          testId="money-bills"
          onChange={(v) => patch({ money: { bills: v } }, onOff(v, 'bills and payments'))}
        />
      </SetRow>
      <SetRow
        center
        title="New bills"
        description="Puts a bill together from your price list, and sends it once you OK it."
      >
        <Switch
          checked={m.newBills}
          label="New bills"
          testId="money-new-bills"
          onChange={(v) => patch({ money: { newBills: v } }, onOff(v, 'new bills'))}
        />
      </SetRow>
      <GroupLabel className="mt-2" id="money-quotes">
        Quotes
      </GroupLabel>
      <div role="radiogroup" aria-labelledby="money-quotes" className="flex flex-col gap-2">
        <Choice
          on={m.quotes === 'off'}
          onSelect={() => patch({ money: { quotes: 'off' } }, 'Turn off quotes')}
          title="Off"
          description={`${name} says someone from the team will send a quote.`}
          testId="quotes-off"
        />
        <Choice
          on={m.quotes === 'send_only'}
          onSelect={() => patch({ money: { quotes: 'send_only' } }, 'Send the team’s quotes')}
          title="Send quotes the team made"
          description="Tells customers where their quote stands, resends it, and records their yes or no."
          testId="quotes-send_only"
        />
        <Choice
          on={m.quotes === 'build'}
          onSelect={() => patch({ money: { quotes: 'build' } }, 'Build quotes from the price list')}
          title="Also build quotes from your price list"
          description="Puts a quote together from your price list for you to check and send."
          testId="quotes-build"
        />
      </div>
      <SetRow
        center
        title="Maintenance plans"
        description={`${name} tells customers about your plans and signs them up once you OK it.`}
      >
        <Switch
          checked={m.plans}
          label="Maintenance plans"
          testId="money-plans"
          onChange={(v) => patch({ money: { plans: v } }, onOff(v, 'maintenance plans'))}
        />
      </SetRow>
      <SetRow
        center
        title="Quoting prices"
        description={
          <>
            {prices ? 'On' : 'Off'} for all AI. Change it in{' '}
            <Link
              href={`/app/w/${workspaceId}/${TEAMMATE_LINKS.profile}`}
              className="font-medium text-accent-text hover:underline"
            >
              Knowledge
            </Link>
            .
          </>
        }
      >
        <Badge
          variant={prices ? 'ok' : 'gray'}
          className="h-5 text-[11.5px]"
          data-testid="limits-prices"
        >
          {prices ? 'On' : 'Off'}
        </Badge>
      </SetRow>
      <SetRow center title="Refunds" description="Always go straight to a person.">
        <Locked />
      </SetRow>
      <SetRow
        center
        title="Bots and auto-replies"
        description={`${name} never answers automatic emails, and stops if it seems to be talking to another bot.`}
      >
        <Locked />
      </SetRow>
    </>
  );
}

// ---------- Hand-off ----------

function Filled({ label, text, fill }: { label: string; text: string; fill: string }) {
  const parts = text.split(EXPECTATION_SLOT);
  return (
    <div className="flex gap-2">
      <span className="w-[108px] flex-none text-text-3">{label}</span>
      <span className="min-w-0 [overflow-wrap:anywhere]">
        “
        {parts.map((p, i) => (
          <Fragment key={i}>
            {p}
            {i < parts.length - 1 ? <strong className="font-semibold">{fill}</strong> : null}
          </Fragment>
        ))}
        ”
      </span>
    </div>
  );
}

function HandOffModule({ draft, patch, catalogs }: ModuleProps) {
  const h = draft.handOff;
  const name = draft.identity.name;
  const who = h.notify;
  const users =
    who.kind === 'users' ? who.userIds.filter((u): u is string => typeof u === 'string') : [];
  const others = catalogs.members.filter((m) => m.active && !users.includes(m.userId));
  const setWho = (next: NotifyWho, label: string) => patch({ handOff: { notify: next } }, label);
  const topics = h.sensitiveTopics;
  const told = capital(notifyWords(who, catalogs.members));
  const one =
    (who.kind === 'users' && users.length === 1) ||
    who.kind === 'lead_assignee' ||
    who.kind === 'person_owner';
  const canAdd = who.kind !== 'admins' || others.length > 0;
  return (
    <>
      <ModuleHeading
        title="Hand-off"
        description={`When ${name} passes a conversation to a person. It lands in the inbox under Needs a person, with its note.`}
      />
      <GroupLabel className="mt-0">{name} hands off when</GroupLabel>
      <SetRow
        first
        center
        title="The customer asks for a person"
        description="Any way of asking, like “can I talk to someone”."
      >
        <Locked />
      </SetRow>
      <SetRow
        center
        title="They sound frustrated"
        description="Angry words, repeated complaints, or ALL CAPS."
      >
        <Switch
          checked={h.onFrustration}
          label="Hand off when they sound frustrated"
          testId="handoff-frustration"
          onChange={(v) =>
            patch({ handOff: { onFrustration: v } }, onOff(v, 'hand-offs when frustrated'))
          }
        />
      </SetRow>
      <SetRow
        center
        title="It can’t answer from your Knowledge"
        description={
          draft.answer.whenUnsure === 'hand_off'
            ? 'Set in Answer. It never guesses.'
            : 'Set in Answer: it takes a message instead.'
        }
      >
        <Locked>In Answer</Locked>
      </SetRow>
      <SetRow
        center
        title="A limit is reached, or something goes wrong"
        description="The team gets the note. The customer isn’t told why."
      >
        <Locked />
      </SetRow>

      <GroupLabel>Sensitive topics: straight to a person</GroupLabel>
      <div className="flex flex-wrap gap-1.5" data-testid="handoff-topics">
        {BUILT_IN_TOPICS.map((t) => (
          <Chip key={t} size="md" locked title="Always handed to a person">
            {t}
          </Chip>
        ))}
        {topics.map((t) => (
          <Chip
            key={t}
            size="md"
            removeLabel={`Remove the topic ${t}`}
            onRemove={() =>
              patch(
                { handOff: { sensitiveTopics: topics.filter((x) => x !== t) } },
                'Remove a topic',
              )
            }
          >
            {t}
          </Chip>
        ))}
        {topics.length < 20 ? (
          <AddChip
            size="md"
            label="Add a topic"
            placeholder="Insurance claims"
            maxLength={60}
            testId="handoff-add-topic"
            onAdd={(v) =>
              patch({ handOff: { sensitiveTopics: [...topics, v] } }, 'Add a topic') === null
            }
          />
        ) : null}
      </div>
      <Callout tone="danger" icon={Siren} className="mt-3">
        <strong className="font-semibold">Emergencies</strong> such as a gas smell, smoke or sparks
        get fixed safety steps right away: leave the house, then call 911 or the gas company. {told}{' '}
        {one ? 'gets' : 'get'} an urgent alert. This can’t be turned off.
      </Callout>

      <GroupLabel>Who gets told</GroupLabel>
      <p className="mb-2 text-[13px] leading-[1.5]">
        The person the lead or customer is assigned to. If nobody is:
      </p>
      <div className="flex flex-wrap items-center gap-1.5" data-testid="handoff-notify">
        {who.kind === 'users' ? (
          users.map((u) => {
            const nm = catalogs.members.find((x) => x.userId === u)?.name ?? 'A former teammate';
            return (
              <Chip
                key={u}
                size="md"
                avatar={
                  <Avatar name={nm} seed={u} size="sm" className="-ml-1 h-5 w-5 text-[9px]" />
                }
                removeLabel={`Stop telling ${nm}`}
                onRemove={
                  users.length > 1
                    ? () =>
                        setWho(
                          { kind: 'users', userIds: users.filter((x) => x !== u) },
                          'Tell fewer people',
                        )
                    : undefined
                }
              >
                {nm}
              </Chip>
            );
          })
        ) : (
          <Chip size="md">{told}</Chip>
        )}
        {canAdd ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                data-testid="handoff-notify-add"
                className="inline-flex h-[30px] items-center gap-1 rounded-full border border-dashed border-border-strong px-2.5 text-[13px] text-text-2 hover:bg-card-2 hover:text-text focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
              >
                <Plus className="h-3 w-3" strokeWidth={2} />
                Add
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {who.kind !== 'admins' ? (
                <DropdownMenuItem
                  onSelect={() => setWho({ kind: 'admins' }, 'Tell owners and admins')}
                >
                  Owners and admins
                </DropdownMenuItem>
              ) : null}
              {who.kind !== 'admins' && others.length ? <DropdownMenuSeparator /> : null}
              {others.map((m) => (
                <DropdownMenuItem
                  key={m.userId}
                  onSelect={() =>
                    setWho({ kind: 'users', userIds: [...users, m.userId] }, `Tell ${m.name}`)
                  }
                >
                  {m.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      <GroupLabel id="handoff-alerts">How they hear</GroupLabel>
      <SetRow
        first
        center
        title="Phone app alert"
        description="On the HandsFreeOS app, for everyone who has it."
      >
        <Switch
          checked={h.alerts.push}
          label="Phone app alert"
          testId="handoff-alert-push"
          onChange={(v) =>
            patch({ handOff: { alerts: { push: v } } }, onOff(v, 'hand-off phone alerts'))
          }
        />
      </SetRow>
      <SetRow
        center
        title="Text to their cell"
        description="From your business number, to the cell each person confirmed in their settings."
      >
        <Switch
          checked={h.alerts.text}
          label="Text to their cell"
          testId="handoff-alert-text"
          onChange={(v) => patch({ handOff: { alerts: { text: v } } }, onOff(v, 'hand-off texts'))}
        />
      </SetRow>
      <SetRow center title="Email">
        <Switch
          checked={h.alerts.email}
          label="Email"
          testId="handoff-alert-email"
          onChange={(v) =>
            patch({ handOff: { alerts: { email: v } } }, onOff(v, 'hand-off emails'))
          }
        />
      </SetRow>
      <p className="mt-2 text-xs text-text-3">
        If nobody replies in 15 minutes during open hours, the usual “customer is waiting” reminder
        goes out too. Emergencies always email everyone.
      </p>

      <DraftText
        id="teammate-handoff-line"
        className="mt-5"
        label={`What ${name} tells the customer`}
        multiline
        rows={3}
        maxLength={300}
        value={h.tellCustomer}
        hint={`Put ${EXPECTATION_SLOT} where the wait goes. It becomes when they’ll hear back.`}
        testId="handoff-line"
        onChange={(v) =>
          patch({ handOff: { tellCustomer: v } }, 'Change the hand-off message', {
            group: 'handOff.tellCustomer',
            quiet: true,
          })
        }
      />
      <div className="mt-2.5 flex flex-col gap-1 text-[12.5px]" data-testid="handoff-preview">
        <Filled label="In open hours" text={h.tellCustomer} fill={EXPECTATION_EXAMPLES.open} />
        <Filled label="Other times" text={h.tellCustomer} fill={EXPECTATION_EXAMPLES.closed} />
      </div>
    </>
  );
}

// ---------- The form ----------

function ModuleBody(props: ModuleProps & { module: ModuleKey }) {
  switch (props.module) {
    case 'identity':
      return <IdentityModule {...props} />;
    case 'channels':
      return <ChannelsModule {...props} />;
    case 'respond':
      return <RespondModule {...props} />;
    case 'answer':
      return <AnswerModule {...props} />;
    case 'qualify':
      return <QualifyModule {...props} />;
    case 'book':
      return <BookModule {...props} />;
    case 'followUp':
      return <FollowUpModule {...props} />;
    case 'hours':
      return <HoursModule {...props} />;
    case 'autonomy':
      return <AutonomyModule {...props} />;
    case 'limits':
      return <LimitsModule {...props} />;
    case 'handOff':
      return <HandOffModule {...props} />;
  }
}

/** One module's settings. Members see them; the fieldset keeps every control read-only for them. */
export function ModuleForm(props: ModuleProps & { module: ModuleKey }) {
  return (
    <fieldset
      disabled={props.readOnly}
      className="min-w-0"
      data-testid={`module-form-${props.module}`}
    >
      <ModuleBody {...props} />
    </fieldset>
  );
}
