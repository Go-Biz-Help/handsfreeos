'use client';
import { ImageOff } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { publicEnv } from '@/lib/env';
import { supabaseBrowser } from '@/lib/supabase/client';

interface Media {
  readonly bucket: string;
  readonly objectPath: string;
  readonly contentType: string;
}

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/**
 * The frame's document. The worker already sanitized the HTML; the frame adds a strict policy: no scripts at
 * all, images only from our storage (inline cid: pictures) until someone asks for remote ones.
 */
function frameDoc(html: string, inline: readonly (string | null)[], remote: boolean): string {
  const storage = new URL(publicEnv.supabaseUrl).origin;
  let body = html.replace(/data-hfos-media="(\d+)"/g, (_, i: string) => {
    const url = inline[Number(i)];
    return url ? `src="${escapeAttr(url)}"` : '';
  });
  if (remote) body = body.replace(/data-remote-src="([^"]*)"/g, 'src="$1"');
  const csp = `default-src 'none'; style-src 'unsafe-inline'; img-src data: ${storage}${remote ? ' https:' : ''}; font-src data:`;
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank">` +
    `<style>html,body{margin:0;background:#fff}body{font:13.5px/1.5 "Hanken Grotesk",system-ui,sans-serif;color:#191d25;overflow-wrap:anywhere}img{max-width:100%;height:auto}</style>` +
    `</head><body>${body}</body></html>`
  );
}

/**
 * A received email's HTML, in a sandboxed frame (never allow-scripts) sized to its content. Email HTML
 * assumes white, so the frame stays white in dark mode too.
 */
export function MailBody({
  html,
  media,
  title,
}: {
  html: string;
  media: readonly Media[];
  title: string;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [remote, setRemote] = useState(false);
  const [inline, setInline] = useState<(string | null)[]>([]);
  const hasRemote = html.includes('data-remote-src=');
  const hasInline = html.includes('data-hfos-media=');

  useEffect(() => {
    if (!hasInline) return;
    let cancelled = false;
    void Promise.all(
      media.map((m) =>
        m.contentType.startsWith('image/')
          ? supabaseBrowser()
              .storage.from(m.bucket)
              .createSignedUrl(m.objectPath, 3600)
              .then(({ data }) => data?.signedUrl ?? null)
          : Promise.resolve(null),
      ),
    ).then((urls) => {
      if (!cancelled) setInline(urls);
    });
    return () => {
      cancelled = true;
    };
  }, [hasInline, media]);

  const doc = useMemo(() => frameDoc(html, inline, remote), [html, inline, remote]);

  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    let observer: ResizeObserver | null = null;
    const fit = () => {
      const d = el.contentDocument;
      if (d) el.style.height = `${d.documentElement.scrollHeight}px`;
    };
    const onLoad = () => {
      fit();
      const d = el.contentDocument;
      if (d && typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(fit);
        observer.observe(d.documentElement);
      }
    };
    el.addEventListener('load', onLoad);
    return () => {
      el.removeEventListener('load', onLoad);
      observer?.disconnect();
    };
  }, [doc]);

  return (
    <div className="flex flex-col gap-1.5">
      {hasRemote && !remote ? (
        <div className="flex items-center gap-1.5 text-xs text-text-3" data-testid="images-hidden">
          <ImageOff className="h-3.5 w-3.5" strokeWidth={1.5} />
          Images are hidden.
          <Button variant="ghost" className="h-6 px-1.5 text-xs" onClick={() => setRemote(true)}>
            Load images
          </Button>
        </div>
      ) : null}
      <div className="overflow-hidden rounded-control bg-white p-3">
        <iframe
          ref={frame}
          title={title}
          sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
          srcDoc={doc}
          className="block h-16 w-full border-0"
        />
      </div>
    </div>
  );
}
