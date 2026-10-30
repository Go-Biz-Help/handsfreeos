'use client';
/**
 * Putting the website chat on a business's site: the snippet, how to paste it on the common site builders, and the
 * install check ("Seen on acme.com 3 min ago"). Settings → Website chat shows them, and so does the texting
 * registration's "Let us collect it for you", whose chat goes in the footer of the business's own site.
 */
import { CircleCheck, Clock } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { apiBrowser, unwrap } from '@/lib/api/client';
import type { ChatWidget } from '@/lib/api/types';
import { cn, relativeTime } from '@/lib/utils';

export const PLATFORMS = [
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

/** The snippet a business pastes: `<script async src="…/embed/v1/<key>.js"></script>`. */
export const snippetOf = (src: string) => `<script async src="${src}"></script>`;

/** Where the snippet loads from: their own domain when one is serving, otherwise this app. */
export const snippetSrc = (origin: string, publicKey: string) =>
  `${origin}/embed/v1/${publicKey}.js`;

export const hostOf = (origin: string | null) => {
  if (!origin) return 'your site';
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

/** The snippet as code, coloured like an editor. */
export function SnippetCode({ src, className }: { src: string; className?: string }) {
  return (
    <pre
      className={cn(
        'whitespace-pre-wrap break-all rounded-[10px] border border-border-strong bg-[#191d25] px-3.5 py-3 font-mono text-[12.5px] leading-[1.65] text-[#e4e8ee]',
        className,
      )}
      data-testid="chat-snippet"
    >
      <code>
        <span className="text-[#8cb8ff]">&lt;script</span>{' '}
        <span className="text-[#f5c97a]">async</span> <span className="text-[#f5c97a]">src</span>=
        <span className="text-[#86e0a8]">&quot;{src}&quot;</span>
        <span className="text-[#8cb8ff]">&gt;&lt;/script&gt;</span>
      </code>
    </pre>
  );
}

/** "How to add it on": a site builder to pick, and its steps. */
export function PlatformSteps({ className }: { className?: string }) {
  const [platform, setPlatform] = useState<(typeof PLATFORMS)[number]['key']>('wordpress');
  const steps = PLATFORMS.find((p) => p.key === platform)?.steps ?? [];
  return (
    <div className={className}>
      <p className="mb-2 text-[13px] font-medium" id="chat-platforms">
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
export function InstallCheck({
  workspaceId,
  widget,
  className = 'mt-4',
}: {
  workspaceId: string;
  widget: Pick<ChatWidget, 'id' | 'install'>;
  className?: string;
}) {
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
        className={cn(
          'flex items-center gap-2.5 rounded-menu bg-success-soft py-1.5 pl-3 pr-1.5 text-[13px] text-success-text',
          className,
        )}
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
      className={cn(
        'flex items-center gap-2.5 rounded-menu bg-card-2 py-1.5 pl-3 pr-1.5 text-[13px] text-text-2',
        className,
      )}
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
