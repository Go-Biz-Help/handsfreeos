import { fmtAt } from '@hfos/core';
import {
  clockOfSeconds,
  CONTRACTOR_PHONE_WORDS as P,
} from '@hfos/core/addons/contractor/phone-words';
import type { PhoneNote } from '@hfos/core/addons/contractor/views/phone';
import { CONTRACTOR_WORDS as W } from '@hfos/core/addons/contractor/words';
import * as React from 'react';
import { View } from 'react-native';

import { Camera, CloudOff, Mic, Pencil } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { LEVEL_BARS, useVoiceNoteRecorder } from '@/lib/voice-note-recorder';
import { useNetwork } from '@/lib/network';
import { cn } from '@/lib/utils';

import { SectionLabel } from './kit';

/**
 * Notes from the field on the phone: what the crew typed, said or photographed on the job, the newest first, and the
 * three ways to add one. A voice note's words follow on their own once its recording reaches HandsFreeOS. Each waits
 * with no signal. Photos and recordings themselves open on the web.
 */

export interface NoteActions {
  /** Each resolves true once the note is kept (or is waiting on this phone). */
  addTyped(body: string): Promise<boolean>;
  addPhoto(): Promise<boolean>;
  addVoice(recording: { readonly uri: string; readonly seconds: number }): Promise<boolean>;
  /** Takes a note off: with signal only. */
  remove(note: PhoneNote): Promise<boolean>;
}

export function NotesCard({
  title,
  none,
  notes,
  truncated,
  photosOf,
  waiting,
  jobName,
  timeZone,
  me,
  removeAny,
  actions,
}: {
  title: string;
  none: string;
  notes: readonly PhoneNote[];
  truncated: boolean;
  /** How many photos each note was taken with, the ones still uploading among them. */
  photosOf: ReadonlyMap<string, number>;
  /** Notes of the person's still on this phone. */
  waiting: ReadonlySet<string>;
  jobName: string;
  timeZone: string;
  me: string;
  /** Sets the add-on up here, so may take anyone's note off. */
  removeAny: boolean;
  actions: NoteActions;
}) {
  const { online } = useNetwork();
  const [typing, setTyping] = React.useState(false);
  const [speaking, setSpeaking] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  return (
    <View className="gap-1.5" testID="co-notes">
      <SectionLabel>{title}</SectionLabel>
      <View className="flex-row gap-2">
        <Button
          variant="secondary"
          size="md"
          icon={Pencil}
          className="flex-1"
          onPress={() => setTyping(true)}
          testID="co-note-type"
        >
          {P.notes.type}
        </Button>
        <Button
          variant="secondary"
          size="md"
          icon={Camera}
          loading={busy === 'photo'}
          accessibilityLabel={P.notes.photo}
          onPress={async () => {
            setBusy('photo');
            await actions.addPhoto();
            setBusy(null);
          }}
          testID="co-note-photo"
        >
          {P.notes.photo}
        </Button>
        <Button
          variant="secondary"
          size="md"
          icon={Mic}
          accessibilityLabel={P.notes.voice}
          onPress={() => setSpeaking(true)}
          testID="co-note-voice"
        >
          {P.notes.voice}
        </Button>
      </View>
      {notes.length === 0 ? (
        <Card className="px-3.5 py-3">
          <Text className="text-[13.5px] text-text-2" testID="co-notes-none">
            {none}
          </Text>
        </Card>
      ) : (
        <View className="overflow-hidden rounded-card border border-border bg-card">
          {notes.map((n, i) => {
            const photos = photosOf.get(n.id) ?? n.photoFileIds.length;
            const uploading = photos - n.photoFileIds.length;
            const mine = n.by?.userId === me;
            return (
              <View
                key={n.id}
                className={cn('gap-1 px-3.5 py-3', i > 0 && 'border-t border-border')}
                testID={`co-note-${n.id}`}
              >
                <Text className="text-[12.5px] text-text-3">
                  {P.notes.by(n.by?.name ?? null, fmtAt(n.notedAt, timeZone))}
                  {waiting.has(n.id) ? ` · ${P.kept.waitingToSend}` : ''}
                </Text>
                {n.body ? <Text className="text-[14.5px] leading-[20px]">{n.body}</Text> : null}
                {n.audio ? (
                  <View className="flex-row gap-2">
                    <Icon as={Mic} className="mt-0.5 size-4 text-text-3" />
                    <Text
                      className={cn(
                        'flex-1 text-[14px] leading-[20px]',
                        n.audio.transcript ? 'text-text' : 'text-text-2',
                      )}
                      testID={`co-note-words-${n.id}`}
                    >
                      {n.audio.transcript ??
                        (n.audio.state === 'failed' ? W.notes.wordsFailed : W.notes.wordsWaiting)}
                    </Text>
                  </View>
                ) : null}
                {photos > 0 ? (
                  <Text className="text-[13px] text-text-3" testID={`co-note-photos-${n.id}`}>
                    {uploading > 0 ? P.notes.photosWaiting(uploading) : P.notes.photos(photos)}
                  </Text>
                ) : null}
                {(mine || removeAny) && !waiting.has(n.id) ? (
                  <Button
                    variant="ghostDanger"
                    size="sm"
                    className="self-start px-0"
                    disabled={!online}
                    loading={busy === n.id}
                    accessibilityHint={online ? undefined : P.notes.removeNeedsSignal}
                    onPress={async () => {
                      setBusy(n.id);
                      await actions.remove(n);
                      setBusy(null);
                    }}
                    testID={`co-note-remove-${n.id}`}
                  >
                    {online ? W.notes.remove : P.kept.needsSignal}
                  </Button>
                ) : null}
              </View>
            );
          })}
        </View>
      )}
      {truncated ? (
        <Text className="px-1 text-[12.5px] text-text-3">{W.notes.truncated(notes.length)}</Text>
      ) : null}
      <TypeNoteSheet open={typing} onClose={() => setTyping(false)} onSave={actions.addTyped} />
      <VoiceNoteSheet
        open={speaking}
        onClose={() => setSpeaking(false)}
        jobName={jobName}
        onKeep={actions.addVoice}
      />
    </View>
  );
}

/** A note typed on the job. */
export function TypeNoteSheet({
  open,
  onClose,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  onSave: (body: string) => Promise<boolean>;
}) {
  const [body, setBody] = React.useState('');
  const [problem, setProblem] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (open) {
      setBody('');
      setProblem(false);
    }
  }, [open]);
  return (
    <Sheet open={open} onClose={onClose} title={P.notes.typeTitle} testID="co-note-sheet">
      <View className="mt-2 gap-3">
        <Input
          value={body}
          onChangeText={(t) => {
            setProblem(false);
            setBody(t);
          }}
          multiline
          maxLength={4000}
          className="h-28 items-start py-2"
          placeholder={W.notes.placeholder}
          accessibilityLabel={P.notes.typeTitle}
          invalid={problem}
          testID="co-note-body"
        />
        {problem ? (
          <Text className="text-[13px] text-danger-text" testID="co-note-problem">
            {P.notes.empty}
          </Text>
        ) : null}
        <Button
          loading={busy}
          onPress={async () => {
            if (!body.trim()) {
              setProblem(true);
              return;
            }
            setBusy(true);
            const ok = await onSave(body.trim());
            setBusy(false);
            if (ok) onClose();
          }}
          testID="co-note-save"
        >
          {W.notes.save}
        </Button>
      </View>
    </Sheet>
  );
}

/**
 * A voice note on the job: it records as soon as the sheet opens, with the bars moving as they talk; Stop ends it,
 * then Keep it or Record again. With no signal it says the words come when it sends, and the recording stays on the
 * phone meanwhile.
 */
export function VoiceNoteSheet({
  open,
  onClose,
  jobName,
  onKeep,
}: {
  open: boolean;
  onClose: () => void;
  jobName: string;
  /** Keeps the finished recording; resolves true once it's kept. */
  onKeep: (recording: { readonly uri: string; readonly seconds: number }) => Promise<boolean>;
}) {
  const rec = useVoiceNoteRecorder();
  const { online } = useNetwork();
  const [busy, setBusy] = React.useState(false);
  const started = React.useRef(false);
  const { start, discard } = rec;

  React.useEffect(() => {
    if (open && !started.current) {
      started.current = true;
      void start();
    }
    if (!open) started.current = false;
  }, [open, start]);

  const close = () => {
    if (rec.phase === 'recording') void rec.stop().then(discard);
    else if (rec.phase === 'done') discard();
    onClose();
  };

  return (
    <Sheet open={open} onClose={close} title={P.notes.voiceTitle} testID="co-voice-sheet">
      <View className="mt-1 gap-3">
        <Text className="text-[14px] text-text-2" testID="co-voice-at">
          {P.notes.voiceAt(jobName, clockOfSeconds(rec.seconds))}
        </Text>
        <Bars levels={rec.levels} live={rec.phase === 'recording'} />
        {rec.problem ? (
          <Text className="text-[13.5px] leading-[19px] text-danger-text" testID="co-voice-problem">
            {rec.problem === 'microphone' ? P.notes.noMicrophone : P.notes.recordFailed}
          </Text>
        ) : null}
        {rec.phase === 'recording' ? (
          <>
            <Text className="text-[13.5px] text-text-2">{P.notes.recording}</Text>
            <Button onPress={() => void rec.stop()} testID="co-voice-stop">
              {P.notes.stop}
            </Button>
          </>
        ) : rec.phase === 'done' ? (
          <>
            <View
              className={cn(
                'flex-row gap-2.5 rounded-control px-3.5 py-3',
                online ? 'bg-card-2' : 'bg-warning-soft',
              )}
              testID="co-voice-kept-note"
            >
              {!online ? <Icon as={CloudOff} className="mt-0.5 size-4 text-warning-text" /> : null}
              <Text
                className={cn(
                  'flex-1 text-[13.5px] leading-[19px]',
                  online ? 'text-text-2' : 'text-warning-text',
                )}
              >
                {online ? P.notes.recordedOnline : P.notes.recordedOffline}
              </Text>
            </View>
            <Button
              loading={busy}
              onPress={async () => {
                if (!rec.uri) return;
                setBusy(true);
                const ok = await onKeep({ uri: rec.uri, seconds: rec.seconds });
                setBusy(false);
                if (!ok) return;
                // The recording has moved to wait for upload: the sheet starts afresh next time.
                discard();
                onClose();
              }}
              testID="co-voice-keep"
            >
              {P.notes.keepIt}
            </Button>
            <Button
              variant="ghost"
              onPress={() => {
                discard();
                void start();
              }}
              testID="co-voice-again"
            >
              {P.notes.recordAgain}
            </Button>
          </>
        ) : rec.problem ? (
          <Button variant="secondary" onPress={() => void start()} testID="co-voice-retry">
            {P.notes.recordAgain}
          </Button>
        ) : null}
      </View>
    </Sheet>
  );
}

/** The loudness as it was recorded, a bar each; quiet bars before anything is heard. */
function Bars({ levels, live }: { levels: readonly number[]; live: boolean }) {
  const shown = [...Array(Math.max(0, LEVEL_BARS - levels.length)).fill(0), ...levels] as number[];
  return (
    <View
      className="h-12 flex-row items-center gap-[3px] overflow-hidden rounded-control bg-card-2 px-2"
      accessibilityLabel={live ? P.notes.recording : P.notes.voiceTitle}
      testID="co-voice-bars"
    >
      {shown.map((l, i) => (
        <View
          key={i}
          className={cn('flex-1 rounded-full', live ? 'bg-accent' : 'bg-border-strong')}
          style={{ height: `${Math.max(12, Math.round(l * 100))}%` }}
        />
      ))}
    </View>
  );
}
