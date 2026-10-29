'use client';
/**
 * The person menu on someone's name (docs/outreach.md, decisions 43 and 91): wherever the web shows someone kept in
 * Social Outreach (Waiting for you, Today, the Pipeline, Friends and Chats), their name is a button that opens it. Its
 * items, their order, what shows and what can be pressed come from core (`personMenuItems`), the same as on the phone:
 *
 * - **Open on {Network}**, their page there, first, and **Open in {messages}** where their chat is known: links out,
 *   in a new tab;
 * - the Pipeline's moves, on its rows;
 * - **In Contacts**, or **Add to Contacts**, which looks for customers with the same name first (./same-name.tsx), so
 *   the person says "It's them" rather than making a second;
 * - **Mark as client** (`outreach.client.set`), through the same "Is this one of these?" when they aren't in
 *   Contacts, or **Not a client after all**, or why Contacts counts them a client;
 * - **Demo booked**, or **Not a demo after all**;
 * - **Later**, off the person's own Today for 2 weeks, or **Take off Later** (`outreach.later.set`, decision 100);
 * - who reached them first, and for an owner or admin **Give them to {teammate}** (`outreach.owner.move`, decision
 *   107);
 * - **Don't pitch** and **Never contact**, or taking them off, or who put them on: left out where the row has its own
 *   switches (Friends, Chats).
 *
 * Opening it asks where they stand now (`outreach.profile.marks`); its toggles wait for the answer. Add to Contacts and
 * Client need Add and edit customers (`records.write`), so they're left out for whoever can't.
 */
import type { Platform } from '@hfos/core/addons/outreach/networks';
import {
  clientSetWords,
  laterSetWords,
  personMenuItems,
  personMenuOfflineWords,
  type PersonMenuItem,
  type PersonMenuKey,
  type ProfileMarksOutput,
} from '@hfos/core/addons/outreach/person-menu';
import { OWNER_WORDS } from '@hfos/core/addons/outreach/owners';
import { OUTREACH_WORDS } from '@hfos/core/addons/outreach/words';
import {
  BadgeCheck,
  Ban,
  CalendarCheck,
  ChevronDown,
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
import { Fragment, useCallback, useRef, useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { useCan } from '@/components/shell/workspace-shell';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { cn } from '@/lib/utils';
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
  later: Clock,
  'not-later': Clock,
  'dont-pitch': Ban,
  'not-dont-pitch': Ban,
  'dont-pitch-line': Ban,
  'never-contact': UserX,
  'not-never-contact': UserX,
  'never-contact-line': UserX,
};

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
 * Someone's name, as a button that opens their person menu. With no profile kept it's the name alone. `className`
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

  const draw = (item: PersonMenuItem) => {
    const Icon = item.key.startsWith('owner-') ? Users : ICONS[item.key];
    const icon = Icon ? <Icon className="h-4 w-4 flex-none" strokeWidth={1.5} aria-hidden /> : null;
    if (item.kind === 'open')
      return (
        <DropdownMenuItem key={item.key} asChild>
          <a href={item.url} target="_blank" rel="noreferrer" data-testid={item.testId}>
            {icon}
            {item.label}
          </a>
        </DropdownMenuItem>
      );
    if (item.kind === 'line')
      return item.key === 'move-to' ? (
        <DropdownMenuLabel key={item.key} data-testid={item.testId}>
          {item.label}
        </DropdownMenuLabel>
      ) : (
        <DropdownMenuLabel
          key={item.key}
          className="flex max-w-[300px] items-start gap-2.5 text-[13px] font-normal text-text-2"
          data-testid={item.testId}
        >
          {icon ? <span className="mt-px">{icon}</span> : null}
          {item.label}
        </DropdownMenuLabel>
      );
    const off = !item.enabled || busy !== null || disabled;
    if (item.key === 'in-contacts' && personId && !off)
      return (
        <DropdownMenuItem key={item.key} asChild>
          <Link
            href={`/app/w/${workspaceId}/customers/people/${personId}`}
            data-testid={item.testId}
          >
            {icon}
            {item.label}
          </Link>
        </DropdownMenuItem>
      );
    return (
      <DropdownMenuItem
        key={item.key}
        danger={item.danger}
        disabled={off}
        onSelect={() => select(item)}
        data-testid={item.testId}
      >
        {icon}
        {item.label}
      </DropdownMenuItem>
    );
  };

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

  return (
    <>
      <DropdownMenu
        onOpenChange={(open) => {
          if (!open) return;
          // Where they stand now, each time it opens: someone else may have changed it.
          setMarks(null);
          if (online) void load();
        }}
      >
        <DropdownMenuTrigger asChild>
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
              <ChevronDown className="h-3 w-3 flex-none opacity-70" strokeWidth={2} aria-hidden />
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="max-w-[320px]" data-testid="person-menu-items">
          {groups.map((group, i) => (
            <Fragment key={group[0]!.key}>
              {i ? <DropdownMenuSeparator /> : null}
              {group.map(draw)}
            </Fragment>
          ))}
          {status ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel
                className="flex items-start gap-2 font-normal"
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
              </DropdownMenuLabel>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
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
