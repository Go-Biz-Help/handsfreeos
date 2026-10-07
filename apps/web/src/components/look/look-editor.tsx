'use client';
/**
 * The business's logo and colour (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §4), as the setup's
 * "Your logo and colour" screen and Settings → Workspace show them. Each change is kept at once by core's look
 * commands; the page around it brings the look again (`onChanged`).
 *
 * - The logo is found on the website when it's saved: while the worker looks, or makes an uploaded picture ready,
 *   this says so and asks again every few seconds, in case live updates are down.
 * - An upload goes straight to Storage at the place `look.begin_upload` reserved, then to the worker. A picture it
 *   can't use comes back as a problem, said here.
 * - The colour comes from the logo until someone picks one: six swatches, "Any colour", and a preview of a page.
 */
import {
  isWideLogo,
  LOOK_DEFAULT_COLOR,
  LOOK_SWATCHES,
  LOOK_WAIT_MS,
  LOOK_WORDS as L,
  lookProgressOf,
  type BusinessLook,
} from '@hfos/core';
import { ImageUp, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { toast } from 'sonner';
import { Callout } from '@/components/ai-team/parts';
import { Button, buttonClassName } from '@/components/ui/button';
import { FieldError, Hint } from '@/components/ui/field';
import { errorMessage } from '@/lib/api/client';
import { brandLook, logoSrc } from '@/lib/look';
import { LOOK_ACCEPT, lookActions } from '@/lib/look-actions';
import { cn } from '@/lib/utils';
import { BusinessMark, type ShownLogo } from './business-mark';

/** While the logo is looked for or made ready, the page is asked again this often. */
const POLL_MS = 4_000;
/** "Any colour" keeps the colour once the picker has stopped moving for this long. */
const PICK_MS = 500;

type Busy = 'upload' | 'remove' | 'find' | null;

export function LookEditor({
  workspaceId,
  look,
  businessName,
  website,
  canChange,
  onChanged,
}: {
  workspaceId: string;
  look: BusinessLook;
  businessName: string;
  /** The business's website, for "Look on … again"; null when it has none. */
  website: string | null;
  canChange: boolean;
  /** Bring the look again, after a change here or while waiting on the worker. */
  onChanged: () => void;
}) {
  const actions = useMemo(() => lookActions(workspaceId), [workspaceId]);
  // What a change here gave back, until the page brings the look again.
  const [given, setGiven] = useState<{ from: BusinessLook; look: BusinessLook } | null>(null);
  const shown = given && given.from === look ? given.look : look;
  /** The colour picked here, over the one kept then: it's shown until the page brings another. */
  const [picked, setPicked] = useState<{ hex: string; over: string | null } | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const file = useRef<HTMLInputElement>(null);
  const pickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const progress = lookProgressOf(shown, new Date(now));
  const waiting = progress !== 'idle';
  const kept = shown.color?.hex ?? null;
  const pickedHex = picked && picked.over === kept ? picked.hex : null;
  const color = pickedHex ?? kept ?? LOOK_DEFAULT_COLOR;

  // While the worker looks or makes the logo ready: ask again, and stop saying so once it's been long enough.
  const ask = useRef(onChanged);
  ask.current = onChanged;
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      ask.current();
    }, POLL_MS);
    const stop = setTimeout(() => setNow(Date.now()), LOOK_WAIT_MS);
    return () => {
      clearInterval(timer);
      clearTimeout(stop);
    };
  }, [waiting]);

  // "Logo saved" when the logo the worker was making arrives.
  const made = useRef<{ making: boolean; path: string | null }>({
    making: false,
    path: shown.logo?.path ?? null,
  });
  useEffect(() => {
    const path = shown.logo?.path ?? null;
    if (made.current.making && progress !== 'making' && path && path !== made.current.path)
      toast.success(L.logoReady, { id: 'look-logo' });
    made.current = { making: progress === 'making', path };
  }, [progress, shown.logo?.path]);

  useEffect(
    () => () => {
      if (pickTimer.current) clearTimeout(pickTimer.current);
    },
    [],
  );

  async function run(kind: Exclude<Busy, null>, act: () => Promise<BusinessLook>, done?: string) {
    setBusy(kind);
    setError(null);
    try {
      setGiven({ from: look, look: await act() });
      setNow(Date.now());
      if (done) toast.success(done, { id: 'look-logo' });
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  function upload(files: FileList | null) {
    const picture = files?.[0];
    if (!picture || busy) return;
    void run('upload', () => actions.upload(picture));
  }

  async function keepColor(hex: string) {
    setError(null);
    try {
      const next = await actions.setColor(hex);
      setGiven({ from: look, look: next });
      toast.success(L.saved, { id: 'look-colour' });
      onChanged();
    } catch (e) {
      setPicked(null);
      setError(errorMessage(e));
    }
  }

  function pick(hex: string, wait: boolean) {
    // Picked already: nothing to keep.
    if (hex === color && shown.color?.from === 'person') return;
    setPicked({ hex, over: kept });
    if (pickTimer.current) clearTimeout(pickTimer.current);
    if (wait) pickTimer.current = setTimeout(() => void keepColor(hex), PICK_MS);
    else void keepColor(hex);
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setOver(false);
    if (canChange) upload(e.dataTransfer.files);
  }

  const logo: ShownLogo | null = shown.logo
    ? { url: logoSrc(shown.logo.path), width: shown.logo.width, height: shown.logo.height }
    : null;
  // A problem with an upload newer than the logo kept: the old logo stays, and this says why the new one didn't.
  const problem =
    shown.problem && progress !== 'making' && (!shown.logo || shown.problem.at > shown.logo.at)
      ? shown.problem.message
      : null;
  const notFound =
    !shown.logo && progress === 'idle' && shown.searched && !shown.searched.found
      ? shown.searched.url
      : null;
  const swatches = [
    ...(kept && !(LOOK_SWATCHES as readonly string[]).includes(kept) ? [kept] : []),
    ...LOOK_SWATCHES,
  ];
  const brand = brandLook(color);

  const status = (() => {
    if (progress === 'making') return <Working>{L.making}</Working>;
    if (progress === 'searching')
      return <Working>{L.searching(shown.asked?.url ?? website ?? '')}</Working>;
    if (shown.logo)
      return (
        <p className="text-[13.5px] text-text-2" data-testid="look-logo-from">
          {shown.logo.from === 'website' && shown.searched
            ? L.fromSite(shown.searched.url)
            : L.uploaded}
        </p>
      );
    return (
      <p className="text-[13.5px] text-text-2" data-testid="look-no-logo">
        {notFound ? L.notFound(notFound) : L.noLogo}
      </p>
    );
  })();

  return (
    <div className="flex flex-col gap-6" data-testid="look-editor">
      {canChange ? null : <Callout>{L.cantChange}</Callout>}

      <section aria-labelledby="look-logo" className="flex flex-col gap-2">
        <h3 id="look-logo" className="text-[13px] font-medium">
          {L.logo}
        </h3>
        <div
          onDragOver={(e) => {
            if (!canChange) return;
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
          className={cn(
            'flex flex-wrap items-center gap-4 rounded-card border bg-card p-4 transition-colors',
            over ? 'border-accent bg-accent-soft' : 'border-border',
          )}
          data-testid="look-logo-box"
        >
          <span
            className={cn(
              'inline-flex h-[72px] min-w-[72px] flex-none items-center justify-center rounded-[12px]',
              logo && 'border border-border bg-white px-2',
            )}
            style={brand.style}
          >
            <BusinessMark
              name={businessName}
              logo={logo}
              size={logo ? 64 : 72}
              className={brand.className}
            />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-2.5">
            {status}
            {canChange ? (
              <div className="flex flex-wrap items-center gap-2">
                <input
                  ref={file}
                  type="file"
                  accept={LOOK_ACCEPT}
                  className="sr-only"
                  aria-label={L.upload}
                  data-testid="look-file"
                  onChange={(e) => {
                    upload(e.target.files);
                    e.target.value = '';
                  }}
                />
                <Button
                  variant={shown.logo ? 'secondary' : 'primary'}
                  size="sm"
                  onClick={() => file.current?.click()}
                  loading={busy === 'upload'}
                  disabled={!!busy || progress === 'making'}
                  data-testid="look-upload"
                >
                  <ImageUp className="h-4 w-4" strokeWidth={1.75} />
                  {shown.logo ? L.change : L.upload}
                </Button>
                {shown.logo ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void run('remove', actions.removeLogo, L.removed)}
                    loading={busy === 'remove'}
                    disabled={!!busy}
                    data-testid="look-remove"
                  >
                    <Trash2 className="h-4 w-4" strokeWidth={1.75} />
                    {L.remove}
                  </Button>
                ) : website && progress === 'idle' ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void run('find', actions.find)}
                    loading={busy === 'find'}
                    disabled={!!busy}
                    data-testid="look-find"
                  >
                    <RefreshCw className="h-4 w-4" strokeWidth={1.75} />
                    {L.findAgain(website)}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
        {problem ? (
          <Callout tone="danger" testId="look-problem">
            {problem}
          </Callout>
        ) : canChange ? (
          <Hint className="mt-0">{L.uploadHint}</Hint>
        ) : null}
      </section>

      <section aria-labelledby="look-colour" className="flex flex-col gap-2">
        <h3 id="look-colour" className="text-[13px] font-medium">
          {L.color}
        </h3>
        <div
          role="radiogroup"
          aria-labelledby="look-colour"
          className="flex flex-wrap items-center gap-2.5"
        >
          {swatches.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={color === c}
              aria-label={L.pickColor(c)}
              disabled={!canChange}
              onClick={() => pick(c, false)}
              className={cn(
                // A faint edge, so the darkest swatch still shows on a dark card.
                'h-8 w-8 flex-none rounded-full border border-[color-mix(in_oklab,var(--text)_16%,transparent)] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring disabled:cursor-not-allowed',
                color === c && 'shadow-[0_0_0_2px_var(--card),0_0_0_4px_var(--text)]',
              )}
              style={{ background: c }}
              data-testid={`look-colour-${c.slice(1)}`}
            />
          ))}
          {canChange ? (
            <label
              className="relative inline-flex h-8 w-8 flex-none cursor-pointer items-center justify-center rounded-full border border-dashed border-border-strong text-text-3 focus-within:ring-[3px] focus-within:ring-ring"
              title={L.anyColor}
            >
              <Plus className="h-3.5 w-3.5" aria-hidden />
              <input
                type="color"
                value={color}
                onChange={(e) => pick(e.target.value.toLowerCase(), true)}
                className="absolute inset-0 cursor-pointer opacity-0"
                aria-label={L.anyColor}
                data-testid="look-colour-any"
              />
            </label>
          ) : null}
          <span className="ml-1 font-mono text-xs text-text-3" data-testid="look-colour-value">
            {color}
          </span>
          {shown.color && shown.color.from !== 'person' && !pickedHex ? (
            <span className="text-xs text-text-3" data-testid="look-colour-from">
              {shown.color.from === 'logo' ? L.fromLogo : L.fromWebsite}
            </span>
          ) : null}
        </div>
        <Hint className="mt-0">{L.colorHint}</Hint>
      </section>

      <section aria-labelledby="look-preview" className="flex flex-col gap-2">
        <h3 id="look-preview" className="text-[13px] font-medium">
          {L.preview}
        </h3>
        <div
          aria-hidden
          className={cn('overflow-hidden rounded-card border border-border bg-bg', brand.className)}
          style={brand.style}
          data-testid="look-preview"
        >
          <div className="flex items-center gap-2.5 border-b border-border bg-card px-3.5 py-2.5">
            <BusinessMark name={businessName} logo={logo} size={32} />
            <span className={cn('truncate text-[14px] font-medium', isWideLogo(logo) && 'sr-only')}>
              {businessName}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2 p-3.5">
            <span className="inline-flex h-8 items-center rounded-control border border-accent bg-accent-soft px-2.5 text-[13px] font-medium text-accent-text">
              9:00 AM
            </span>
            <span className="inline-flex h-8 items-center rounded-control border border-border bg-card px-2.5 text-[13px] text-text-2">
              10:30 AM
            </span>
            <span className={buttonClassName({ size: 'sm', className: 'ml-auto' })}>
              {L.previewButton}
            </span>
          </div>
        </div>
      </section>

      <FieldError>{error}</FieldError>
    </div>
  );
}

function Working({ children }: { children: string }) {
  return (
    <p className="flex items-center gap-2 text-[13.5px] text-text-2" data-testid="look-working">
      <Loader2 className="h-4 w-4 flex-none animate-spin" strokeWidth={2} />
      {children}
    </p>
  );
}
