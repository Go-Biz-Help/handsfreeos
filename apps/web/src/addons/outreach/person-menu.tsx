'use client';
/**
 * The person panel on someone's name (docs/outreach.md, decisions 43, 91 and 128): wherever the web shows someone kept
 * in Social Outreach (Needs you, Today, People's lists), their name is a button that opens a panel with everything
 * about them: the menu's actions at its top, then why they fit, the next step, the chat so far as the AI read it, the
 * groups they were found in, and every step either way (`outreach.profile.marks`' journey). Pressing an action closes
 * it, as a menu does, so the list behind shows what changed. Its actions, their order, what shows and what can be
 * pressed come from core (`personMenuItems`), the same as on the phone:
 *
 * - **Open on {Network}**, their page there, first, and **Open in {messages}** where their chat is known: links out,
 *   in a new tab;
 * - the Pipeline's moves, on its rows;
 * - **In Contacts**, or **Add to Contacts**, which looks for customers with the same name first (./same-name.tsx), so
 *   the person says "It's them" rather than making a second;
 * - **Mark as client** (`outreach.client.set`), through the same "Is this one of these?" when they aren't in
 *   Contacts, or **Not a client after all**, or why Contacts counts them a client;
 * - **Demo booked**, or **Not a demo after all**;
 * - **Potential partner** (`outreach.partner.potential`, decision 130), onto the person's Partners list with partner
 *   messages, under why the AI thinks so when it does, or **Not a partner after all**;
 * - **Later**, off the person's own Today for 2 weeks, or **Take off Later** (`outreach.later.set`, decision 100);
 * - who reached them first, and for an owner or admin **Give them to {teammate}** (`outreach.owner.move`, decision
 *   107);
 * - **Don't pitch** and **Never contact**, or taking them off, or who put them on: left out where the row has its own
 *   switches (Friends, Chats).
 *
 * Opening it asks where they stand now (`outreach.profile.marks`); its actions and story wait for the answer. Add to Contacts and
 * Client need Add and edit customers (`records.write`), so they're left out for whoever can't.
 *
 * What each action does (core's `hint`, decision 91) shows beside it once the pointer rests there for `HINT_DELAY_MS`,
 * or the keyboard lands on it.
 */
import { journeyStepWords, type Journey } from '@hfos/core/addons/outreach/journey';
import { leadWords } from '@hfos/core/addons/outreach/leads';
import { PLATFORMS, type Platform } from '@hfos/core/addons/outreach/networks';
import {
  clientSetWords,
  HINT_DELAY_MS,
  laterSetWords,
  personMenuItems,
  personMenuOfflineWords,
  type PersonMenuItem,
  type PersonMenuKey,
  type ProfileMarksOutput,
} from '@hfos/core/addons/outreach/person-menu';
import { OWNER_WORDS } from '@hfos/core/addons/outreach/owners';
import { STAGES } from '@hfos/core/addons/outreach/stages';
import { OUTREACH_WORDS } from '@hfos/core/addons/outreach/words';
import {
  BadgeCheck,
  Ban,
  CalendarCheck,
  ChevronRight,
  Handshake,
  Clock,
  ExternalLink,
  Loader2,
  MessageCircle,
  UserPlus,
  UserRound,
  Users,
  UserX,
  WifiOff,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useCallback, useRef, useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { useCan } from '@/components/shell/workspace-shell';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet';
import { Tooltip, TooltipProvider } from '@/components/ui/tooltip';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { cn, relativeTime } from '@/lib/utils';
import { outreachHref } from './address';
import { SameNameDialog, sameNamesFor, type SameName } from './same-name';
import { useAct } from './use-act';

const P = OUTREACH_WORDS.person;

/** Who the menu is for, as the row knows them. A list that doesn't know a field leaves it out. */
export interface MenuPerson {
  /** Kept as a profile: with none, the name is plain words and there's no menu. */
  readonly profileId: string | null;
  readonly name: string;
  /** The network they're on: the Open items' words. */
  readonly platform: Platform;
  /** Their page there: Open on {Network}. Left out or null where the row has none; the marks bring it. */
  readonly url?: string | null;
  /** Their chat, where the row knows it: Open in {messages}. */
  readonly threadKey?: string | null;
  /** The customer they're saved to; left out where the list doesn't know. */
  readonly personId?: string | null;
  /** They booked a demo (`outreach.demo.mark`); left out where the list doesn't know. */
  readonly demoBooked?: boolean;
}

/** A move to another stage, on the Pipeline: Ready to pitch, Pitched, Not a fit, Back in play. */
export interface MenuMove {
  readonly key: string;
  readonly label: string;
  readonly onSelect: () => void;
  readonly danger?: boolean;
}

const ICONS: Partial<Record<PersonMenuKey, LucideIcon>> = {
  'open-page': ExternalLink,
  'open-chat': MessageCircle,
  'in-contacts': UserRound,
  'add-contact': UserPlus,
  'mark-client': BadgeCheck,
  'not-client': BadgeCheck,
  'client-line': BadgeCheck,
  demo: CalendarCheck,
  'not-demo': CalendarCheck,
  'potential-partner': Handshake,
  'not-partner': Handshake,
  'partner-hint': Handshake,
  later: Clock,
  'not-later': Clock,
  'dont-pitch': Ban,
  'not-dont-pitch': Ban,
  'dont-pitch-line': Ban,
  'never-contact': UserX,
  'not-never-contact': UserX,
  'never-contact-line': UserX,
};

/** An action in the panel: a row to press, as the menu's were. */
const ACTION =
  'flex w-full items-center gap-2.5 rounded-control px-2.5 py-2 text-left text-[14px] transition-colors hover:bg-card-2 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50';

/** The browser's word on signal: true on the server and until it says otherwise. */
const onSignalChange = (changed: () => void) => {
  window.addEventListener('online', changed);
  window.addEventListener('offline', changed);
  return () => {
    window.removeEventListener('online', changed);
    window.removeEventListener('offline', changed);
  };
};
const useOnline = (): boolean =>
  useSyncExternalStore(
    onSignalChange,
    () => navigator.onLine,
    () => true,
  );

/**
 * Someone's name, as a button that opens their person panel. With no profile kept it's the name alone. `className`
 * keeps the row's own look for the name; `truncate` cuts a long one short on a narrow card.
 */
export function PersonName({
  workspaceId,
  who,
  moves = [],
  ownSwitches = false,
  disabled = false,
  className,
  truncate = false,
}: {
  workspaceId: string;
  who: MenuPerson;
  /** Stages to move them to, on the Pipeline's rows and board cards. */
  moves?: readonly MenuMove[];
  /** The row has its own Don't pitch and Never contact switches: the menu leaves them out. */
  ownSwitches?: boolean;
  /** Something on the row is running: the menu's actions wait (its Open items don't). */
  disabled?: boolean;
  className?: string;
  truncate?: boolean;
}) {
  if (!who.profileId)
    return <span className={cn(truncate && 'min-w-0 truncate', className)}>{who.name}</span>;
  return (
    <NameMenu
      workspaceId={workspaceId}
      profileId={who.profileId}
      who={who}
      moves={moves}
      ownSwitches={ownSwitches}
      disabled={disabled}
      className={className}
      truncate={truncate}
    />
  );
}

/** What "Is this one of these?" leads to: Add to Contacts, or Mark as client. */
type SameFor = 'contact' | 'client';

function NameMenu({
  workspaceId,
  profileId,
  who,
  moves,
  ownSwitches,
  disabled,
  className,
  truncate,
}: {
  workspaceId: string;
  profileId: string;
  who: MenuPerson;
  moves: readonly MenuMove[];
  ownSwitches: boolean;
  disabled: boolean;
  className: string | undefined;
  truncate: boolean;
}) {
  const contactsWrite = useCan('records.write');
  const online = useOnline();
  const [marks, setMarks] = useState<ProfileMarksOutput | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [same, setSame] = useState<{ people: readonly SameName[]; for: SameFor } | null>(null);
  const [open, setOpen] = useState(false);
  // Only the latest ask's answer is shown: the menu opened again, or an action, asks afresh.
  const asked = useRef(0);
  const load = useCallback(async () => {
    const ask = ++asked.current;
    setFailed(null);
    try {
      const got = unwrap(
        await apiBrowser().POST('/v1/queries/outreach.profile.marks', {
          body: { workspaceId, profileId },
        }),
      );
      if (ask === asked.current) setMarks(got);
    } catch (e) {
      if (ask === asked.current) setFailed(errorMessage(e));
    }
  }, [workspaceId, profileId]);
  const reload = useCallback(() => void load(), [load]);
  const { busy, act } = useAct(reload);
  const name = who.name;

  const items = personMenuItems({
    row: {
      url: who.url ?? null,
      platform: who.platform,
      threadKey: who.threadKey ?? null,
      personId: who.personId,
      demoBooked: who.demoBooked,
    },
    marks,
    moves: moves.map((m) => ({ key: m.key, label: m.label, danger: m.danger })),
    contactsWrite,
    online,
    ownSwitches,
  });

  const contact = (personId: string | null) =>
    act(
      'contact',
      async () => {
        const saved = unwrap(
          await apiBrowser().POST('/v1/commands/outreach.profile.contact', {
            body: { workspaceId, profileId, personId },
          }),
        );
        setSame(null);
        return saved;
      },
      personId ? P.tied(name) : P.added(name),
    );
  // Customers with the same name, not saved with a profile on a network yet: the person says whether it's them.
  const sameFirst = async (then: SameFor): Promise<boolean> => {
    const people = await sameNamesFor(workspaceId, name, { withoutProfile: true });
    if (!people.length) return false;
    setSame({ people, for: then });
    return true;
  };
  const addToContacts = () =>
    void act('contact', async () => {
      if (await sameFirst('contact')) return;
      const saved = unwrap(
        await apiBrowser().POST('/v1/commands/outreach.profile.contact', {
          body: { workspaceId, profileId, personId: null },
        }),
      );
      toast.success(saved.addedPerson ? P.added(name) : P.already(name));
    });
  const client = (personId: string | null) =>
    act(
      'client',
      async () => {
        const out = unwrap(
          await apiBrowser().POST('/v1/commands/outreach.client.set', {
            body: { workspaceId, profileId, client: true, personId },
          }),
        );
        setSame(null);
        return out;
      },
      P.clientDone(name),
    );
  // Marking someone not in Contacts adds them there first: "Is this one of these?" when Contacts has their name.
  const markClient = () =>
    void act('client', async () => {
      if (!marks?.personId && (await sameFirst('client'))) return;
      unwrap(
        await apiBrowser().POST('/v1/commands/outreach.client.set', {
          body: { workspaceId, profileId, client: true, personId: null },
        }),
      );
      toast.success(P.clientDone(name));
    });
  // Only the Client tag comes off: when Contacts still counts them a client, it says why and where to change it.
  const notClient = () =>
    void act('client', async () => {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/outreach.client.set', {
          body: { workspaceId, profileId, client: false },
        }),
      );
      if (!out.client) toast.success(clientSetWords(name, false, out));
      else toast.info(clientSetWords(name, false, out));
    });
  const demo = (booked: boolean) =>
    void act(
      'demo',
      async () =>
        unwrap(
          await apiBrowser().POST('/v1/commands/outreach.demo.mark', {
            body: { workspaceId, profileId, booked },
          }),
        ),
      booked ? P.demoMarked(name) : P.demoUnmarked,
    );
  // Potential partner (decision 130): onto the person's Partners list with partner messages, or back off it.
  const potential = (on: boolean) =>
    void act(
      'partner',
      async () =>
        unwrap(
          await apiBrowser().POST('/v1/commands/outreach.partner.potential', {
            body: { workspaceId, profileId, potential: on },
          }),
        ),
      on ? P.potentialDone(name) : P.potentialOff(name),
    );
  // Later is the person's own: the page drawn again leaves them off Today, or puts them back.
  const later = (on: boolean) =>
    void act('later', async () => {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/outreach.later.set', {
          body: { workspaceId, profileId, later: on },
        }),
      );
      toast.success(laterSetWords(name, out));
    });
  const list = (change: { dontPitch: boolean } | { neverContact: boolean }, done: string) =>
    void act(
      'list',
      async () =>
        unwrap(
          await apiBrowser().POST('/v1/commands/outreach.friend.set', {
            body: { workspaceId, profileId, ...change },
          }),
        ),
      done,
    );

  // Whose they are (decision 107): an owner or admin gives them to a teammate.
  const give = (userId: string) =>
    void act('owner', async () => {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/outreach.owner.move', {
          body: { workspaceId, kind: 'person', id: profileId, userId },
        }),
      );
      toast.success(OWNER_WORDS.moved('person', out.owner));
    });

  const run: Partial<Record<PersonMenuKey, () => void>> = {
    'add-contact': addToContacts,
    'mark-client': markClient,
    'not-client': notClient,
    demo: () => demo(true),
    'not-demo': () => demo(false),
    'potential-partner': () => potential(true),
    'not-partner': () => potential(false),
    later: () => later(true),
    'not-later': () => later(false),
    'dont-pitch': () => list({ dontPitch: true }, P.dontPitchDone(name)),
    'not-dont-pitch': () => list({ dontPitch: false }, P.dontPitchOff(name)),
    'never-contact': () => list({ neverContact: true }, P.neverContactDone(name)),
    'not-never-contact': () => list({ neverContact: false }, P.neverContactOff(name)),
  };
  const select = (item: PersonMenuItem) =>
    item.owner !== undefined
      ? give(item.owner)
      : item.move !== undefined
        ? moves.find((m) => m.key === item.move)?.onSelect()
        : run[item.key]?.();
  const personId = (marks ? marks.personId : who.personId) ?? null;

  const drawItem = (item: PersonMenuItem) => {
    const Icon = item.key.startsWith('owner-') ? Users : ICONS[item.key];
    const icon = Icon ? <Icon className="h-4 w-4 flex-none" strokeWidth={1.5} aria-hidden /> : null;
    if (item.kind === 'open')
      return (
        <a
          key={item.key}
          href={item.url}
          target="_blank"
          rel="noreferrer"
          className={ACTION}
          data-testid={item.testId}
        >
          {icon}
          {item.label}
        </a>
      );
    if (item.kind === 'line')
      return item.key === 'move-to' ? (
        <p
          key={item.key}
          className="px-2.5 pb-0.5 pt-1.5 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3"
          data-testid={item.testId}
        >
          {item.label}
        </p>
      ) : (
        <p
          key={item.key}
          className="flex items-start gap-2.5 px-2.5 py-1.5 text-[13px] text-text-2"
          data-testid={item.testId}
        >
          {icon ? <span className="mt-px">{icon}</span> : null}
          {item.label}
        </p>
      );
    const off = !item.enabled || busy !== null || disabled;
    if (item.key === 'in-contacts' && personId && !off)
      return (
        <Link
          key={item.key}
          href={`/app/w/${workspaceId}/customers/people/${personId}`}
          className={ACTION}
          data-testid={item.testId}
        >
          {icon}
          {item.label}
        </Link>
      );
    return (
      <button
        key={item.key}
        type="button"
        disabled={off}
        onClick={() => {
          // As a menu does: the panel closes, and the list behind shows what changed.
          setOpen(false);
          select(item);
        }}
        className={cn(ACTION, item.danger && 'text-danger-text')}
        data-testid={item.testId}
      >
        {icon}
        {item.label}
      </button>
    );
  };
  // What an item does shows beside it once the pointer rests there (`HINT_DELAY_MS`), or the keyboard lands on it.
  const draw = (item: PersonMenuItem) =>
    item.hint ? (
      <Tooltip key={item.key} content={item.hint} side="left">
        {drawItem(item)}
      </Tooltip>
    ) : (
      drawItem(item)
    );

  // Their page and chat; the Pipeline's moves; then Contacts, Client, Demo booked, Later and the lists.
  const groups = [
    items.filter((i) => i.kind === 'open'),
    items.filter((i) => i.key === 'move-to' || i.move !== undefined),
    items.filter((i) => i.kind !== 'open' && i.key !== 'move-to' && i.move === undefined),
  ].filter((g) => g.length);
  const status = !online
    ? {
        testId: 'person-needs-signal',
        words: personMenuOfflineWords(items),
        Icon: WifiOff,
        spin: false,
      }
    : failed
      ? { testId: 'person-marks-failed', words: failed, Icon: null, spin: false }
      : !marks
        ? { testId: 'person-loading', words: P.loading, Icon: Loader2, spin: true }
        : null;
  const stage = marks?.journey?.stage ?? null;

  return (
    <>
      <Sheet
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) return;
          // Where they stand now, each time it opens: someone else may have changed it.
          setMarks(null);
          if (online) void load();
        }}
      >
        <SheetTrigger asChild>
          <button
            type="button"
            title={P.nameHint}
            aria-busy={busy !== null || undefined}
            className={cn(
              'inline-flex min-h-6 max-w-full items-center gap-1 rounded-[4px] text-left underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring',
              className,
            )}
            data-testid="person-menu"
          >
            <span className={cn(truncate && 'min-w-0 truncate')}>{name}</span>
            {busy !== null ? (
              <Loader2 className="h-3 w-3 flex-none animate-spin" aria-hidden />
            ) : (
              <ChevronRight className="h-3 w-3 flex-none opacity-70" strokeWidth={2} aria-hidden />
            )}
          </button>
        </SheetTrigger>
        <SheetContent
          title={name}
          description={`${PLATFORMS[who.platform]}${stage ? ` · ${STAGES[stage]}` : ''}`}
        >
          <div
            role="group"
            aria-label={P.menu(name)}
            className="-mx-2.5 grid gap-0.5"
            data-testid="person-menu-items"
          >
            <TooltipProvider delayDuration={HINT_DELAY_MS}>
              {groups.map((group, i) => (
                <div
                  key={group[0]!.key}
                  className={cn('grid gap-0.5', i > 0 && 'mt-1 border-t border-border pt-1')}
                >
                  {group.map(draw)}
                </div>
              ))}
            </TooltipProvider>
            {status ? (
              <p
                className="mt-1 flex items-start gap-2 border-t border-border px-2.5 pt-2.5 text-[13px] text-text-2"
                data-testid={status.testId}
              >
                {status.Icon ? (
                  <status.Icon
                    className={cn('mt-px h-3.5 w-3.5 flex-none', status.spin && 'animate-spin')}
                    strokeWidth={1.5}
                    aria-hidden
                  />
                ) : null}
                <span role="status">{status.words}</span>
              </p>
            ) : null}
          </div>
          {marks?.journey ? (
            <PersonStory
              workspaceId={workspaceId}
              platform={who.platform}
              journey={marks.journey}
              intro={marks.intro ?? []}
              mutualFriends={marks.mutualFriends ?? null}
            />
          ) : null}
        </SheetContent>
      </Sheet>
      {same ? (
        <SameNameDialog
          name={name}
          people={same.people}
          busy={busy !== null}
          onPick={(personId) => void (same.for === 'client' ? client(personId) : contact(personId))}
          onNew={() => void (same.for === 'client' ? client(null) : contact(null))}
          onClose={() => setSame(null)}
        />
      ) : null}
    </>
  );
}

/** How many of the latest steps show until the rest are asked for. */
const LATEST_STEPS = 6;

/** The panel's story of someone (decision 128): why they fit, the next step, the chat so far, where found, every step. */
function PersonStory({
  workspaceId,
  platform,
  journey: j,
  intro,
  mutualFriends,
}: {
  workspaceId: string;
  platform: Platform;
  journey: Journey;
  intro: readonly string[];
  mutualFriends: number | null;
}) {
  const [all, setAll] = useState(false);
  const steps = all ? j.steps : j.steps.slice(0, LATEST_STEPS);
  const S = P.panel;
  const heading = 'text-[12px] font-semibold uppercase tracking-[0.04em] text-text-3';
  return (
    <div
      className="mt-4 space-y-4 border-t border-border pt-4 text-[13.5px]"
      data-testid="person-panel"
    >
      {j.why.length || intro.length || mutualFriends ? (
        <section data-testid="person-panel-why">
          <h3 className={heading}>{S.whyFit}</h3>
          {j.why.length ? <p className="mt-1">{j.why.join(' · ')}</p> : null}
          {intro.length ? (
            <ul className="mt-1 text-[13px] text-text-2">
              {intro.slice(0, 4).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
          {mutualFriends ? (
            <p className="mt-0.5 text-[12.5px] text-text-3">{S.mutual(mutualFriends)}</p>
          ) : null}
        </section>
      ) : null}
      {j.nextStep ? (
        <section data-testid="person-panel-next">
          <h3 className={heading}>{S.nextStep}</h3>
          <p className="mt-1">{j.nextStep}</p>
        </section>
      ) : null}
      {j.lead ? (
        <p data-testid="person-panel-lead">
          <Link
            href={`/app/w/${workspaceId}/leads/${j.lead.leadId}`}
            className="text-accent-text hover:underline"
          >
            {leadWords(j.lead)}
          </Link>
        </p>
      ) : null}
      <section data-testid="person-panel-chat">
        <h3 className={heading}>{S.theChat}</h3>
        {j.chat?.summary ? (
          <p className="mt-1">
            {j.chat.summary}{' '}
            <span className="text-[12.5px] text-text-3">
              {S.lastFrom(j.chat.lastFromMe, relativeTime(j.chat.lastAt))}
            </span>
          </p>
        ) : (
          <p className="mt-1 text-text-2">{S.noChat}</p>
        )}
      </section>
      {j.groups.length ? (
        <section data-testid="person-panel-groups">
          <h3 className={heading}>{S.foundIn}</h3>
          <p className="mt-1">
            {j.groups.map((g, i) => (
              <span key={g.groupId}>
                {i ? ', ' : ''}
                <Link
                  href={outreachHref(workspaceId, { view: 'groups', group: g.groupId })}
                  className="text-accent-text hover:underline"
                >
                  {g.name ?? S.aGroup}
                </Link>
              </span>
            ))}
          </p>
        </section>
      ) : null}
      <section data-testid="person-panel-steps">
        <h3 className={heading}>{S.everyStep}</h3>
        {steps.length ? (
          <ol className="mt-1.5 space-y-1 border-l border-border pl-3">
            {steps.map((step, i) => (
              <li key={`${step.at}-${i}`} className="text-[13px]">
                {step.postUrl ? (
                  <a
                    href={step.postUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="hover:underline"
                  >
                    {journeyStepWords(step, platform)}
                  </a>
                ) : (
                  <span>{journeyStepWords(step, platform)}</span>
                )}
                {step.group ? (
                  <span className="text-text-3"> · {S.fromGroup(step.group.name)}</span>
                ) : null}
                <span className="text-text-3"> · {relativeTime(step.at)}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="mt-1 text-text-2">{S.noSteps}</p>
        )}
        {j.steps.length > LATEST_STEPS ? (
          <button
            type="button"
            className="mt-1.5 text-[12.5px] text-accent-text hover:underline"
            onClick={() => setAll(!all)}
          >
            {all ? S.showLatest : S.showAll(j.steps.length)}
          </button>
        ) : null}
        {all && j.moreSteps ? (
          <p className="mt-0.5 text-[12px] text-text-3">{S.moreSteps(j.moreSteps)}</p>
        ) : null}
      </section>
    </div>
  );
}
