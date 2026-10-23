'use client';
import {
  parseVideoUrl,
  playerHello,
  readPlayerMessage,
  VIDEO_ORIGINS,
  watchedPercent,
  watchedWords,
  watchStart,
  watchTick,
  type WatchState,
} from '@hfos/core';
import { useEffect, useId, useRef, useState } from 'react';

/**
 * A video question: the business's YouTube, Vimeo or Loom video in its own frame, and how much of it they
 * watched handed back as the answer, 0 to 100.
 *
 * We talk to the player's frame by message (core's `playerHello` and `readPlayerMessage`) and never load the
 * provider's script, so nothing of theirs runs on this page. Only messages from that player's own origin are
 * read. The answer only goes up: watching the start again doesn't take back what they already saw.
 */
export function VideoPlayer({
  url,
  title,
  value,
  onChange,
}: {
  url: string;
  title: string;
  value: number | null;
  onChange: (percent: number) => void;
}) {
  const source = parseVideoUrl(url);
  const frame = useRef<HTMLIFrameElement>(null);
  const playerId = useId().replace(/[^a-z0-9]/gi, '');
  const watch = useRef<WatchState>(watchStart(value ?? 0));
  const reported = useRef(value ?? 0);
  const changed = useRef(onChange);
  changed.current = onChange;
  const [origin, setOrigin] = useState<string | null>(null);

  // YouTube only talks to the page it's told about, and that's only known in the browser.
  useEffect(() => setOrigin(window.location.origin), []);

  useEffect(() => {
    if (!source?.tracked) return;
    const host = source.provider;
    const from = VIDEO_ORIGINS[host];
    let heard = false;
    let askedAgain = false;

    function onMessage(event: MessageEvent) {
      if (event.origin !== from || event.source !== frame.current?.contentWindow) return;
      const report = readPlayerMessage(host, event.data);
      if (!report) return;
      // Until it says how long the video is, keep saying hello: a percentage needs the length.
      if (report.duration !== undefined && report.duration > 0) heard = true;
      // A player saying it's ready may have missed the first hello, so ask once more there and then.
      if (report.seconds === undefined && report.duration === undefined) {
        if (!heard && !askedAgain) {
          askedAgain = true;
          hello();
        }
        return;
      }
      watch.current = watchTick(watch.current, report);
      const percent = watchedPercent(watch.current);
      if (percent > reported.current) {
        reported.current = percent;
        changed.current(percent);
      }
    }

    function hello() {
      for (const message of playerHello(host, playerId))
        frame.current?.contentWindow?.postMessage(message, from);
    }

    window.addEventListener('message', onMessage);
    // The frame may not be listening yet when it first loads, so keep saying hello until it answers.
    let tries = 0;
    const timer = window.setInterval(() => {
      if (heard || tries++ > 40) return window.clearInterval(timer);
      hello();
    }, 500);
    return () => {
      window.removeEventListener('message', onMessage);
      window.clearInterval(timer);
    };
  }, [source?.provider, source?.tracked, playerId]);

  if (!source)
    return (
      <p className="rounded-card border border-dashed border-border px-3 py-8 text-center text-[13px] text-text-3">
        The video will show here once it has a YouTube, Vimeo or Loom link.
      </p>
    );

  const src =
    source.provider === 'youtube'
      ? origin
        ? `${source.embedUrl}&origin=${encodeURIComponent(origin)}`
        : null
      : source.embedUrl;

  return (
    <div>
      <div className="relative aspect-video w-full overflow-hidden rounded-card bg-black">
        {src ? (
          <iframe
            ref={frame}
            src={src}
            title={title}
            className="absolute inset-0 h-full w-full"
            allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
            data-testid="video-frame"
          />
        ) : null}
      </div>
      {source.tracked && (value ?? 0) > 0 ? (
        <p className="mt-1.5 text-[12px] text-text-3" data-testid="video-watched">
          {watchedWords(value ?? 0)}
        </p>
      ) : null}
    </div>
  );
}
