'use client';
/**
 * A video link's page (/v/<token>, 20261018000200): the customer picks or records a video on their phone and it
 * goes up as it is, at full quality, straight to Storage, then lands in the business's conversation with them as
 * their reply. MMS squeezes a texted video to almost nothing; this is the way round it.
 *
 * Loaded from the customer's browser, so the worker's per-address limits count per customer. Opening the page
 * changes nothing; only picking a video does.
 */
import { VIDEO_LINK_WORDS } from '@hfos/core';
import { CircleCheck, Clock, Link2Off, Video } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { PublicFrame, PublicState } from '@/components/booking/public-shell';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api/errors';
import {
  finishVideoUpload,
  getVideoLink,
  putVideo,
  startVideoUpload,
  type VideoLinkView,
} from '@/lib/api/public-video';

type State =
  | { kind: 'loading' }
  | { kind: 'missing'; message: string }
  | { kind: 'ready'; view: VideoLinkView }
  | { kind: 'sending'; view: VideoLinkView; percent: number }
  | { kind: 'sent'; view: VideoLinkView }
  | { kind: 'failed'; view: VideoLinkView; message: string; file: File | null };

const wordsOf = (e: unknown) =>
  e instanceof ApiError ? e.message : 'Something went wrong. Please try again.';

/** What a link that takes nothing more is called, by why. */
const STOPPED_TITLE: Readonly<Record<string, string>> = {
  link_expired: 'This link has run out',
  link_full: 'This link is full',
};

export function VideoUploadPage({ token }: { token: string }) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const input = useRef<HTMLInputElement>(null);
  const honeypot = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    getVideoLink(token).then(
      (view) => live && setState({ kind: 'ready', view }),
      (e: unknown) => live && setState({ kind: 'missing', message: wordsOf(e) }),
    );
    return () => {
      live = false;
    };
  }, [token]);

  async function send(view: VideoLinkView, file: File) {
    // Something a person never fills in: a robot gets a page that never sends anything.
    if (honeypot.current?.value) return;
    setState({ kind: 'sending', view, percent: 0 });
    try {
      const start = await startVideoUpload(token, file);
      await putVideo(start.uploadUrl, file, (percent) =>
        setState({ kind: 'sending', view, percent }),
      ).done;
      await finishVideoUpload(token, start, file);
      setState({ kind: 'sent', view: { ...view, received: view.received + 1 } });
    } catch (e) {
      // A refusal that's about the file (not a video, too big) needs another one, not the same one again.
      const sameAgain = !(e instanceof ApiError && e.status >= 400 && e.status < 500);
      setState({ kind: 'failed', view, message: wordsOf(e), file: sameAgain ? file : null });
    }
  }

  const pick = (view: VideoLinkView) => {
    const file = input.current?.files?.[0];
    if (input.current) input.current.value = '';
    if (file) void send(view, file);
  };

  if (state.kind === 'loading')
    return (
      <PublicFrame business={null}>
        <div className="flex-1" aria-busy />
      </PublicFrame>
    );
  if (state.kind === 'missing')
    return (
      <PublicFrame business={null}>
        <PublicState
          icon={<Link2Off size={20} />}
          title="This link doesn’t work"
          testId="video-link-missing"
        >
          {state.message}
        </PublicState>
      </PublicFrame>
    );

  const { view } = state;
  if (state.kind === 'ready' && view.problem)
    return (
      <PublicFrame business={null}>
        <PublicState
          tone="warning"
          icon={<Clock size={20} />}
          title={STOPPED_TITLE[view.problem.rule] ?? 'This link doesn’t work'}
          testId="video-link-stopped"
        >
          {view.problem.message}
        </PublicState>
      </PublicFrame>
    );

  const chooser = (label: string) => (
    <>
      <input
        ref={input}
        type="file"
        accept="video/*"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={() => pick(view)}
        data-testid="video-link-file"
      />
      <input
        ref={honeypot}
        name="website"
        type="text"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden
        className="absolute -left-[9999px] h-px w-px opacity-0"
      />
      <Button
        onClick={() => input.current?.click()}
        className="h-12 px-6 text-[15px]"
        data-testid="video-link-choose"
      >
        <Video className="h-[18px] w-[18px]" strokeWidth={1.5} />
        {label}
      </Button>
    </>
  );

  if (state.kind === 'sent') {
    const room = view.received < view.maxUploads;
    return (
      <PublicFrame business={null}>
        <PublicState
          tone="success"
          icon={<CircleCheck size={20} />}
          title={VIDEO_LINK_WORDS.sent(view.business)}
          testId="video-link-sent"
          action={room ? chooser(VIDEO_LINK_WORDS.another) : undefined}
        />
      </PublicFrame>
    );
  }

  if (state.kind === 'sending')
    return (
      <PublicFrame business={null}>
        <PublicState
          tone="accent"
          icon={<Video size={20} />}
          title={VIDEO_LINK_WORDS.sending(state.percent)}
          testId="video-link-sending"
          action={
            <div
              className="h-2 w-64 max-w-full overflow-hidden rounded-full bg-card-3"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={state.percent}
            >
              <div
                className="h-full rounded-full bg-accent transition-[width]"
                style={{ width: `${state.percent}%` }}
              />
            </div>
          }
        >
          {VIDEO_LINK_WORDS.note}
        </PublicState>
      </PublicFrame>
    );

  return (
    <PublicFrame business={null}>
      <PublicState
        tone="accent"
        icon={<Video size={20} />}
        title={VIDEO_LINK_WORDS.heading(view.business)}
        testId="video-link-ready"
        action={
          <div className="flex flex-col items-center gap-3">
            {state.kind === 'failed' && state.file ? (
              <Button
                onClick={() => void send(view, state.file!)}
                className="h-12 px-6 text-[15px]"
                data-testid="video-link-retry"
              >
                {VIDEO_LINK_WORDS.tryAgain}
              </Button>
            ) : (
              chooser(VIDEO_LINK_WORDS.choose)
            )}
            {state.kind === 'failed' ? (
              <p className="max-w-sm text-[13px] text-danger-text" role="alert">
                {state.message}
              </p>
            ) : (
              <p className="text-[13px] text-text-3">{VIDEO_LINK_WORDS.note}</p>
            )}
          </div>
        }
      >
        {VIDEO_LINK_WORDS.intro}
      </PublicState>
    </PublicFrame>
  );
}
