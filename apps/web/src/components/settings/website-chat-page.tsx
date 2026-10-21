'use client';
/**
 * Settings → Website chat (design/m7/WebsiteChat.dc.html). The left column acts at once: on or paused, who answers,
 * the daily limit, the sites (typed ones are checked as they're typed, with the www twin shown), the snippet with
 * the install check, a new key, and Try it. The right column is one form with Save: how it looks, the away message,
 * what it asks visitors for and the texts box.
 */
import {
  MAX_CHAT_ORIGINS,
  normalizeChatOrigin,
  readableTextOn,
  type ChatAskMode,
} from '@hfos/core';
import {
  Check,
  CircleCheck,
  Clock,
  Copy,
  ExternalLink,
  FlaskConical,
  Globe,
  KeyRound,
  MessageCircle,
  Plus,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Callout } from '@/components/crm/chips';
import { Badge } from '@/components/ui/badge';
import { Button, buttonClassName } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { copyText } from '@/components/ui/copy-field';
import { Dialog, DialogClose, DialogContent } from '@/components/ui/dialog';
import { FieldError, Hint, Label } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, ApiError, errorMessage, unwrap } from '@/lib/api/client';
import { fieldErrors } from '@/lib/api/field-errors';
import type { ChatWidget, ChatWidgetUpdateBody } from '@/lib/api/types';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { usePublicOrigin } from '@/lib/use-origin';
import { cn, relativeTime } from '@/lib/utils';
import { SetRow } from './set-row';
import { settingAttrs } from './setting-anchor';

export interface ChatTeammate {
  readonly id: string;
  readonly name: string;
  readonly status: 'off' | 'training' | 'automatic';
  /** Its Website chat channel is on, answering this widget. */
  readonly answersChat: boolean;
}

/** The texts box as the chat window shows it (the worker's wording, the booking page's for a chat). */
const CONSENT_TEXT = 'Text me about my request. Msg & data rates may apply. Reply STOP to opt out.';
const SWATCHES = ['#b42318', '#2d69d8', '#0e7490', '#008743', '#7c3aed', '#191d25'];
const ASK_LABELS = { name: 'Name', phone: 'Mobile', email: 'Email' } as const;
const ASK_OPTIONS: readonly (readonly [ChatAskMode, string])[] = [
  ['never', 'Don’t ask'],
  ['when_needed', 'When needed'],
  ['before_chat', 'Before the chat starts'],
];

const PLATFORMS = [
  {
    key: 'wordpress',
    name: 'WordPress',
    steps: [
      'In WordPress, go to Plugins, Add New, and install a header and footer plugin (like WPCode).',
      'Paste the snippet into its footer box and save.',
      'Open your site and click the chat button once. The check above turns green within a minute.',
    ],
  },
  {
    key: 'wix',
    name: 'Wix',
    steps: [
      'In your Wix dashboard, go to Settings, then Custom code.',
      'Add the snippet, choose “All pages” and “Body - end”, and apply.',
      'Publish, then open your site and click the chat button once.',
    ],
  },
  {
    key: 'squarespace',
    name: 'Squarespace',
    steps: [
      'Go to Settings, Advanced, then Code injection.',
      'Paste the snippet into the Footer box and save.',
      'Code injection needs a Squarespace business plan or higher.',
    ],
  },
  {
    key: 'gohighlevel',
    name: 'GoHighLevel',
    steps: [
      'Open Sites, then your website or funnel, and go to its Settings.',
      'Paste the snippet into “Footer tracking code” and save.',
      'Publish, then open the site and click the chat button once.',
    ],
  },
  {
    key: 'webflow',
    name: 'Webflow',
    steps: [
      'Open Site settings, then Custom code.',
      'Paste the snippet into “Footer code” and save.',
      'Publish the site, then open it and click the chat button once.',
    ],
  },
  {
    key: 'other',
    name: 'Something else',
    steps: [
      'Paste the snippet just before </body> on every page.',
      'If your site uses a template, add it to the template once.',
      'Your web person can do this in a minute. Send them this page.',
    ],
  },
] as const;

/** A site as people read it: acme.com, or http://localhost:4191 on your own computer. */
const shown = (origin: string) => origin.replace(/^https:\/\//, '');
const hostOf = (origin: string | null) => {
  if (!origin) return 'your site';
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

type Patch = Omit<ChatWidgetUpdateBody, 'workspaceId' | 'widgetId'>;

async function updateWidget(workspaceId: string, widgetId: string, patch: Patch) {
  return unwrap(
    await apiBrowser().POST('/v1/commands/chat_widget.update', {
      body: { workspaceId, widgetId, ...patch },
    }),
  );
}

/** The first refusal about the sites, in core's plain words ("Wildcards like *.acme.com don't work here."). */
function sitesProblem(e: unknown): string | null {
  if (!(e instanceof ApiError) || e.code !== 'validation' || !Array.isArray(e.details)) return null;
  const hit = (e.details as { path?: unknown; message?: unknown }[]).find((d) =>
    String(Array.isArray(d.path) ? d.path.join('.') : (d.path ?? '')).includes('allowedOrigins'),
  );
  return typeof hit?.message === 'string' ? hit.message : null;
}

interface SiteRow {
  readonly origin: string;
  /** The www (or bare) version added for them. */
  readonly twin: string | null;
}

/** The saved origins as the sites people typed: each with its twin, when both are on the list. */
function siteRows(origins: readonly string[]): SiteRow[] {
  const rows: SiteRow[] = [];
  const used = new Set<string>();
  for (const origin of origins) {
    if (used.has(origin)) continue;
    const r = normalizeChatOrigin(origin);
    const twin = r.ok && r.twin && origins.includes(r.twin) && !used.has(r.twin) ? r.twin : null;
    used.add(origin);
    if (twin) used.add(twin);
    rows.push({ origin, twin });
  }
  return rows;
}

export function WebsiteChatPage({
  workspaceId,
  widget,
  teammate,
  brandedOrigin,
  website = null,
}: {
  workspaceId: string;
  widget: ChatWidget | null;
  teammate: ChatTeammate | null;
  /** Their own domain when one is serving (M17): the snippet they paste loads from it. */
  brandedOrigin: string | null;
  /** The business's website as it gave it, which setting the chat up starts from. */
  website?: string | null;
}) {
  useLiveRefresh(['chat_widget', 'ai_teammate']);
  if (!widget) return <SetUp workspaceId={workspaceId} teammate={teammate} website={website} />;
  return (
    <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-2" data-testid="chat-settings">
      <div className="flex min-w-0 flex-col gap-5">
        <StatusCard workspaceId={workspaceId} widget={widget} teammate={teammate} />
        <SitesCard workspaceId={workspaceId} widget={widget} />
        <SnippetCard workspaceId={workspaceId} widget={widget} brandedOrigin={brandedOrigin} />
        <TryCard workspaceId={workspaceId} widget={widget} />
      </div>
      <LookForm key={widget.id} workspaceId={workspaceId} widget={widget} teammate={teammate} />
    </div>
  );
}

function CardTitle({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="min-w-0">
      <h2 className="text-lg font-semibold tracking-tight">{children}</h2>
      {sub ? <p className="mt-1 text-[13px] text-text-2">{sub}</p> : null}
    </div>
  );
}

/** A site typed in: checked as it's typed, with the www version it adds, or the refusal in plain words. */
function SiteInput({
  existing,
  onAdd,
  busy,
  error,
}: {
  /** Every origin already on the list, twins included. */
  existing: readonly string[];
  onAdd: (typed: string) => Promise<boolean> | boolean;
  busy: boolean;
  error: string | null;
}) {
  const id = useId();
  const [value, setValue] = useState('');
  const check = value.trim() ? normalizeChatOrigin(value) : null;
  const already = !!check?.ok && existing.includes(check.origin);
  const tooMany =
    !!check?.ok &&
    existing.length + 1 + (check.twin && !existing.includes(check.twin) ? 1 : 0) > MAX_CHAT_ORIGINS;
  const problem =
    error ??
    (!check
      ? null
      : !check.ok
        ? check.message
        : already
          ? 'That site is already on the list.'
          : tooMany
            ? `A chat can show on up to ${MAX_CHAT_ORIGINS} sites, counting the www versions added for you.`
            : null);
  const note =
    check?.ok && !problem
      ? check.twin && !existing.includes(check.twin)
        ? `Adds ${shown(check.origin)} and ${shown(check.twin)}.`
        : `Adds ${shown(check.origin)}.`
      : null;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!check?.ok || problem) return;
    if (await onAdd(value.trim())) setValue('');
  };
  return (
    <form onSubmit={submit} className="border-t border-border pt-3" data-testid="chat-site-add">
      <div className="flex gap-2">
        <label htmlFor={id} className="sr-only">
          Add a site
        </label>
        <Input
          id={id}
          inputSize="sm"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Add a site, like acmeroofing.com"
          autoComplete="off"
          spellCheck={false}
          invalid={!!problem}
          aria-describedby={`${id}-note`}
          data-testid="chat-site-input"
        />
        <Button
          type="submit"
          variant="secondary"
          size="sm"
          loading={busy}
          disabled={!check?.ok || !!problem}
          data-testid="chat-site-submit"
        >
          <Plus className="h-4 w-4" aria-hidden />
          Add
        </Button>
      </div>
      <p
        id={`${id}-note`}
        role={problem ? 'alert' : undefined}
        className={cn('mt-1.5 text-[12.5px]', problem ? 'text-danger-text' : 'text-text-3')}
        data-testid="chat-site-note"
      >
        {problem ??
          note ??
          `Up to ${MAX_CHAT_ORIGINS} sites, all on https. To try it on your own computer, use http://localhost with its port.`}
      </p>
    </form>
  );
}

function SitesList({
  rows,
  seenOrigin,
  onRemove,
  busy,
}: {
  rows: readonly SiteRow[];
  seenOrigin: string | null;
  onRemove: (row: SiteRow) => void;
  busy: boolean;
}) {
  if (!rows.length) return null;
  return (
    <ul className="mt-3">
      {rows.map((row) => {
        const installed = !!seenOrigin && (seenOrigin === row.origin || seenOrigin === row.twin);
        return (
          <li
            key={row.origin}
            className="flex items-center gap-2.5 border-t border-border py-2.5 text-[13.5px]"
            data-testid="chat-site"
          >
            <Globe className="h-4 w-4 flex-none text-text-3" aria-hidden />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-medium">{shown(row.origin)}</span>
              {row.twin ? (
                <span className="truncate text-xs text-text-3">
                  {shown(row.twin)} is added for you
                </span>
              ) : null}
            </span>
            {installed ? (
              <Badge variant="ok">
                <Check className="h-3.5 w-3.5" aria-hidden />
                Installed
              </Badge>
            ) : null}
            <Button
              variant="ghost"
              size="icon"
              disabled={busy}
              onClick={() => onRemove(row)}
              aria-label={`Remove ${shown(row.origin)}`}
              title="Remove"
            >
              <X className="h-4 w-4" aria-hidden />
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

/** Before there's a widget: the sites, starting from the business's own website, then "Turn on website chat". */
function SetUp({
  workspaceId,
  teammate,
  website,
}: {
  workspaceId: string;
  teammate: ChatTeammate | null;
  website: string | null;
}) {
  const router = useRouter();
  const [typed, setTyped] = useState<string[]>(() =>
    website && normalizeChatOrigin(website).ok ? [website] : [],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rows: SiteRow[] = typed.flatMap((t) => {
    const r = normalizeChatOrigin(t);
    return r.ok ? [{ origin: r.origin, twin: r.twin }] : [];
  });
  const origins = rows.flatMap((r) => (r.twin ? [r.origin, r.twin] : [r.origin]));
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/chat_widget.create', {
          body: {
            workspaceId,
            allowedOrigins: typed,
            teammateId: teammate?.id ?? null,
            // A greeting to start from; it's the first thing visitors read, and Look changes it.
            greeting: 'Hi, thanks for stopping by. How can we help?',
          },
        }),
      );
      toast.success('Website chat is on. Paste the snippet on your site.');
      router.refresh();
    } catch (e) {
      setError(sitesProblem(e) ?? errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-2">
      <Card className="p-6" data-testid="chat-setup">
        <CardTitle
          sub={`A chat button on your website. ${teammate ? `${teammate.name} can answer, your team can join,` : 'Your team answers from the inbox,'} and every chat lands in the inbox.`}
        >
          Website chat
        </CardTitle>
        <p className="mt-5 text-[13px] font-medium">Your sites</p>
        <p className="text-xs text-text-3">
          The chat only opens on these sites. Anywhere else, browsers refuse to show it.
        </p>
        <SitesList
          rows={rows}
          seenOrigin={null}
          busy={busy}
          onRemove={(row) =>
            setTyped((list) =>
              list.filter((t) => {
                const r = normalizeChatOrigin(t);
                return !r.ok || r.origin !== row.origin;
              }),
            )
          }
        />
        <div className={rows.length ? '' : 'mt-3'}>
          <SiteInput
            existing={origins}
            busy={false}
            error={error}
            onAdd={(site) => {
              setTyped((list) => [...list, site]);
              setError(null);
              return true;
            }}
          />
        </div>
        <div className="mt-5 flex justify-end border-t border-border pt-4">
          <Button
            onClick={create}
            disabled={!typed.length}
            loading={busy}
            data-testid="chat-create"
          >
            Turn on website chat
          </Button>
        </div>
      </Card>
    </div>
  );
}

function newest(a: ChatWidget['install'], b: ChatWidget['install'] | null): ChatWidget['install'] {
  if (!b) return a;
  if (!a.lastSeenAt) return b;
  if (!b.lastSeenAt) return a;
  return b.lastSeenAt > a.lastSeenAt ? b : a;
}

/** "Seen on acme.com 3 min ago", or "Not seen yet"; checked again every 20 seconds until it's seen. */
function InstallCheck({ workspaceId, widget }: { workspaceId: string; widget: ChatWidget }) {
  const router = useRouter();
  const [fetched, setFetched] = useState<ChatWidget['install'] | null>(null);
  const [checking, setChecking] = useState(false);
  const [, setTick] = useState(0);
  const install = newest(widget.install, fetched);
  const check = useCallback(async () => {
    setChecking(true);
    try {
      const got = unwrap(
        await apiBrowser().POST('/v1/queries/chat_widget.get', {
          body: { workspaceId, widgetId: widget.id },
        }),
      );
      setFetched(got.widget.install);
      // The sites list's "Installed" badge comes from the page's copy.
      if (got.widget.install.lastSeenAt !== widget.install.lastSeenAt) router.refresh();
    } catch {
      // Keep what's shown; the next check tries again.
    } finally {
      setChecking(false);
    }
  }, [workspaceId, widget.id, widget.install.lastSeenAt, router]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (install.seen) setTick((n) => n + 1);
      else void check();
    }, 20_000);
    return () => clearInterval(timer);
  }, [install.seen, check]);
  const again = (
    <Button
      variant="ghost"
      size="sm"
      className="flex-none text-inherit hover:text-inherit"
      onClick={() => void check()}
      loading={checking}
      data-testid="chat-install-recheck"
    >
      Check again
    </Button>
  );
  if (install.seen && install.lastSeenAt)
    return (
      <div
        role="status"
        className="mt-4 flex items-center gap-2.5 rounded-menu bg-success-soft py-1.5 pl-3 pr-1.5 text-[13px] text-success-text"
        data-testid="chat-install"
      >
        <CircleCheck className="h-4 w-4 flex-none" aria-hidden />
        <span className="min-w-0 flex-1 font-semibold">
          Seen on {hostOf(install.lastSeenOrigin)} {relativeTime(install.lastSeenAt)}
        </span>
        {again}
      </div>
    );
  return (
    <div
      role="status"
      className="mt-4 flex items-center gap-2.5 rounded-menu bg-card-2 py-1.5 pl-3 pr-1.5 text-[13px] text-text-2"
      data-testid="chat-install"
    >
      <Clock className="h-4 w-4 flex-none" aria-hidden />
      <span className="min-w-0 flex-1">
        <strong className="font-semibold">Not seen yet.</strong> Paste the snippet on your site,
        then open the chat there once.
      </span>
      {again}
    </div>
  );
}

function StatusCard({
  workspaceId,
  widget,
  teammate,
}: {
  workspaceId: string;
  widget: ChatWidget;
  teammate: ChatTeammate | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [cap, setCap] = useState(String(widget.dailyCap));
  const [capError, setCapError] = useState<string | null>(null);
  const aiTeam = `/app/w/${workspaceId}/ai-team`;

  const toggle = async (on: boolean) => {
    setBusy(true);
    try {
      unwrap(
        await apiBrowser().POST(
          on ? '/v1/commands/chat_widget.resume' : '/v1/commands/chat_widget.pause',
          {
            body: { workspaceId, widgetId: widget.id },
          },
        ),
      );
      toast.success(
        on
          ? 'Website chat is back on.'
          : 'Website chat is paused. Visitors don’t see the button until you turn it back on.',
      );
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const answer = async (teammateId: string) => {
    setBusy(true);
    try {
      await updateWidget(workspaceId, widget.id, { teammateId: teammateId || null });
      toast.success(
        teammateId && teammate
          ? `${teammate.name} answers website chats.`
          : 'Your team answers website chats.',
      );
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const saveCap = async () => {
    const n = Number(cap);
    if (!Number.isInteger(n) || n < 1 || n > 10_000) {
      setCapError('Pick a whole number from 1 to 10,000.');
      return;
    }
    setCapError(null);
    if (n === widget.dailyCap) return;
    try {
      await updateWidget(workspaceId, widget.id, { dailyCap: n });
      toast.success(`Up to ${n.toLocaleString()} new chats a day.`);
      router.refresh();
    } catch (e) {
      setCapError(fieldErrors(e).dailyCap ?? errorMessage(e));
    }
  };

  const answering = widget.teammate && teammate && widget.teammate.id === teammate.id;
  const note = !teammate ? (
    <>
      Want an AI teammate to answer?{' '}
      <Link
        href={aiTeam}
        className="font-medium text-accent-text underline-offset-2 hover:underline"
      >
        Set one up
      </Link>
    </>
  ) : answering && teammate.status === 'off' ? (
    <>
      {teammate.name} is off, so your team answers for now.{' '}
      <Link
        href={aiTeam}
        className="font-medium text-accent-text underline-offset-2 hover:underline"
      >
        Open AI teammate
      </Link>
    </>
  ) : answering && !teammate.answersChat ? (
    <>
      {teammate.name}’s Website chat channel is off, so your team answers for now.{' '}
      <Link
        href={aiTeam}
        className="font-medium text-accent-text underline-offset-2 hover:underline"
      >
        Turn it on
      </Link>
    </>
  ) : null;

  return (
    <Card className="p-6" data-testid="chat-status-card">
      <div className="flex items-start justify-between gap-4">
        <CardTitle
          sub={`A chat button on your website. ${answering ? `${teammate.name} answers, your team can join,` : 'Your team answers from the inbox,'} and every chat lands in the inbox.`}
        >
          Website chat
        </CardTitle>
        <span className="flex flex-none items-center gap-2 pt-1 text-[13px] font-medium">
          <span data-testid="chat-on-label">{widget.paused ? 'Paused' : 'On'}</span>
          <Switch
            checked={!widget.paused}
            onChange={(on) => void toggle(on)}
            label="Website chat on"
            disabled={busy}
            testId="chat-on"
          />
        </span>
      </div>
      {widget.paused ? (
        <Callout tone="warning" icon={Clock} className="mt-4" data-testid="chat-paused">
          Paused. Visitors don’t see the chat button until you turn it back on.
        </Callout>
      ) : (
        <InstallCheck workspaceId={workspaceId} widget={widget} />
      )}
      <SetRow
        className="mt-3"
        center
        setting="website_chat.who_answers"
        title="Who answers"
        description="Your team can reply from the inbox too."
        body={note ? <span className="text-xs text-text-3">{note}</span> : undefined}
      >
        <Select
          selectSize="sm"
          className="w-[190px]"
          value={widget.teammate?.id ?? ''}
          disabled={busy}
          onChange={(e) => void answer(e.target.value)}
          aria-label="Who answers"
          data-testid="chat-who"
        >
          {teammate ? <option value={teammate.id}>{teammate.name} (AI)</option> : null}
          <option value="">Only your team</option>
        </Select>
      </SetRow>
      <SetRow
        center
        setting="website_chat.daily_limit"
        title="Daily limit"
        description="New chats a day, so a flood of strangers can’t use up your AI time."
        body={capError ? <FieldError>{capError}</FieldError> : undefined}
      >
        <span className="flex items-center gap-2">
          <Input
            inputSize="sm"
            type="number"
            min={1}
            max={10_000}
            value={cap}
            onChange={(e) => setCap(e.target.value)}
            onBlur={() => void saveCap()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void saveCap();
              }
            }}
            invalid={!!capError}
            className="w-[92px]"
            aria-label="New chats a day"
            data-testid="chat-daily-cap"
          />
          <span className="text-xs text-text-3">a day</span>
        </span>
      </SetRow>
    </Card>
  );
}

function SitesCard({ workspaceId, widget }: { workspaceId: string; widget: ChatWidget }) {
  const router = useRouter();
  const rows = siteRows(widget.allowedOrigins);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (list: string[], done: string): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await updateWidget(workspaceId, widget.id, { allowedOrigins: list });
      toast.success(done);
      router.refresh();
      return true;
    } catch (e) {
      setError(sitesProblem(e) ?? errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="p-6" data-testid="chat-sites" {...settingAttrs('website_chat.sites')}>
      <CardTitle sub="The chat only opens on these sites. Anywhere else, browsers refuse to show it.">
        Your sites
      </CardTitle>
      <SitesList
        rows={rows}
        seenOrigin={widget.install.lastSeenOrigin}
        busy={busy}
        onRemove={(row) =>
          void save(
            rows.filter((r) => r !== row).map((r) => r.origin),
            `Removed ${shown(row.origin)}.`,
          )
        }
      />
      <SiteInput
        existing={widget.allowedOrigins}
        busy={busy}
        error={error}
        onAdd={(typed) => {
          const r = normalizeChatOrigin(typed);
          return save(
            [...rows.map((row) => row.origin), typed],
            `Added ${r.ok ? shown(r.origin) : typed}.`,
          );
        }}
      />
    </Card>
  );
}

function SnippetCard({
  workspaceId,
  widget,
  brandedOrigin,
}: {
  workspaceId: string;
  widget: ChatWidget;
  brandedOrigin: string | null;
}) {
  const router = useRouter();
  const origin = usePublicOrigin(brandedOrigin);
  const src = `${origin}/embed/v1/${widget.publicKey}.js`;
  const snippet = `<script async src="${src}"></script>`;
  const [platform, setPlatform] = useState<(typeof PLATFORMS)[number]['key']>('wordpress');
  const [copied, setCopied] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const steps = PLATFORMS.find((p) => p.key === platform)?.steps ?? [];
  const rotate = async () => {
    setBusy(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/chat_widget.rotate_key', {
          body: { workspaceId, widgetId: widget.id },
        }),
      );
      setConfirm(false);
      setCopied(false);
      toast.success('New key ready. Paste the new snippet on your site.');
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="p-6" data-testid="chat-install-card" {...settingAttrs('website_chat.install')}>
      <div className="flex items-start justify-between gap-3">
        <CardTitle sub="Paste this once. It loads after your page, so it doesn’t slow it down, and it can’t clash with your site’s look.">
          Add it to your site
        </CardTitle>
        <Button
          variant="secondary"
          size="sm"
          className="flex-none"
          disabled={!origin}
          onClick={async () => {
            await copyText(snippet, 'Snippet copied. Paste it once on your site.');
            setCopied(true);
          }}
          data-testid="chat-snippet-copy"
        >
          <Copy className="h-4 w-4" aria-hidden />
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre
        className="mt-3 whitespace-pre-wrap break-all rounded-[10px] border border-border-strong bg-[#191d25] px-3.5 py-3 font-mono text-[12.5px] leading-[1.65] text-[#e4e8ee]"
        data-testid="chat-snippet"
      >
        <code>
          <span className="text-[#8cb8ff]">&lt;script</span>{' '}
          <span className="text-[#f5c97a]">async</span> <span className="text-[#f5c97a]">src</span>=
          <span className="text-[#86e0a8]">&quot;{src}&quot;</span>
          <span className="text-[#8cb8ff]">&gt;&lt;/script&gt;</span>
        </code>
      </pre>
      <p className="mb-2 mt-4 text-[13px] font-medium" id="chat-platforms">
        How to add it on
      </p>
      <div role="radiogroup" aria-labelledby="chat-platforms" className="flex flex-wrap gap-1.5">
        {PLATFORMS.map((p) => (
          <button
            key={p.key}
            type="button"
            role="radio"
            aria-checked={platform === p.key}
            onClick={() => setPlatform(p.key)}
            className={cn(
              'h-[30px] rounded-full border px-3 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring',
              platform === p.key
                ? 'border-transparent bg-accent-soft text-accent-text'
                : 'border-border-strong bg-card text-text-2 hover:text-text',
            )}
          >
            {p.name}
          </button>
        ))}
      </div>
      <ol
        className="mt-3 list-decimal pl-5 text-[13.5px] leading-[1.6]"
        data-testid="chat-platform-steps"
      >
        {steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      <div className="mt-4 flex items-center justify-between gap-3 border-t border-border pt-4">
        <p className="text-xs text-text-3">
          Someone put your snippet on a site that isn’t yours? Get a new key, then paste the new
          snippet.
        </p>
        <Button
          variant="ghost"
          size="sm"
          className="flex-none"
          onClick={() => setConfirm(true)}
          data-testid="chat-new-key"
        >
          <KeyRound className="h-4 w-4" aria-hidden />
          New key
        </Button>
      </div>
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent
          title="Get a new key?"
          description="The snippet you pasted before stops working within a few minutes, and the chat button disappears from your sites until you paste the new one."
        >
          <div className="mt-5 flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="secondary">Cancel</Button>
            </DialogClose>
            <Button
              variant="danger"
              onClick={() => void rotate()}
              loading={busy}
              data-testid="chat-new-key-confirm"
            >
              Get a new key
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function TryCard({ workspaceId, widget }: { workspaceId: string; widget: ChatWidget }) {
  const href = `/chat-preview/${widget.publicKey}?w=${workspaceId}`;
  return (
    <Card className="p-6" {...settingAttrs('website_chat.try')}>
      <div className="flex items-start justify-between gap-3">
        <CardTitle sub="Opens a preview page with your chat. Test chats create nothing and send nothing.">
          Try it
        </CardTitle>
        <a
          href={href}
          target="_blank"
          rel="noopener"
          className={buttonClassName({ size: 'sm', className: 'flex-none' })}
          data-testid="chat-try-it"
        >
          <ExternalLink className="h-4 w-4" aria-hidden />
          Try it
        </a>
      </div>
      <div aria-hidden className="mt-3 overflow-hidden rounded-[10px] border border-border-strong">
        <div className="flex h-[30px] items-center gap-1.5 border-b border-border bg-card-2 px-3">
          <i className="h-[9px] w-[9px] rounded-full bg-[#ff5f57]" />
          <i className="h-[9px] w-[9px] rounded-full bg-[#febc2e]" />
          <i className="h-[9px] w-[9px] rounded-full bg-[#28c840]" />
          <span className="mx-auto h-5 w-full max-w-[320px] truncate rounded-md border border-border bg-card px-2 text-[11px] leading-[18px] text-text-3">
            /chat-preview/{widget.publicKey}
          </span>
        </div>
        <div className="relative h-[112px] bg-card-2">
          <p className="flex items-center gap-1.5 bg-warning-soft px-3 py-2 text-xs text-warning-text">
            <FlaskConical className="h-3.5 w-3.5" aria-hidden />
            Preview. Chats here create nothing and send nothing.
          </p>
          <span
            className={cn(
              'absolute bottom-3 inline-flex h-11 w-11 items-center justify-center rounded-full shadow-2',
              widget.position === 'left' ? 'left-3.5' : 'right-3.5',
            )}
            style={{ background: widget.accentColor, color: widget.textColor }}
          >
            <MessageCircle className="h-5 w-5" />
          </span>
        </div>
      </div>
    </Card>
  );
}

interface LookDraft {
  greeting: string;
  launcherLabel: string;
  accentColor: string;
  position: 'left' | 'right';
  awayMessage: string;
  askFor: { name: ChatAskMode; phone: ChatAskMode; email: ChatAskMode };
  smsConsent: boolean;
}

const draftOf = (w: ChatWidget): LookDraft => ({
  greeting: w.greeting ?? '',
  launcherLabel: w.launcherLabel,
  accentColor: w.accentColor,
  position: w.position,
  awayMessage: w.awayMessage ?? '',
  askFor: { name: w.askFor.name, phone: w.askFor.phone, email: w.askFor.email },
  smsConsent: w.smsConsent,
});

/** The right column: one form, saved together (what visitors see changes the moment it's saved). */
function LookForm({
  workspaceId,
  widget,
  teammate,
}: {
  workspaceId: string;
  widget: ChatWidget;
  teammate: ChatTeammate | null;
}) {
  const router = useRouter();
  const saved = draftOf(widget);
  const [draft, setDraft] = useState(saved);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const set = (patch: Partial<LookDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const who = widget.teammate && teammate?.id === widget.teammate.id ? teammate.name : null;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    try {
      await updateWidget(workspaceId, widget.id, {
        greeting: draft.greeting,
        launcherLabel: draft.launcherLabel,
        accentColor: draft.accentColor,
        position: draft.position,
        awayMessage: draft.awayMessage,
        askFor: draft.askFor,
        smsConsent: draft.smsConsent,
      });
      toast.success('Website chat saved.');
      router.refresh();
    } catch (err) {
      const found = fieldErrors(err);
      setErrors(found);
      if (!Object.keys(found).length) toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save} className="flex min-w-0 flex-col gap-5" data-testid="chat-look-form">
      <Card className="p-6" {...settingAttrs('website_chat.look')}>
        <CardTitle sub="One colour and a greeting. The window matches your visitor’s light or dark setting.">
          Look
        </CardTitle>
        <div className="mt-4">
          <Label htmlFor="chat-greeting">Greeting</Label>
          <Textarea
            id="chat-greeting"
            value={draft.greeting}
            onChange={(e) => set({ greeting: e.target.value })}
            maxLength={500}
            invalid={!!errors.greeting}
            className="min-h-[64px] text-sm"
            data-testid="chat-greeting"
          />
          {errors.greeting ? <FieldError>{errors.greeting}</FieldError> : null}
        </div>
        <div className="mt-4 grid grid-cols-1 gap-3.5 sm:grid-cols-2">
          <div>
            <Label htmlFor="chat-label">Button label</Label>
            <Input
              id="chat-label"
              inputSize="sm"
              value={draft.launcherLabel}
              onChange={(e) => set({ launcherLabel: e.target.value })}
              maxLength={40}
              invalid={!!errors.launcherLabel}
              data-testid="chat-label"
            />
            {errors.launcherLabel ? <FieldError>{errors.launcherLabel}</FieldError> : null}
          </div>
          <div>
            <p className="mb-1.5 text-[13px] font-medium">Position</p>
            <Segmented
              fill
              ariaLabel="Position"
              value={draft.position}
              onChange={(position) => set({ position })}
              options={[
                { value: 'right', label: 'Bottom right', testId: 'chat-position-right' },
                { value: 'left', label: 'Bottom left', testId: 'chat-position-left' },
              ]}
            />
          </div>
        </div>
        <p className="mb-1.5 mt-4 text-[13px] font-medium" id="chat-colour">
          Colour
        </p>
        <div
          role="radiogroup"
          aria-labelledby="chat-colour"
          className="flex flex-wrap items-center gap-2.5"
        >
          {SWATCHES.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={draft.accentColor === c}
              aria-label={c}
              onClick={() => set({ accentColor: c })}
              className={cn(
                // A faint edge, so the darkest swatch still shows on a dark card.
                'h-7 w-7 flex-none rounded-full border border-[color-mix(in_oklab,var(--text)_16%,transparent)] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring',
                draft.accentColor === c && 'shadow-[0_0_0_2px_var(--card),0_0_0_4px_var(--text)]',
              )}
              style={{ background: c }}
              data-testid={`chat-colour-${c.slice(1)}`}
            />
          ))}
          <label
            className="relative inline-flex h-7 w-7 flex-none cursor-pointer items-center justify-center rounded-full border border-dashed border-border-strong text-text-3 focus-within:ring-[3px] focus-within:ring-ring"
            title="Any colour"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
            <input
              type="color"
              value={draft.accentColor}
              onChange={(e) => set({ accentColor: e.target.value.toLowerCase() })}
              className="absolute inset-0 cursor-pointer opacity-0"
              aria-label="Any colour"
            />
          </label>
          <span className="ml-1 font-mono text-xs text-text-3" data-testid="chat-colour-value">
            {draft.accentColor}
          </span>
        </div>
        <Hint>
          Text on the colour switches between white and dark by itself, so it’s always readable.
        </Hint>
        <div
          className={cn(
            'mt-3.5 flex items-end gap-3.5 rounded-xl bg-card-2 p-4',
            draft.position === 'left' ? 'flex-row-reverse justify-end' : 'justify-end',
          )}
          aria-hidden
          data-testid="chat-look-preview"
        >
          {draft.greeting.trim() ? (
            <div className="max-w-[250px] rounded-[14px] border border-border bg-card px-3 py-2.5 text-[13.5px] leading-[1.45] text-text shadow-2">
              {draft.greeting}
            </div>
          ) : null}
          <span
            className="inline-flex h-[54px] flex-none items-center gap-2 whitespace-nowrap rounded-full pl-[17px] pr-5 text-[15px] font-semibold shadow-[0_8px_24px_rgba(25,29,37,0.28)]"
            style={{ background: draft.accentColor, color: readableTextOn(draft.accentColor) }}
          >
            <MessageCircle className="h-[22px] w-[22px]" />
            {draft.launcherLabel.trim() || 'Chat with us'}
          </span>
        </div>
      </Card>

      <Card className="p-6" {...settingAttrs('website_chat.away')}>
        <CardTitle>{who ? `When ${who} isn’t answering` : 'When nobody is answering'}</CardTitle>
        <div className="mt-3">
          <Label htmlFor="chat-away">Away message</Label>
          <Textarea
            id="chat-away"
            value={draft.awayMessage}
            onChange={(e) => set({ awayMessage: e.target.value })}
            // What the chat window says when this is left empty.
            placeholder="We’re not answering chats right now. Leave your details and we’ll get back to you."
            maxLength={500}
            invalid={!!errors.awayMessage}
            className="min-h-[72px] text-sm"
            data-testid="chat-away"
          />
          {errors.awayMessage ? (
            <FieldError>{errors.awayMessage}</FieldError>
          ) : (
            <Hint>
              Shown with a short form when {who ? `${who} is off or outside its hours and ` : ''}
              your business is closed.
            </Hint>
          )}
        </div>
        <p className="mt-4 text-[13px] font-medium">What to ask visitors for</p>
        {(['name', 'phone', 'email'] as const).map((field, i) => (
          <SetRow key={field} first={i === 0} center title={ASK_LABELS[field]} className="py-2">
            <Select
              selectSize="sm"
              className="w-[200px]"
              value={draft.askFor[field]}
              onChange={(e) =>
                set({ askFor: { ...draft.askFor, [field]: e.target.value as ChatAskMode } })
              }
              aria-label={`When to ask for their ${ASK_LABELS[field].toLowerCase()}`}
              data-testid={`chat-ask-${field}`}
            >
              {ASK_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </SetRow>
        ))}
        <Hint className="mt-0">
          {who
            ? `“When needed” means ${who} asks only when it has to, like before booking.`
            : '“When needed” means the chat asks after the visitor’s first message, so your team can get back to them.'}
        </Hint>
        <SetRow
          className="mt-2"
          setting="website_chat.text_box"
          title="Offer a box to get texts"
          body={
            <>
              <span className="mt-1 flex items-start gap-2.5 rounded-[10px] bg-card-2 px-3 py-2.5 text-xs leading-[1.5]">
                <span
                  aria-hidden
                  className="mt-0.5 inline-block h-[18px] w-[18px] flex-none rounded-[5px] border border-border-strong bg-card"
                />
                {CONSENT_TEXT}
              </span>
              <span className="text-xs text-text-3">
                The same wording as your booking page. Ticking it never undoes a STOP.
              </span>
            </>
          }
        >
          <Switch
            checked={draft.smsConsent}
            onChange={(smsConsent) => set({ smsConsent })}
            label="Offer a box to get texts"
            testId="chat-sms-consent"
          />
        </SetRow>
        <div className="mt-2 flex items-center justify-end gap-3 border-t border-border pt-4">
          <span className="flex-1 text-xs text-text-3" data-testid="chat-save-note">
            {dirty ? 'Unsaved changes' : 'All changes saved'}
          </span>
          <Button type="submit" size="sm" disabled={!dirty} loading={busy} data-testid="chat-save">
            Save
          </Button>
        </div>
      </Card>
    </form>
  );
}
