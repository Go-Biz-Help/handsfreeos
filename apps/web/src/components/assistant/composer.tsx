'use client';
import { ASSISTANT_PICTURES_MAX, ASSISTANT_WORDS, VOICE_WORDS } from '@hfos/core';
import { ArrowUp, ImagePlus, Mic, Square, X } from 'lucide-react';
import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from 'react';
import { Button } from '@/components/ui/button';
import { VoiceBar, VoiceError } from '@/components/voice/voice-bar';
import { useMatches } from '@/lib/use-media';
import { cn } from '@/lib/utils';
import { useAssistant } from './assistant-provider';
import { useAssistantVoice } from './voice';
import { answerWaiting } from './waiting';

/** The box when the Assistant can't take questions: not set up, or today's limit is spent. */
function OffComposer({ phone, paused }: { phone: boolean; paused: boolean }) {
  const local = process.env.NODE_ENV === 'development';
  const [text, hint] = paused
    ? [ASSISTANT_WORDS.paused.text, ASSISTANT_WORDS.paused.hint]
    : local
      ? [
          'The Assistant isn’t set up on this computer',
          'Only shows when running HandsFreeOS on your own computer',
        ]
      : [ASSISTANT_WORDS.notAvailable.title, ASSISTANT_WORDS.notAvailable.hint];
  return (
    <div
      className={cn(
        'flex-none border-t border-border bg-card px-2.5 pt-2',
        phone ? 'pb-[calc(env(safe-area-inset-bottom)+10px)]' : 'pb-2.5',
      )}
      data-testid="assistant-composer"
      data-state="off"
    >
      <div className="rounded-card border border-border bg-card-2">
        <div className="min-h-[38px] px-3 pt-[9px] text-[14.5px] leading-[1.45] text-placeholder">
          {text}
        </div>
        <div className="flex items-center gap-1 px-1.5 pb-1.5 pt-1">
          <span className="min-w-0 flex-1 px-1.5 text-xs text-text-3">{hint}</span>
          <Button
            size="icon"
            disabled
            aria-label={ASSISTANT_WORDS.send}
            className="disabled:opacity-45"
          >
            <ArrowUp className="h-3.5 w-3.5" strokeWidth={1.5} />
          </Button>
        </div>
      </div>
    </div>
  );
}

/** The pictures waiting to go with the question, each with a way to take it off. */
function DraftPictures() {
  const a = useAssistant();
  if (!a.draftPictures.length) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-2 px-2.5 pt-2.5"
      data-testid="assistant-pictures"
    >
      {a.draftPictures.map((p, i) => (
        <div key={p.id} className="relative">
          <img
            src={p.preview}
            alt={`Picture ${i + 1}`}
            className="h-14 w-14 rounded-[10px] border border-border object-cover"
          />
          <button
            type="button"
            onClick={() => a.removePicture(p.id)}
            aria-label={`${ASSISTANT_WORDS.pictures.remove} (${i + 1})`}
            title={ASSISTANT_WORDS.pictures.remove}
            className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-border bg-card text-text-2 shadow-sm hover:text-text"
          >
            <X className="h-3 w-3" strokeWidth={2} />
          </button>
        </div>
      ))}
      <span className="min-w-0 flex-1 text-xs text-text-3">{ASSISTANT_WORDS.pictures.hint}</span>
    </div>
  );
}

/**
 * Where the person asks. Return sends where there's a keyboard and a mouse (Shift+Return adds a line); on
 * touch screens Return adds a line and the round button sends. While an answer streams in, Stop replaces Send.
 * The mic talks out loud instead: it listens, answers out loud, and listens again, until it's turned off.
 */
export function AssistantComposer({ phone }: { phone: boolean }) {
  const a = useAssistant();
  const voice = useAssistantVoice();
  const talking = voice.snap.phase !== 'off';
  const fine = useMatches('(pointer: fine)');
  const ref = a.composerRef;
  const off = a.setup === 'missing' || a.paused;
  const pictures = a.draftPictures;
  const canSend = (!!a.draft.trim() || pictures.length > 0) && !a.running;
  const fileRef = useRef<HTMLInputElement | null>(null);
  const full = pictures.length >= ASSISTANT_PICTURES_MAX;
  const [dragging, setDragging] = useState(false);

  // The box grows with the question, up to about six lines.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [a.draft, ref]);

  // With a mouse and keyboard it's ready to type in as soon as the panel opens.
  useEffect(() => {
    if (fine) ref.current?.focus({ preventScroll: true });
  }, [fine, ref]);

  function send() {
    if (!canSend) return;
    const text = a.draft;
    a.setDraft('');
    // With pictures it's a question about them (a form to build from a screenshot), never a yes or no to a card.
    if (pictures.length) {
      a.ask(text, { pictures });
      a.clearPictures();
      return;
    }
    // A plain yes or no answers the cards waiting for an OK, as their buttons do; anything else is a question.
    void answerWaiting(a, text).then((answered) => {
      if (answered === null) a.ask(text);
    });
  }

  // A screenshot pasted into the box goes with the question; pasted words stay words.
  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    void a.addPictures(files);
  }
  const drop = {
    onDragOver: (e: DragEvent<HTMLDivElement>) => {
      if (![...e.dataTransfer.types].includes('Files')) return;
      e.preventDefault();
      setDragging(true);
    },
    onDragLeave: () => setDragging(false),
    onDrop: (e: DragEvent<HTMLDivElement>) => {
      setDragging(false);
      if (!e.dataTransfer.files.length) return;
      e.preventDefault();
      void a.addPictures(e.dataTransfer.files);
    },
  };
  const filePicker = (
    <input
      ref={fileRef}
      type="file"
      accept="image/*"
      multiple
      hidden
      data-testid="assistant-picture-input"
      onChange={(e) => {
        const files = [...(e.target.files ?? [])];
        e.target.value = '';
        void a.addPictures(files);
      }}
    />
  );
  const pictureButton = {
    title: full
      ? ASSISTANT_WORDS.pictures.tooMany(ASSISTANT_PICTURES_MAX)
      : ASSISTANT_WORDS.pictures.add,
    'aria-label': ASSISTANT_WORDS.pictures.add,
    disabled: full,
    onClick: () => fileRef.current?.click(),
    'data-testid': 'assistant-add-picture',
  };

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && fine) {
      e.preventDefault();
      send();
    }
  }

  if (off) return <OffComposer phone={phone} paused={a.paused} />;

  const mic = {
    title: talking ? VOICE_WORDS.stopTalking : VOICE_WORDS.talkTitle,
    'aria-label': talking ? VOICE_WORDS.stopTalking : VOICE_WORDS.talkTitle,
    'aria-pressed': talking,
    onClick: () => void voice.toggle(),
    'data-testid': 'assistant-talk',
  };
  const bar = (
    <VoiceBar
      session={voice.session}
      snap={voice.snap}
      onTalk={voice.talk}
      className="rounded-card border-t-0"
    />
  );

  const box = {
    ref,
    value: a.draft,
    maxLength: 4000,
    onChange: (e: { target: { value: string } }) => a.setDraft(e.target.value),
    onKeyDown,
    onPaste,
    'aria-label': 'Message the Assistant',
    enterKeyHint: fine ? ('send' as const) : ('enter' as const),
  };

  if (phone)
    return (
      <div
        className={cn(
          'flex flex-none flex-col gap-2 border-t border-border bg-card px-2.5 pb-[calc(env(safe-area-inset-bottom)+10px)] pt-2',
          dragging && 'bg-accent-soft',
        )}
        data-testid="assistant-composer"
        {...drop}
      >
        {bar}
        <VoiceError snap={voice.snap} className="px-1.5" />
        <DraftPictures />
        {filePicker}
        <div className="flex items-end gap-1.5">
          <button
            type="button"
            {...pictureButton}
            className="flex h-11 w-11 flex-none items-center justify-center rounded-full border border-border-strong text-text-2 disabled:opacity-45"
          >
            <ImagePlus className="h-[18px] w-[18px]" strokeWidth={1.5} />
          </button>
          <button
            type="button"
            {...mic}
            className={cn(
              'flex h-11 w-11 flex-none items-center justify-center rounded-full border border-border-strong',
              talking ? 'border-accent bg-accent-soft text-accent-text' : 'text-text-2',
            )}
          >
            <Mic className="h-[18px] w-[18px]" strokeWidth={1.5} />
          </button>
          <textarea
            {...box}
            rows={1}
            placeholder={ASSISTANT_WORDS.placeholder.compact}
            className="min-h-11 min-w-0 flex-1 resize-none rounded-[22px] border border-border-strong bg-card px-4 py-[10px] text-base leading-[1.4] text-text placeholder:text-placeholder focus:border-accent focus:outline-none focus:ring-[3px] focus:ring-ring"
          />
          {a.running ? (
            <button
              type="button"
              title="Stop"
              aria-label="Stop"
              onClick={a.stop}
              data-testid="assistant-stop"
              className="flex h-11 w-11 flex-none items-center justify-center rounded-full border border-border-strong text-text-2"
            >
              <Square className="h-3.5 w-3.5" fill="currentColor" strokeWidth={1.5} />
            </button>
          ) : (
            <button
              type="button"
              title="Send"
              aria-label="Send"
              disabled={!canSend}
              onClick={send}
              data-testid="assistant-send"
              className="flex h-11 w-11 flex-none items-center justify-center rounded-full bg-accent text-white disabled:opacity-45"
            >
              <ArrowUp className="h-[18px] w-[18px]" strokeWidth={1.5} />
            </button>
          )}
        </div>
      </div>
    );

  return (
    <div
      className="flex flex-none flex-col gap-1.5 border-t border-border bg-card px-3 pb-3 pt-2.5"
      data-testid="assistant-composer"
      {...drop}
    >
      {bar}
      {filePicker}
      <div
        className={cn(
          'rounded-card border border-border-strong bg-card transition-[border-color,box-shadow] focus-within:border-accent focus-within:ring-[3px] focus-within:ring-ring',
          dragging && 'border-accent bg-accent-soft',
        )}
      >
        <DraftPictures />
        <textarea
          {...box}
          rows={2}
          placeholder={ASSISTANT_WORDS.placeholder.full}
          className="block min-h-[46px] w-full resize-none bg-transparent px-3 pb-0.5 pt-2.5 text-[14.5px] leading-[1.45] text-text placeholder:text-placeholder focus:outline-none"
        />
        <div className="flex items-center gap-1 px-1.5 pb-1.5 pt-1">
          <span className="min-w-0 flex-1 px-1.5 text-xs text-text-3" data-testid="assistant-hint">
            {a.running ? ASSISTANT_WORDS.hintWhileAnswering : ASSISTANT_WORDS.hint}
          </span>
          <Button variant="ghost" size="icon" {...pictureButton}>
            <ImagePlus className="h-3.5 w-3.5" strokeWidth={1.5} />
          </Button>
          <Button
            variant={talking ? 'secondary' : 'ghost'}
            size="icon"
            {...mic}
            className={cn(talking && 'border-accent text-accent-text')}
          >
            <Mic className="h-3.5 w-3.5" strokeWidth={1.5} />
          </Button>
          {a.running ? (
            <Button
              variant="secondary"
              size="icon"
              title="Stop"
              aria-label="Stop"
              onClick={a.stop}
              data-testid="assistant-stop"
            >
              <Square className="h-3.5 w-3.5" fill="currentColor" strokeWidth={1.5} />
            </Button>
          ) : (
            <Button
              size="icon"
              title="Send (Return)"
              aria-label="Send"
              disabled={!canSend}
              onClick={send}
              data-testid="assistant-send"
            >
              <ArrowUp className="h-3.5 w-3.5" strokeWidth={1.5} />
            </Button>
          )}
        </div>
      </div>
      <VoiceError snap={voice.snap} className="px-1" />
    </div>
  );
}
