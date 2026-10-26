'use client';
/**
 * The whole profile, as a person (docs/outreach.md, decision 84; the canvas "Social Outreach profile check"), around
 * Get ready's checklist in the profile's sheet and the setup's step:
 *
 * - **How it comes across** (`ProfileLookBox`): the AI's verdict, and each thing that clashes, with the person's other
 *   profiles side by side a press away. It stays their own account, as a person, never a business page.
 * - **The rest of the profile** (`ProfileRest`): its username, name and links, each as it is and as written, with who
 *   does it, and **Put these in** for the ones ticked. A new username always asks first (`UsernameDialog`): what
 *   changes, each option checked free on the person's computer, their own to type and check, and **Show me more**
 *   with a note for the AI, kept for the next check.
 * - **Pictures** (`ProfilePictures`): the photo judged, the cover made from its line to download, and the steps to put
 *   them in themselves, as HandsFreeOS never changes pictures (decision 64).
 * - **Side by side** (`ProfilesSideBySide`), on Settings → General: every network's name, username, line and link.
 *
 * What's listed and decided is core's (profile-parts.ts), so the phone says the same.
 */
import {
  MATCH_PARTS,
  shownUsername,
  usernameProblem,
  type ProfileCheck,
} from '@hfos/core/addons/outreach/profile-check';
import {
  COVER_SIZE_ON,
  firstUsername,
  linkName,
  LINK_WORDS,
  linksToAdd,
  LOOK_WORDS,
  MATCH_WORDS,
  MORE_CHIPS,
  MORE_COUNT,
  MORE_WORDS,
  partStepsWords,
  PICTURE_WORDS,
  profileMatch,
  profileParts,
  PROFILE_PART_WORDS as W,
  USERNAME_WORDS as U,
  type LinkToAdd,
  type ProfilePartRow,
  type ProfilesKnown,
} from '@hfos/core/addons/outreach/profile-parts';
import type { WritePart } from '@hfos/core/addons/outreach/profile-check';
import { PLATFORMS, type Platform } from '@hfos/core/addons/outreach/networks';
import { AlertTriangle, ArrowRight, CheckCircle2, Download, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { apiBrowser, errorMessage } from '@/lib/api/client';
import { workerPost } from '@/lib/api/worker';
import { cn } from '@/lib/utils';
import { outreachHref } from './address';
import { AskButton } from './asks';
import type { Asks } from './types';

/** Every network's latest check of the person's profile, the booking links and the website, read again on `key`. */
export function useProfiles(workspaceId: string, key: string | null): ProfilesKnown | null {
  const [known, setKnown] = useState<ProfilesKnown | null>(null);
  useEffect(() => {
    let gone = false;
    void apiBrowser()
      .POST('/v1/queries/outreach.profiles', { body: { workspaceId } })
      .then((r) => {
        if (!gone && r.data) setKnown(r.data as unknown as ProfilesKnown);
      })
      .catch(() => undefined);
    return () => {
      gone = true;
    };
  }, [workspaceId, key]);
  return known;
}

/** How the whole profile comes across: right as a person who does this work, or what clashes. */
export function ProfileLookBox({
  workspaceId,
  check,
}: {
  workspaceId: string;
  check: ProfileCheck | null;
}) {
  const look = check?.look;
  if (!look) return null;
  if (look.ok)
    return (
      <p
        className="flex items-start gap-2.5 rounded-menu bg-success-soft px-3.5 py-2.5 text-[13.5px] text-success-text"
        data-testid="ready-profile-look"
        data-ok="true"
      >
        <CheckCircle2 className="mt-0.5 h-4 w-4 flex-none" strokeWidth={1.75} aria-hidden="true" />
        {look.title || LOOK_WORDS.person}
      </p>
    );
  return (
    <section
      aria-labelledby="ready-look-title"
      className="flex gap-3 rounded-card bg-warning-soft px-4 py-3.5 text-warning-text"
      data-testid="ready-profile-look"
      data-ok="false"
    >
      <AlertTriangle className="mt-0.5 h-5 w-5 flex-none" strokeWidth={1.75} aria-hidden="true" />
      <div className="grid min-w-0 gap-2">
        <h3 id="ready-look-title" className="text-[15px] font-semibold">
          {look.title || LOOK_WORDS.unclear}
        </h3>
        {look.clashes.length ? (
          <ul className="grid gap-1.5 text-[13.5px]">
            {look.clashes.map((c) => (
              <li key={c} className="flex gap-2.5">
                <span
                  className="mt-2 h-1.5 w-1.5 flex-none rounded-full bg-warning"
                  aria-hidden="true"
                />
                {c}
              </li>
            ))}
          </ul>
        ) : null}
        <p className="text-[13px] text-text-2">{W.stays}</p>
        <Link
          href={outreachHref(workspaceId, { view: 'settings' })}
          className="text-[13px] font-medium text-accent-text hover:underline"
          data-testid="ready-profile-side-by-side"
        >
          {MATCH_WORDS.title}
        </Link>
      </div>
    </section>
  );
}

const HOW_BADGE: Readonly<Record<ProfilePartRow['how'], BadgeVariant>> = {
  auto: 'ok',
  steps: 'pending',
  app: 'pending',
  tip: 'gray',
};

/** The badge beside a part: right, or who does it; a username always asks first. */
function PartBadge({ row }: { row: ProfilePartRow }) {
  if (row.ok) return <Badge variant="ok">{W.right}</Badge>;
  if (row.part === 'username') return <Badge variant="accent">{W.asksFirst}</Badge>;
  return <Badge variant={HOW_BADGE[row.how]}>{W.how[row.how]}</Badge>;
}

/** What's there now, and what's written for it. */
function Swap({ now, next, mono = false }: { now: string | null; next: string; mono?: boolean }) {
  return (
    <div className="mt-2 grid items-center gap-2.5 sm:grid-cols-[minmax(0,1fr)_20px_minmax(0,1fr)]">
      <p
        className={cn(
          'rounded-control bg-card-2 px-3 py-2 text-[13.5px] text-text-2 [overflow-wrap:anywhere]',
          now && 'line-through decoration-text-3',
          mono && 'font-mono text-[12.5px]',
        )}
      >
        <span className="sr-only">{W.now}: </span>
        {now ?? W.none}
      </p>
      <ArrowRight
        className="hidden h-4 w-4 text-text-3 sm:block"
        strokeWidth={1.75}
        aria-hidden="true"
      />
      <p
        className={cn(
          'rounded-control border border-accent bg-accent-soft px-3 py-2 text-[13.5px] text-text [overflow-wrap:anywhere]',
          mono && 'font-mono text-[12.5px]',
        )}
      >
        {next}
      </p>
    </div>
  );
}

/**
 * The profile's username, name and links: each as it is and as written, who does it, and Put these in for the ones
 * ticked (decision 84). Pictures, featured and posts are the checklist's.
 */
export function ProfileRest({
  workspaceId,
  platform,
  check,
  known,
  asks,
}: {
  workspaceId: string;
  platform: Platform;
  check: ProfileCheck | null;
  known: ProfilesKnown | null;
  asks: Asks | null;
}) {
  // Who does each goes by the person's computer's build: an older one hands Facebook's username and links over.
  const version = asks?.computer?.version;
  const all = useMemo(
    () =>
      known && check
        ? profileParts(
            platform,
            { ...known, checks: { ...known.checks, [platform]: check } },
            version,
          )
        : [],
    [known, check, platform, version],
  );
  const rows = all.filter((r) => ['username', 'name', 'links'].includes(r.part) && r.how !== 'tip');
  const links = useMemo(
    () =>
      known && check
        ? linksToAdd(platform, { ...known, checks: { ...known.checks, [platform]: check } })
        : [],
    [known, check, platform],
  );
  const [name, setName] = useState<string | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  const [linksOn, setLinksOn] = useState<ReadonlySet<string>>(new Set());
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [dialog, setDialog] = useState<'username' | 'name' | null>(null);
  // What's written comes ticked: a name and links to add; a username only once picked, as it asks first.
  useEffect(() => {
    setName(check?.names?.[0] ?? check?.nameDraft ?? null);
    setLinksOn(new Set(links.filter((l) => !l.held).map((l) => l.url)));
    setTicked(
      new Set(
        rows.filter((r) => !r.ok && r.part !== 'username' && r.next.length).map((r) => r.part),
      ),
    );
    // Only a new check resets what's picked.
  }, [check?.at, known]);
  // A check from before the whole profile was has nothing to say of these: read it again for that.
  if (!check?.look || !rows.length) return null;
  const tick = (part: string, on: boolean) =>
    setTicked((was) => {
      const next = new Set(was);
      if (on) next.add(part);
      else next.delete(part);
      return next;
    });
  const pickedLinks = links.filter((l) => !l.held && linksOn.has(l.url)).map((l) => l.url);
  const edit = {
    ...(ticked.has('name') && name ? { name } : {}),
    ...(ticked.has('username') && username ? { username } : {}),
    ...(ticked.has('links') && pickedLinks.length ? { links: pickedLinks } : {}),
  };
  const count = Object.keys(edit).length;
  const goIn = rows.filter((r) => r.how === 'auto').length;
  return (
    <section
      aria-labelledby="ready-rest-title"
      className="grid gap-1"
      data-testid="ready-profile-rest"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="ready-rest-title" className="font-semibold">
          {W.whatToChange}
        </h3>
        <span className="text-[12.5px] text-text-3">{W.counts(rows.length, goIn)}</span>
      </div>
      <ul className="divide-y divide-border border-y border-border">
        {rows.map((row) => {
          const can =
            row.part === 'username'
              ? !!username
              : row.part === 'name'
                ? !!name
                : pickedLinks.length > 0;
          const next =
            row.part === 'username'
              ? username
                ? shownUsername(platform, username)
                : null
              : row.part === 'name'
                ? name
                : pickedLinks.length
                  ? pickedLinks.join(', ')
                  : null;
          return (
            <li
              key={row.part}
              className="grid grid-cols-[24px_minmax(0,1fr)_auto] items-start gap-3 py-3.5"
              data-testid={`ready-part-${row.part}`}
            >
              {row.ok ? (
                <CheckCircle2
                  className="mt-0.5 h-5 w-5 text-success"
                  strokeWidth={1.75}
                  role="img"
                  aria-label={W.right}
                />
              ) : (
                <input
                  type="checkbox"
                  className="mt-1 h-[18px] w-[18px] accent-[var(--accent)]"
                  checked={ticked.has(row.part) && can}
                  disabled={!can}
                  onChange={(e) => tick(row.part, e.target.checked)}
                  aria-label={`Put in the ${row.name.toLowerCase()}`}
                  data-testid={`ready-part-${row.part}-tick`}
                />
              )}
              <div className="min-w-0">
                <p className="font-semibold">{row.name}</p>
                {row.ok ? (
                  row.now ? (
                    <p
                      className={cn(
                        'text-[13.5px] text-text-2',
                        row.part === 'username' && 'font-mono text-[12.5px]',
                      )}
                    >
                      {row.part === 'username' ? shownUsername(platform, row.now) : row.now}
                    </p>
                  ) : null
                ) : next ? (
                  <Swap
                    now={
                      row.part === 'username' && row.now
                        ? shownUsername(platform, row.now)
                        : row.now
                    }
                    next={next}
                    mono={row.part === 'username'}
                  />
                ) : row.fix ? (
                  <p className="mt-1 text-[13.5px] text-text-2">{row.fix}</p>
                ) : null}
                {row.part === 'links' && !row.ok ? (
                  <LinkSwitches links={links} on={linksOn} onChange={setLinksOn} />
                ) : null}
                {/* Who does it, only for what's left to change. */}
                <p className={cn('mt-1.5 text-[12.5px] text-text-3', row.ok && 'hidden')}>
                  {row.how === 'app' ? W.howHint.app(platform) : W.howHint[row.how]}
                  {row.part === 'username' && !row.ok ? (
                    <>
                      {' '}
                      <button
                        type="button"
                        className="font-medium text-accent-text hover:underline"
                        onClick={() => setDialog('username')}
                        data-testid="ready-username-open"
                      >
                        {username ? MORE_WORDS.more : U.title(platform).replace('?', '…')}
                      </button>
                    </>
                  ) : null}
                  {row.part === 'name' && !row.ok && row.how !== 'tip' ? (
                    <>
                      {' '}
                      <button
                        type="button"
                        className="font-medium text-accent-text hover:underline"
                        onClick={() => setDialog('name')}
                        data-testid="ready-name-more"
                      >
                        {MORE_WORDS.more}
                      </button>
                    </>
                  ) : null}
                </p>
              </div>
              <PartBadge row={row} />
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap items-center justify-end gap-3 pt-2">
        <span className="max-w-[340px] text-right text-[12.5px] text-text-3">{W.putInHint}</span>
        {asks ? (
          <AskButton
            workspaceId={workspaceId}
            asks={asks}
            ask={{ kind: 'profile_edit', ...edit }}
            platform={platform}
            label={W.putIn(Math.max(count, 1))}
            variant="primary"
            size="md"
            disabled={count === 0}
            testId="ready-rest-put-in"
          />
        ) : null}
      </div>
      <UsernameDialog
        open={dialog === 'username'}
        onClose={() => setDialog(null)}
        workspaceId={workspaceId}
        platform={platform}
        check={check}
        asks={asks}
        onPick={(u) => {
          setUsername(u);
          tick('username', true);
          setDialog(null);
        }}
      />
      <MoreDialog
        open={dialog === 'name'}
        onClose={() => setDialog(null)}
        workspaceId={workspaceId}
        platform={platform}
        part="name"
        options={check.names ?? (check.nameDraft ? [check.nameDraft] : [])}
        picked={name}
        onPick={(n) => {
          setName(n);
          tick('name', true);
          setDialog(null);
        }}
      />
    </section>
  );
}

/** The links to add, each with its switch; one that doesn't read as them yet is held back. */
function LinkSwitches({
  links,
  on,
  onChange,
}: {
  links: readonly LinkToAdd[];
  on: ReadonlySet<string>;
  onChange: (next: ReadonlySet<string>) => void;
}) {
  if (!links.length) return null;
  return (
    <div className="mt-2 grid gap-2" data-testid="ready-links">
      {links.map((l) => (
        <div
          key={l.url}
          className="flex items-center justify-between gap-3 rounded-control bg-card-2 px-3 py-2"
        >
          <div className="min-w-0">
            <p className="text-[13.5px] font-medium">{linkName(l)}</p>
            <p className="truncate font-mono text-[12px] text-text-2">{l.url}</p>
            <p className={cn('text-[12px]', l.held ? 'text-warning-text' : 'text-text-3')}>
              {l.held
                ? LINK_WORDS.held
                : l.kind === 'booking'
                  ? LINK_WORDS.bookingFrom
                  : l.kind === 'website'
                    ? LINK_WORDS.websiteFrom
                    : LINK_WORDS.profileFrom}
            </p>
          </div>
          <Switch
            checked={!l.held && on.has(l.url)}
            disabled={l.held}
            label={`Add ${linkName(l)}`}
            onChange={(next) => {
              const s = new Set(on);
              if (next) s.add(l.url);
              else s.delete(l.url);
              onChange(s);
            }}
          />
        </div>
      ))}
      <p className="text-[12px] text-text-3">{LINK_WORDS.only}</p>
    </div>
  );
}

/** The chips and the person's words, and the press for more (decision 84): the check comes back with them kept. */
function MoreControls({
  workspaceId,
  platform,
  part,
  onDone,
}: {
  workspaceId: string;
  platform: Platform;
  part: WritePart;
  onDone: (options: string[]) => void;
}) {
  const router = useRouter();
  const [chips, setChips] = useState<ReadonlySet<string>>(new Set());
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const more = async () => {
    setBusy(true);
    try {
      const got = await workerPost<{ options: string[] }>(
        '/v1/addons/outreach/actions/outreach.profile.more',
        { workspaceId, input: { platform, part, chips: [...chips], note } },
      );
      setChips(new Set());
      setNote('');
      onDone(got.options);
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid gap-2.5" data-testid={`ready-more-${part}`}>
      <p className="text-[13px] font-semibold">{MORE_WORDS.what}</p>
      <div className="flex flex-wrap gap-2">
        {MORE_CHIPS[part].map((c) => (
          <button
            key={c}
            type="button"
            aria-pressed={chips.has(c)}
            onClick={() =>
              setChips((was) => {
                const next = new Set(was);
                if (next.has(c)) next.delete(c);
                else next.add(c);
                return next;
              })
            }
            className={cn(
              'h-8 rounded-full border px-3 text-[13px] font-medium',
              chips.has(c)
                ? 'border-accent bg-accent-soft text-accent-text'
                : 'border-border-strong bg-card text-text-2 hover:bg-card-2',
            )}
          >
            {c}
          </button>
        ))}
      </div>
      <label className="text-[13px] font-medium" htmlFor={`more-note-${part}`}>
        {MORE_WORDS.yourWords}
      </label>
      <textarea
        id={`more-note-${part}`}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        maxLength={300}
        placeholder={MORE_WORDS.placeholder}
        className="w-full rounded-control border border-border-strong bg-card p-2.5 text-[14px] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
      />
      <div className="flex flex-wrap items-center gap-2.5">
        <Button
          size="sm"
          onClick={() => void more()}
          loading={busy}
          data-testid={`ready-more-${part}-go`}
        >
          <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} />
          {MORE_WORDS.moreOf(MORE_COUNT[part])}
        </Button>
        <span className="text-[12.5px] text-text-3">{MORE_WORDS.kept}</span>
      </div>
    </div>
  );
}

/** More of a part the AI writes, to pick from (a name, a cover line): this round's, the ones before, and more. */
function MoreDialog({
  open,
  onClose,
  workspaceId,
  platform,
  part,
  options,
  picked,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  platform: Platform;
  part: WritePart;
  options: readonly string[];
  picked: string | null;
  onPick: (option: string) => void;
}) {
  const [fresh, setFresh] = useState<readonly string[] | null>(null);
  const shown = fresh ?? options;
  const [choice, setChoice] = useState<string | null>(picked);
  useEffect(() => setChoice(picked ?? shown[0] ?? null), [picked, shown]);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={MORE_WORDS.title[part]}
        description={MORE_WORDS.hint}
        className="w-[min(560px,calc(100vw-32px))]"
      >
        <div className="mt-4 grid gap-4">
          <div role="radiogroup" aria-label={MORE_WORDS.title[part]} className="grid gap-2">
            {shown.map((o) => (
              <button
                key={o}
                type="button"
                role="radio"
                aria-checked={choice === o}
                onClick={() => setChoice(o)}
                className={cn(
                  'rounded-menu border px-3.5 py-2.5 text-left text-[14px]',
                  choice === o ? 'border-accent bg-accent-soft' : 'border-border-strong bg-card',
                )}
              >
                {o}
              </button>
            ))}
          </div>
          <div className="border-t border-border pt-4">
            <MoreControls
              workspaceId={workspaceId}
              platform={platform}
              part={part}
              onDone={setFresh}
            />
          </div>
          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <Button variant="secondary" onClick={onClose}>
              {U.keep.replace('username', part)}
            </Button>
            <Button
              disabled={!choice}
              onClick={() => choice && onPick(choice)}
              data-testid={`ready-more-${part}-use`}
            >
              {choice ? U.use(`“${choice}”`) : MORE_WORDS.title[part]}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const FREE_BADGE = (free: boolean | null) =>
  free === true ? (
    <Badge variant="ok">{U.free}</Badge>
  ) : free === false ? (
    <Badge variant="gray">{U.taken}</Badge>
  ) : (
    <Badge variant="member">{U.unknown}</Badge>
  );

/**
 * A new username asks first (decision 84): what changes, the options each checked on the person's computer (free,
 * taken, or not yet), one of their own to type and check, and more with a note. Nothing changes unless they pick one.
 */
export function UsernameDialog({
  open,
  onClose,
  workspaceId,
  platform,
  check,
  asks,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  platform: Platform;
  check: ProfileCheck;
  asks: Asks | null;
  onPick: (username: string) => void;
}) {
  const options = check.usernames ?? [];
  const first = firstUsername(check);
  const [choice, setChoice] = useState<string | null>(first?.value ?? null);
  const [own, setOwn] = useState('');
  const [more, setMore] = useState(false);
  useEffect(() => setChoice((was) => was ?? firstUsername(check)?.value ?? null), [check]);
  const unchecked = options
    .filter((o) => o.free === null)
    .map((o) => o.value)
    .slice(0, 6);
  const ownProblem = own.trim() ? usernameProblem(platform, own) : null;
  const old = check.seen?.username ? shownUsername(platform, check.seen.username) : null;
  const picked = options.find((o) => o.value === choice);
  const taken = options.find((o) => o.free === false && o.value === options[0]?.value);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={U.title(platform)}
        description={U.desc(platform)}
        className="w-[min(560px,calc(100vw-32px))]"
      >
        <div className="mt-4 grid gap-4" data-testid="ready-username-dialog">
          {taken ? (
            <p
              role="status"
              className="rounded-menu bg-warning-soft px-3.5 py-2.5 text-[13.5px] text-warning-text"
            >
              {U.takenLine(shownUsername(platform, taken.value))}
            </p>
          ) : null}
          <div role="radiogroup" aria-label={U.label} className="grid gap-2">
            {options.map((o) => (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={choice === o.value}
                disabled={o.free === false}
                onClick={() => setChoice(o.value)}
                className={cn(
                  'flex items-center gap-3 rounded-menu border px-3.5 py-2.5 text-left disabled:cursor-not-allowed',
                  choice === o.value
                    ? 'border-accent bg-accent-soft'
                    : 'border-border-strong bg-card',
                  o.free === false && 'bg-card-2 text-text-3',
                )}
                data-testid={`ready-username-${o.value}`}
              >
                <span
                  className={cn('flex-1 font-mono text-[13px]', o.free === false && 'line-through')}
                >
                  {shownUsername(platform, o.value)}
                </span>
                {FREE_BADGE(o.free)}
              </button>
            ))}
          </div>
          {asks && unchecked.length ? (
            <AskButton
              workspaceId={workspaceId}
              asks={asks}
              ask={{ kind: 'username_check', usernames: unchecked }}
              platform={platform}
              label={U.checkAll}
              testId="ready-username-check"
            />
          ) : null}
          <div>
            <label className="text-[13px] font-medium" htmlFor="ready-username-own">
              {U.own}
            </label>
            <div className="mt-1.5 flex gap-2">
              <input
                id="ready-username-own"
                value={own}
                onChange={(e) => setOwn(e.target.value)}
                className="h-10 min-w-0 flex-1 rounded-control border border-border-strong bg-card px-3 font-mono text-[13px] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
                placeholder="yourname"
              />
              {asks ? (
                <AskButton
                  workspaceId={workspaceId}
                  asks={asks}
                  ask={{ kind: 'username_check', usernames: [own.trim() || 'x'] }}
                  platform={platform}
                  label={U.check}
                  size="md"
                  disabled={!own.trim() || ownProblem !== null}
                  showLine={false}
                  testId="ready-username-own-check"
                />
              ) : null}
            </div>
            <p
              className={cn(
                'mt-1.5 text-[12.5px]',
                ownProblem ? 'text-warning-text' : 'text-text-3',
              )}
            >
              {ownProblem ?? U.checkHint(platform)}
            </p>
          </div>
          <div className="grid gap-2 rounded-menu bg-card-2 p-3.5">
            <p className="text-[13px] font-semibold">{U.changes}</p>
            <ul className="grid gap-1.5 text-[13.5px] text-text-2">
              {old ? <li>{U.oldLinks(old)}</li> : null}
              <li>{U.search}</li>
              <li>{U.limit(platform)}</li>
            </ul>
          </div>
          {more ? (
            <div className="border-t border-border pt-4">
              <MoreControls
                workspaceId={workspaceId}
                platform={platform}
                part="username"
                onDone={(o) => setChoice(o[0] ?? null)}
              />
            </div>
          ) : null}
          <div className="flex flex-wrap-reverse items-center justify-between gap-2 border-t border-border pt-4">
            {more ? (
              <span />
            ) : (
              <Button
                variant="ghost"
                onClick={() => setMore(true)}
                data-testid="ready-username-more"
              >
                <RefreshCw className="h-4 w-4" strokeWidth={1.75} />
                {MORE_WORDS.more}
              </Button>
            )}
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={onClose}>
                {U.keep}
              </Button>
              <Button
                disabled={!choice || picked?.free === false}
                onClick={() => choice && onPick(choice)}
                data-testid="ready-username-use"
              >
                {choice ? U.use(shownUsername(platform, choice)) : U.label}
              </Button>
            </div>
          </div>
          <p className="text-[12.5px] text-text-3">{U.pickNote}</p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The cover's looks to pick from, in the app's own colours: its accent, its ink, and its soft blue. */
const COVER_LOOKS = [
  { bg: '#2d69d8', fg: '#ffffff' },
  { bg: '#191d25', fg: '#f2f4f8' },
  { bg: '#e9f0fd', fg: '#191d25' },
] as const;

/** Draws the cover: its line big, and the person's name and what they do under it. */
function drawCover(
  canvas: HTMLCanvasElement,
  size: { readonly w: number; readonly h: number },
  line: string,
  under: string,
  look: (typeof COVER_LOOKS)[number],
) {
  canvas.width = size.w;
  canvas.height = size.h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.fillStyle = look.bg;
  ctx.fillRect(0, 0, size.w, size.h);
  ctx.fillStyle = look.fg;
  const pad = Math.round(size.w * 0.07);
  let px = Math.round(size.h * 0.16);
  const font = (n: number, weight: number) =>
    `${weight} ${n}px "Hanken Grotesk", system-ui, -apple-system, "Segoe UI", sans-serif`;
  // The line, as big as fits on two lines.
  const wrap = (text: string, width: number): string[] => {
    const lines: string[] = [];
    let now = '';
    for (const word of text.split(/\s+/)) {
      const tried = now ? `${now} ${word}` : word;
      if (ctx.measureText(tried).width > width && now) {
        lines.push(now);
        now = word;
      } else now = tried;
    }
    if (now) lines.push(now);
    return lines;
  };
  let lines: string[] = [];
  for (; px > 24; px -= 4) {
    ctx.font = font(px, 700);
    lines = wrap(line, size.w - pad * 2);
    if (lines.length <= 2) break;
  }
  const small = Math.round(px * 0.42);
  const total = lines.length * px * 1.15 + small * 1.8;
  let y = (size.h - total) / 2 + px;
  ctx.textBaseline = 'alphabetic';
  for (const l of lines) {
    ctx.fillText(l, pad, y);
    y += px * 1.15;
  }
  ctx.globalAlpha = 0.85;
  ctx.font = font(small, 500);
  ctx.fillText(under, pad, y + small * 0.6);
  ctx.globalAlpha = 1;
}

/**
 * The photo, judged, and the cover made from its line (decision 84): to download, with the steps to put each in
 * themselves. HandsFreeOS never changes pictures (decision 64).
 */
export function ProfilePictures({
  workspaceId,
  platform,
  check,
}: {
  workspaceId: string;
  platform: Platform;
  check: ProfileCheck | null;
}) {
  const size = COVER_SIZE_ON[platform];
  const lines = check?.coverLines ?? (check?.coverLine ? [check.coverLine] : []);
  const [line, setLine] = useState(lines[0] ?? '');
  useEffect(() => setLine(lines[0] ?? ''), [lines[0]]);
  const [look, setLook] = useState(0);
  const [more, setMore] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const under = check?.seen?.name ?? '';
  useEffect(() => {
    if (canvas.current && size && line)
      drawCover(canvas.current, size, line, under, COVER_LOOKS[look]!);
  }, [size, line, under, look]);
  const photo = check?.items.picture;
  if (!check?.look) return null;
  const download = () =>
    canvas.current?.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${platform}-cover.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    }, 'image/png');
  return (
    <section
      aria-labelledby="ready-pictures-title"
      className="grid gap-3"
      data-testid="ready-pictures"
    >
      <div>
        <h3 id="ready-pictures-title" className="font-semibold">
          {PICTURE_WORDS.titleOn(platform)}
        </h3>
        <p className="text-[13px] text-text-2">{PICTURE_WORDS.hint}</p>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="grid content-start gap-2 rounded-card border border-border p-4">
          <div className="flex items-center justify-between gap-2">
            <p className="font-semibold">{PICTURE_WORDS.photo}</p>
            {photo ? (
              <Badge variant={photo.ok ? 'ok' : 'pending'}>{photo.ok ? W.right : W.how.tip}</Badge>
            ) : null}
          </div>
          {photo ? (
            <p className="text-[13.5px] text-text-2">
              {photo.ok ? photo.why : (photo.fix ?? photo.why)}
            </p>
          ) : null}
          <ul className="grid gap-1 text-[13px] text-text-2">
            {PICTURE_WORDS.works.map((w) => (
              <li key={w} className="flex gap-2">
                <CheckCircle2
                  className="mt-0.5 h-3.5 w-3.5 flex-none text-success"
                  strokeWidth={2}
                  aria-hidden="true"
                />
                {w}
              </li>
            ))}
          </ul>
        </div>
        {size && line ? (
          <div
            className="grid content-start gap-2 rounded-card border border-border p-4"
            data-testid="ready-cover"
          >
            <div className="flex items-center justify-between gap-2">
              <p className="font-semibold">{PICTURE_WORDS.cover}</p>
              <Badge variant="accent">{MORE_WORDS.newRound}</Badge>
            </div>
            <canvas
              ref={canvas}
              role="img"
              aria-label={`Your new cover: “${line}”`}
              className="w-full rounded-menu"
              style={{ aspectRatio: `${size.w} / ${size.h}` }}
            />
            <p className="text-[12.5px] text-text-3">{PICTURE_WORDS.coverFrom(platform)}</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={download} data-testid="ready-cover-download">
                <Download className="h-3.5 w-3.5" strokeWidth={1.75} />
                {PICTURE_WORDS.download}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setMore((m) => !m)}>
                {PICTURE_WORDS.changeLine}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setLook((l) => (l + 1) % COVER_LOOKS.length)}
              >
                {PICTURE_WORDS.anotherLook}
              </Button>
            </div>
            {lines.length > 1 ? (
              <div
                role="radiogroup"
                aria-label={PICTURE_WORDS.changeLine}
                className="flex flex-wrap gap-1.5"
              >
                {lines.map((l) => (
                  <button
                    key={l}
                    type="button"
                    role="radio"
                    aria-checked={l === line}
                    onClick={() => setLine(l)}
                    className={cn(
                      'rounded-full border px-2.5 py-1 text-[12.5px]',
                      l === line
                        ? 'border-accent bg-accent-soft text-accent-text'
                        : 'border-border-strong',
                    )}
                  >
                    {l}
                  </button>
                ))}
              </div>
            ) : null}
            {more ? (
              <MoreControls
                workspaceId={workspaceId}
                platform={platform}
                part="cover"
                onDone={(o) => {
                  setLine(o[0] ?? line);
                  setMore(false);
                }}
              />
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="rounded-menu bg-card-2 px-3.5 py-2.5 text-[13.5px] text-text-2">
        <p className="font-medium text-text">{PICTURE_WORDS.yourself}</p>
        <p>{partStepsWords(platform, 'picture')}</p>
      </div>
    </section>
  );
}

/** Every checked network side by side (decision 84), on Settings → General: what doesn't match marked. */
export function ProfilesSideBySide({
  workspaceId,
  networks,
}: {
  workspaceId: string;
  /** The networks the person has on: each shows, read or not yet. */
  networks: readonly Platform[];
}) {
  const known = useProfiles(workspaceId, null);
  if (!known) return null;
  const cols = profileMatch(known, networks);
  const off = cols.reduce((n, c) => n + c.off.length, 0);
  return (
    <Card className="space-y-4 p-5" data-testid="outreach-profiles-side-by-side">
      <div>
        <h2 className="text-[17px] font-semibold tracking-tight">{MATCH_WORDS.title}</h2>
        <p className="text-[13px] text-text-2">{MATCH_WORDS.hint}</p>
      </div>
      {!cols.some((c) => c.checked) ? (
        <p className="text-[13.5px] text-text-2">{MATCH_WORDS.none}</p>
      ) : (
        <>
          <p
            role="status"
            className={cn(
              'rounded-menu px-3.5 py-2.5 text-[13.5px]',
              off ? 'bg-warning-soft text-warning-text' : 'bg-success-soft text-success-text',
            )}
          >
            {MATCH_WORDS.off(off)}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse text-[13.5px]">
              <thead>
                <tr>
                  <th scope="col" className="w-28" />
                  {cols.map((c) => (
                    <th
                      key={c.platform}
                      scope="col"
                      className="px-3 py-2 text-left text-[12px] font-semibold text-text-2"
                    >
                      {PLATFORMS[c.platform]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {MATCH_PARTS.map((part) => (
                  <tr key={part} className="border-t border-border">
                    <th
                      scope="row"
                      className="px-3 py-2.5 text-left text-[13px] font-semibold text-text-2"
                    >
                      {MATCH_WORDS.parts[part]}
                    </th>
                    {cols.map((c) => {
                      const v = c.values[part];
                      const isOff = c.off.includes(part);
                      if (!c.checked)
                        return (
                          <td key={c.platform} className="px-3 py-2.5 align-top text-text-3">
                            {part === 'name' ? MATCH_WORDS.notChecked : W.none}
                          </td>
                        );
                      return (
                        <td
                          key={c.platform}
                          className={cn(
                            'px-3 py-2.5 align-top',
                            isOff && 'rounded-control bg-warning-soft text-warning-text',
                          )}
                          data-off={isOff || undefined}
                        >
                          <span className={cn(part === 'username' && 'font-mono text-[12.5px]')}>
                            {v ? (part === 'username' ? shownUsername(c.platform, v) : v) : W.none}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
                <tr className="border-t border-border">
                  <td />
                  {cols.map((c) => (
                    <td key={c.platform} className="px-3 py-2.5">
                      {c.off.length || !c.checked ? (
                        <Link
                          href={outreachHref(workspaceId, { view: 'settings', part: c.platform })}
                          className="text-[13px] font-medium text-accent-text hover:underline"
                        >
                          {c.checked ? MATCH_WORDS.fix(c.platform) : MATCH_WORDS.read(c.platform)}
                        </Link>
                      ) : null}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}

/** Show me more of a part listed elsewhere (the bios): a press, and a box for what the person wants. */
export function MoreButton({
  workspaceId,
  platform,
  part,
}: {
  workspaceId: string;
  platform: Platform;
  part: WritePart;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => setOpen(true)}
        data-testid={`ready-more-${part}-open`}
      >
        <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} />
        {MORE_WORDS.more}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          title={MORE_WORDS.title[part]}
          description={MORE_WORDS.hint}
          className="w-[min(560px,calc(100vw-32px))]"
        >
          <div className="mt-4">
            <MoreControls
              workspaceId={workspaceId}
              platform={platform}
              part={part}
              onDone={() => setOpen(false)}
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
