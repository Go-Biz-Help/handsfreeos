'use client';
import {
  ABOUT_YOU_ANSWER_MOST,
  ABOUT_YOU_INTERVIEW_WORDS as IW,
  ABOUT_YOU_QUESTIONS,
} from '@hfos/core';
import { Loader2, Mic, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { errorMessage } from '@/lib/api/client';
import { aboutYouWrite } from '@/lib/api/worker';
import { hear } from '@/lib/voice/speech';

/** What a browser records in, best first: the worker reads each. */
const RECORDING_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
];

type Phase = 'answering' | 'listening' | 'hearing' | 'writing';

/**
 * About you's interview (docs/outreach.md, decision 186): one question at a time, answered by typing or out loud (the
 * recording goes to the worker to be written down, as the Assistant's voice mode does), with Back, Skip and Next. At
 * the end the AI writes the box from the answers, keeping what's in it, and hands it back unsaved: the person reads
 * it and presses Save.
 */
export function AboutYouInterview({
  workspaceId,
  about,
  onWritten,
  onClose,
}: {
  workspaceId: string;
  about: string;
  onWritten: (about: string) => void;
  onClose: () => void;
}) {
  const [at, setAt] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [phase, setPhase] = useState<Phase>('answering');
  const recorder = useRef<MediaRecorder | null>(null);
  const q = ABOUT_YOU_QUESTIONS[at]!;
  const last = at === ABOUT_YOU_QUESTIONS.length - 1;
  const answer = answers[q.key] ?? '';
  const busy = phase !== 'answering';

  useEffect(() => document.getElementById('about-you-answer')?.focus(), [at]);
  // Leaving mid-recording lets the microphone go.
  useEffect(
    () => () => {
      const r = recorder.current;
      if (r && r.state !== 'inactive') r.stop();
      r?.stream.getTracks().forEach((t) => t.stop());
    },
    [],
  );

  const setAnswer = (text: string) =>
    setAnswers((a) => ({ ...a, [q.key]: text.slice(0, ABOUT_YOU_ANSWER_MOST) }));

  async function speak() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      toast.error(IW.noMic);
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      toast.error(IW.noMic);
      return;
    }
    const type = RECORDING_TYPES.find((t) => MediaRecorder.isTypeSupported(t));
    const r = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const pieces: Blob[] = [];
    const key = q.key;
    r.ondataavailable = (e) => {
      if (e.data.size) pieces.push(e.data);
    };
    r.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      recorder.current = null;
      const recording = new Blob(pieces, { type: r.mimeType || type || 'audio/webm' });
      if (!recording.size) {
        setPhase('answering');
        return;
      }
      setPhase('hearing');
      hear(workspaceId, recording)
        .then((heard) => {
          if (!heard.text) return;
          // What they said goes after what's typed, for them to fix.
          setAnswers((a) => {
            const before = (a[key] ?? '').trim();
            return {
              ...a,
              [key]: (before ? `${before} ${heard.text}` : heard.text).slice(
                0,
                ABOUT_YOU_ANSWER_MOST,
              ),
            };
          });
        })
        .catch((err) => toast.error(errorMessage(err)))
        .finally(() => setPhase('answering'));
    };
    recorder.current = r;
    r.start();
    setPhase('listening');
  }

  function stopSpeaking() {
    recorder.current?.stop();
  }

  async function finish() {
    const said = ABOUT_YOU_QUESTIONS.map((each) => ({
      key: each.key,
      said: (answers[each.key] ?? '').trim(),
    })).filter((a) => a.said);
    if (!said.length) {
      toast.error(IW.nothing);
      return;
    }
    setPhase('writing');
    try {
      const out = await aboutYouWrite({ workspaceId, answers: said, about: about.trim() });
      onWritten(out.about);
      toast.success(IW.written);
    } catch (err) {
      toast.error(errorMessage(err));
      setPhase('answering');
    }
  }

  return (
    <div
      className="mt-[18px] rounded-card border border-border bg-card-2 p-4"
      data-testid="about-you-interview"
      role="group"
      aria-label={IW.start}
    >
      <p className="text-[12.5px] font-medium text-text-3">
        {IW.of(at + 1, ABOUT_YOU_QUESTIONS.length)}
      </p>
      <Label
        htmlFor="about-you-answer"
        className="mt-1 block text-[15px] font-semibold text-text"
        data-testid="about-you-question"
      >
        {q.ask}
      </Label>
      <p className="mt-0.5 text-[13px] text-text-2">{q.hint}</p>
      <Textarea
        id="about-you-answer"
        className="mt-3"
        value={answer}
        rows={3}
        maxLength={ABOUT_YOU_ANSWER_MOST}
        placeholder={IW.placeholder}
        onChange={(e) => setAnswer(e.target.value)}
        disabled={phase === 'writing'}
        aria-label={IW.answerLabel}
        data-testid="about-you-answer"
      />
      {phase === 'listening' || phase === 'hearing' || phase === 'writing' ? (
        <p
          className="mt-1.5 flex items-center gap-1.5 text-[12.5px] text-text-2"
          aria-live="polite"
        >
          {phase === 'listening' ? (
            <span className="h-2 w-2 animate-pulse rounded-full bg-danger" aria-hidden />
          ) : (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          )}
          {phase === 'listening' ? IW.listening : phase === 'hearing' ? IW.hearing : IW.writing}
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {phase === 'listening' ? (
          <Button
            type="button"
            variant="danger"
            size="sm"
            onClick={stopSpeaking}
            data-testid="about-you-stop"
          >
            <Square className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
            {IW.stop}
          </Button>
        ) : (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => void speak()}
            disabled={busy}
            data-testid="about-you-speak"
          >
            <Mic className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
            {IW.speak}
          </Button>
        )}
        <span className="flex-1" />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setAt((n) => n - 1)}
          disabled={at === 0 || busy}
        >
          {IW.back}
        </Button>
        {last ? (
          <Button
            type="button"
            size="sm"
            onClick={() => void finish()}
            loading={phase === 'writing'}
            disabled={busy && phase !== 'writing'}
            data-testid="about-you-finish"
          >
            {IW.finish}
          </Button>
        ) : (
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setAnswer('');
                setAt((n) => n + 1);
              }}
              disabled={busy}
              data-testid="about-you-skip"
            >
              {IW.skip}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => setAt((n) => n + 1)}
              disabled={busy}
              data-testid="about-you-next"
            >
              {IW.next}
            </Button>
          </>
        )}
      </div>
      <div className="mt-3 border-t border-border pt-2.5">
        <button
          type="button"
          className="text-[12.5px] text-text-3 underline-offset-2 hover:underline disabled:opacity-50"
          onClick={onClose}
          disabled={phase === 'writing'}
          data-testid="about-you-cancel"
        >
          {IW.cancel}
        </button>
      </div>
    </div>
  );
}
