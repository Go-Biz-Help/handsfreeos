'use client';
import { Grip, Mic, MicOff, Pencil, Phone, Video } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { VIDEO_CALL_WORDS } from '@hfos/core';
import { AddonSlot } from '@/components/addons/slot';
import { LogActivitySheet } from '@/components/timeline/log-activity-sheet';
import { Avatar } from '@/components/ui/avatar';
import { useCanStartVideoCall, useStartVideoCall } from '@/components/video-call/start-call';
import { useCalls, type CallView } from '@/lib/calls/call-provider';
import { clock } from '@/lib/calls/format';
import { cn } from '@/lib/utils';

type LiveView = Extract<CallView, { phase: 'calling' | 'active' }>;

const KEYS: readonly (readonly [string, string])[] = [
  ['1', ''],
  ['2', 'ABC'],
  ['3', 'DEF'],
  ['4', 'GHI'],
  ['5', 'JKL'],
  ['6', 'MNO'],
  ['7', 'PQRS'],
  ['8', 'TUV'],
  ['9', 'WXYZ'],
  ['*', ''],
  ['0', '+'],
  ['#', ''],
];

function BarButton({
  label,
  onClick,
  tone,
  pressed,
  disabled,
  testId,
  children,
}: {
  label: string;
  onClick: () => void;
  tone?: 'on' | 'end';
  pressed?: boolean;
  disabled?: boolean;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      data-testid={testId}
      className={cn(
        'flex h-9 w-9 flex-none items-center justify-center rounded-full p-0 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring disabled:opacity-50',
        tone === 'end'
          ? 'bg-danger text-on-solid'
          : tone === 'on'
            ? 'bg-warning text-on-solid'
            : 'bg-[color-mix(in_oklab,var(--toast-text)_14%,transparent)] text-inherit',
      )}
    >
      {children}
    </button>
  );
}

/** Tones for phone menus ("press 2 for service"); the digits typed so far show on top. */
function Keypad({ onDigit }: { onDigit: (digit: string) => void }) {
  const [typed, setTyped] = useState('');
  const press = (digit: string) => {
    onDigit(digit);
    setTyped((t) => (t + digit).slice(-16));
  };
  // The keyboard works too, except while typing somewhere else.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)))
        return;
      if (/^[0-9*#]$/.test(e.key)) press(e.key);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  return (
    <div
      data-testid="call-keypad"
      style={{ pointerEvents: 'auto' }}
      className="fixed bottom-[84px] left-1/2 z-[66] w-[232px] -translate-x-1/2 rounded-[12px] border border-border bg-card p-3 shadow-2 max-md:bottom-[calc(148px+env(safe-area-inset-bottom))]"
    >
      <div
        className="mb-2 h-5 truncate text-center font-mono text-[15px] tabular-nums text-text-2"
        aria-live="polite"
      >
        {typed}
      </div>
      <div className="grid grid-cols-3 gap-2">
        {KEYS.map(([digit, letters]) => (
          <button
            key={digit}
            type="button"
            onClick={() => press(digit)}
            aria-label={digit === '*' ? 'Star' : digit === '#' ? 'Pound' : digit}
            className="flex h-[50px] flex-col items-center justify-center rounded-[10px] border border-border bg-card hover:bg-card-2"
          >
            <span className="text-[19px] font-medium leading-none text-text">{digit}</span>
            {letters ? (
              <small className="mt-[3px] text-[9.5px] font-semibold tracking-[.14em] text-text-3">
                {letters}
              </small>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}

function LiveBar({ view }: { view: LiveView }) {
  const calls = useCalls();
  const [keypad, setKeypad] = useState(false);
  const [note, setNote] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!view.startedAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [view.startedAt]);
  const connected = view.phase === 'active';
  const elapsed = view.startedAt ? Math.max(0, Math.floor((now - view.startedAt) / 1000)) : 0;
  const status =
    view.phase === 'calling' ? 'Calling…' : `${clock(elapsed)}${view.muted ? ' · muted' : ''}`;
  const personId = view.party.personId;
  // Switch to video (docs/video-calls.md, part 5): texts the customer their link and opens the call; the phone call
  // keeps going until you hang up, so nobody is left in silence while they find the link.
  const canVideo = useCanStartVideoCall() && !!personId;
  const video = useStartVideoCall(calls.workspaceId);
  return (
    <>
      {keypad && connected ? <Keypad onDigit={calls.sendDigit} /> : null}
      {connected && !keypad ? (
        // What add-ons show the person on the call (Sales Coach's cards), just above the bar.
        <div
          data-testid="call-panels"
          style={{ pointerEvents: 'auto' }}
          className="fixed bottom-[76px] left-1/2 z-[64] w-[min(440px,calc(100vw-32px))] -translate-x-1/2 empty:hidden max-md:bottom-[calc(144px+env(safe-area-inset-bottom))]"
        >
          <AddonSlot name="call.panels" workspaceId={calls.workspaceId} personId={personId} />
        </div>
      ) : null}
      <div
        role="region"
        aria-label="Call in progress"
        data-testid="call-bar"
        style={{ pointerEvents: 'auto' }}
        className="fixed bottom-5 left-1/2 z-[65] flex -translate-x-1/2 items-center gap-3 whitespace-nowrap rounded-dialog bg-toast-bg py-2 pl-3 pr-2 text-toast-text shadow-3 max-md:bottom-[calc(84px+env(safe-area-inset-bottom))]"
      >
        <Avatar name={view.party.name} seed={personId ?? view.party.phone} size="sm" />
        <div className="min-w-[110px] leading-tight">
          <div className="max-w-[160px] truncate text-[13px] font-medium">{view.party.name}</div>
          <div className="font-mono text-[13px] tabular-nums opacity-75" data-testid="call-status">
            {status}
          </div>
        </div>
        <BarButton
          label={view.muted ? 'Unmute' : 'Mute'}
          tone={view.muted ? 'on' : undefined}
          pressed={view.muted}
          disabled={!connected}
          onClick={calls.toggleMute}
          testId="call-mute"
        >
          {view.muted ? (
            <MicOff className="h-3.5 w-3.5" strokeWidth={1.75} />
          ) : (
            <Mic className="h-3.5 w-3.5" strokeWidth={1.75} />
          )}
        </BarButton>
        <BarButton
          label="Keypad"
          pressed={keypad}
          disabled={!connected}
          onClick={() => setKeypad((k) => !k)}
          testId="call-keypad-toggle"
        >
          <Grip className="h-3.5 w-3.5" strokeWidth={1.75} />
        </BarButton>
        {canVideo && personId ? (
          <BarButton
            label={VIDEO_CALL_WORDS.switchToVideo}
            disabled={!connected || video.busy}
            onClick={() =>
              void video.start({ personId, channel: 'sms' }, { after: VIDEO_CALL_WORDS.switchHint })
            }
            testId="call-switch-to-video"
          >
            <Video className="h-3.5 w-3.5" strokeWidth={1.75} />
          </BarButton>
        ) : null}
        {personId ? (
          <BarButton label="Add a note to this call" onClick={() => setNote(true)}>
            <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} />
          </BarButton>
        ) : null}
        <BarButton label="Hang up" tone="end" onClick={calls.hangUp} testId="call-hang-up">
          <Phone className="h-3.5 w-3.5 rotate-[135deg]" strokeWidth={1.75} />
        </BarButton>
      </div>
      {personId ? (
        <LogActivitySheet
          workspaceId={calls.workspaceId}
          open={note}
          onOpenChange={setNote}
          kind="note"
          recordName={view.party.name}
          record={{ personId }}
        />
      ) : null}
    </>
  );
}

/**
 * The call bar: who, how long, mute, keypad, switch to video, a note, hang up. It lives in the workspace layout, so the
 * call keeps going while people move between pages.
 */
export function ActiveCallBar() {
  const { view } = useCalls();
  if (view.phase !== 'calling' && view.phase !== 'active') return null;
  return createPortal(<LiveBar view={view} />, document.body);
}
