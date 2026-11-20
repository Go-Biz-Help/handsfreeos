'use client';

/**
 * The ways past a website's security on the texting registration's last step (owner, 2026-11-20): when a row couldn't
 * look at a page because the site showed us a robot check (`PreflightCheck.blocked`), any one of these lets the checks
 * see it, so nothing a reviewer will find is missed and nobody sends twice:
 * 1. **Finish the check on my site.** Opens the site in a new tab with a one-time code; our own chat or form code on it
 *    reads the site's pages from this person's browser (embed/v1/site-check.js), and the checks run again here.
 * 2. **Let HandsFreeOS in** at the host, from the worker's fixed addresses: each host's steps, and a message to copy
 *    for SiteGround's support (core's `robotCheckAllow`). Only once the addresses are set up.
 * 3. **A screenshot** of each page that still won't open: the AI writes it down, and the checks read that.
 * Core's `websites/site-pages.ts` says why.
 */
import { robotCheckAllow, siteHost, type BlockedPage, type PreflightCheck } from '@hfos/core';
import { Camera, Check, Copy, ExternalLink, Loader2, ShieldAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { errorMessage } from '@/lib/api/client';
import { siteCheckStart, siteCheckStatus, siteScreenshot } from '@/lib/api/worker';

/** How often the step asks how the browser check is going, and for how long. */
const POLL_MS = 2000;
const POLL_FOR_MS = 4 * 60 * 1000;
/** Seconds with no page read before the step says our code may not be on the page. */
const QUIET_S = 25;
/** A screenshot's width as sent, and the height of each piece a tall one is cut into. */
const SHOT_WIDTH = 1400;
const SHOT_PIECE = 2000;
const MOST_SHOTS = 4;

export function SiteCheckHelp({
  workspaceId,
  website,
  start,
  urls,
  checks,
  readerIps,
  onRecheck,
}: {
  workspaceId: string;
  /** The website the registration gives. */
  website: string;
  /** The page with our chat or form code on it, to open: the website when not known. */
  start: string | null;
  /** The pages the registration names, for the browser to read first. */
  urls: readonly string[];
  checks: readonly PreflightCheck[];
  /** The fixed addresses our reads come from; empty until set up. */
  readerIps: readonly string[];
  onRecheck: () => void;
}) {
  const blocked = uniqueBlocked(checks);
  if (!blocked.length) return null;
  const host = siteHost(website) ?? website;
  const hosts = [...new Set(blocked.map((b) => b.by))];
  const named = hosts.filter(Boolean);
  return (
    <div
      className="space-y-4 rounded-menu border border-border bg-card p-4"
      data-testid="registration-ways-past"
    >
      <div className="flex items-start gap-2.5">
        <ShieldAlert className="mt-0.5 h-4 w-4 flex-none text-warning-text" aria-hidden />
        <div className="min-w-0">
          <p className="text-[13.5px] font-semibold">Your website’s security stopped our check</p>
          <p className="text-[13px] leading-relaxed text-text-2">
            {blocked.length === 1 ? 'One page' : `${blocked.length} pages`} showed us a robot check
            {named.length ? ` from ${named.join(' and ')}` : ''} instead of{' '}
            {blocked.length === 1 ? 'itself' : 'themselves'}. A reviewer gets past it in their
            browser, so these pages have to be checked too. Any one of these does it.
          </p>
        </div>
      </div>

      <BrowserCheck
        workspaceId={workspaceId}
        website={website}
        start={start}
        urls={[...new Set([...urls, ...blocked.map((b) => b.url)])]}
        onDone={onRecheck}
      />

      {readerIps.length ? (
        <div className="space-y-2 border-t border-border pt-3" data-testid="registration-let-in">
          <p className="text-[13.5px] font-medium">Or let HandsFreeOS in for good</p>
          {hosts.map((by) => {
            const allow = robotCheckAllow(by, { host, ips: readerIps });
            if (!allow) return null;
            return (
              <div key={by ?? 'other'} className="space-y-2">
                <p className="text-[13px] leading-relaxed text-text-2">{allow.steps}</p>
                {allow.message ? <CopyMessage text={allow.message} /> : null}
              </div>
            );
          })}
          <p className="text-[13px] text-text-3">
            Once it’s done, press &ldquo;Check again&rdquo;. It also lets your AI learn every page
            of your site.
          </p>
        </div>
      ) : null}

      <div className="space-y-2 border-t border-border pt-3" data-testid="registration-screenshots">
        <p className="text-[13.5px] font-medium">Or add a screenshot of each page</p>
        <p className="text-[13px] text-text-2">
          Open the page in your browser and take a screenshot, one screen at a time (up to{' '}
          {MOST_SHOTS}). We read what it shows, the way a reviewer would.
        </p>
        {blocked.map((b) => (
          <Screenshot key={b.url} workspaceId={workspaceId} url={b.url} onDone={onRecheck} />
        ))}
      </div>
    </div>
  );
}

/** Every page the rows couldn't look at, once each. */
function uniqueBlocked(checks: readonly PreflightCheck[]): BlockedPage[] {
  const seen = new Map<string, BlockedPage>();
  for (const c of checks) for (const b of c.blocked ?? []) if (!seen.has(b.url)) seen.set(b.url, b);
  return [...seen.values()];
}

type BrowserState =
  | { readonly at: 'idle' }
  | { readonly at: 'starting' }
  | {
      readonly at: 'reading';
      readonly checkId: string;
      readonly open: string;
      /** The tab couldn't be opened for them (a popup blocker): they press the link instead. */
      readonly blockedTab: boolean;
      readonly pages: number;
      readonly since: number;
    }
  | { readonly at: 'done'; readonly pages: number }
  | { readonly at: 'over' };

function BrowserCheck({
  workspaceId,
  website,
  start,
  urls,
  onDone,
}: {
  workspaceId: string;
  website: string;
  start: string | null;
  urls: readonly string[];
  onDone: () => void;
}) {
  const [state, setState] = useState<BrowserState>({ at: 'idle' });
  const [now, setNow] = useState(() => Date.now());
  const done = useRef(onDone);
  done.current = onDone;

  const checkId = state.at === 'reading' ? state.checkId : null;
  useEffect(() => {
    if (!checkId) return;
    const until = Date.now() + POLL_FOR_MS;
    let stop = false;
    const tick = async () => {
      if (stop) return;
      setNow(Date.now());
      try {
        const got = await siteCheckStatus({ workspaceId, checkId });
        if (stop) return;
        if (got.finished) {
          setState({ at: 'done', pages: got.pages });
          done.current();
          return;
        }
        if (got.expired || Date.now() > until) {
          // What it read so far still counts.
          if (got.pages) {
            setState({ at: 'done', pages: got.pages });
            done.current();
          } else setState({ at: 'over' });
          return;
        }
        setState((s) => (s.at === 'reading' ? { ...s, pages: got.pages } : s));
      } catch {
        // A missed answer is asked again next time.
      }
      if (!stop) timer = setTimeout(tick, POLL_MS);
    };
    let timer = setTimeout(tick, POLL_MS);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [checkId, workspaceId]);

  async function begin() {
    // Opened now, while the press still counts, or the browser takes it for a popup; pointed at the site once the
    // code is back.
    const tab = window.open('about:blank', '_blank');
    setState({ at: 'starting' });
    try {
      const got = await siteCheckStart({
        workspaceId,
        website,
        ...(start ? { start } : {}),
        urls: [...urls],
      });
      if (tab) {
        tab.opener = null;
        tab.location.href = got.open;
      }
      setState({
        at: 'reading',
        checkId: got.checkId,
        open: got.open,
        blockedTab: !tab,
        pages: 0,
        since: Date.now(),
      });
    } catch (err) {
      tab?.close();
      toast.error(errorMessage(err));
      setState({ at: 'idle' });
    }
  }

  const quiet = state.at === 'reading' && state.pages === 0 && now - state.since > QUIET_S * 1000;
  return (
    <div className="space-y-2" data-testid="registration-browser-check">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          onClick={() => void begin()}
          disabled={state.at === 'starting' || state.at === 'reading'}
          data-testid="registration-browser-check-start"
        >
          {state.at === 'starting' || state.at === 'reading' ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          )}
          Finish the check on my site
        </Button>
        {state.at === 'reading' && state.blockedTab ? (
          <a
            className="text-[13px] font-medium underline"
            href={state.open}
            target="_blank"
            rel="noreferrer"
          >
            Open your site
          </a>
        ) : null}
      </div>
      <p className="text-[13px] leading-relaxed text-text-2" aria-live="polite">
        {state.at === 'reading'
          ? state.pages
            ? `Reading your site in the other tab: ${state.pages} ${state.pages === 1 ? 'page' : 'pages'} so far. Keep that tab open.`
            : quiet
              ? `Nothing yet. Our chat or form code has to be on ${start ?? website} for this to work. If it isn’t, use one of the other ways below.`
              : 'Your site opened in a new tab. Our code on it is reading your pages from your own browser.'
          : state.at === 'done'
            ? `Read ${state.pages} ${state.pages === 1 ? 'page' : 'pages'} in your browser. The check runs again with them.`
            : state.at === 'over'
              ? 'The other tab didn’t send anything. Make sure our chat or form code is on your site, then try again, or use one of the other ways below.'
              : 'Opens your site in a new tab. Our chat or form code on it reads your pages from your own browser, where your website’s security already knows you, and the check carries on here.'}
      </p>
    </div>
  );
}

function CopyMessage({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-control border border-border bg-card-2 p-3">
      <p className="text-[13px] leading-relaxed text-text-2">{text}</p>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="mt-2"
        onClick={() => {
          void navigator.clipboard
            ?.writeText(text)
            .then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            })
            .catch(() => toast.error('Couldn’t copy. Select the words and copy them instead.'));
        }}
      >
        {copied ? (
          <Check className="h-3.5 w-3.5" aria-hidden />
        ) : (
          <Copy className="h-3.5 w-3.5" aria-hidden />
        )}
        {copied ? 'Copied' : 'Copy message'}
      </Button>
    </div>
  );
}

function Screenshot({
  workspaceId,
  url,
  onDone,
}: {
  workspaceId: string;
  url: string;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  async function send(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    try {
      const images: string[] = [];
      for (const file of Array.from(files)) {
        if (images.length >= MOST_SHOTS) break;
        images.push(...(await screenshotPieces(file, MOST_SHOTS - images.length)));
      }
      await siteScreenshot({ workspaceId, url, images });
      toast.success('Screenshot read. Checking again.');
      onDone();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={busy}
        onClick={() => input.current?.click()}
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        ) : (
          <Camera className="h-3.5 w-3.5" aria-hidden />
        )}
        {busy ? 'Reading…' : 'Add a screenshot'}
      </Button>
      <span className="min-w-0 flex-1 text-[13px] text-text-3 [overflow-wrap:anywhere]">{url}</span>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        hidden
        onChange={(e) => void send(e.target.files)}
      />
    </div>
  );
}

/**
 * A screenshot as JPEGs the AI reads well: no wider than a screen, and a tall one (a whole page) cut into pieces from
 * the top, at most `most` of them.
 */
async function screenshotPieces(file: File, most: number): Promise<string[]> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, SHOT_WIDTH / bitmap.width);
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const pieces: string[] = [];
  for (let top = 0; top < height && pieces.length < most; top += SHOT_PIECE) {
    const h = Math.min(SHOT_PIECE, height - top);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) break;
    ctx.drawImage(bitmap, 0, top / scale, bitmap.width, h / scale, 0, 0, width, h);
    pieces.push(canvas.toDataURL('image/jpeg', 0.85).replace(/^data:image\/jpeg;base64,/, ''));
  }
  bitmap.close();
  if (!pieces.length)
    throw new Error('That picture couldn’t be opened. Take the screenshot again.');
  return pieces;
}
