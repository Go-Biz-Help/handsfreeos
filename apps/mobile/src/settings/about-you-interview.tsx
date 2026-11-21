import {
  ABOUT_YOU_ANSWER_MOST,
  ABOUT_YOU_INTERVIEW_WORDS as IW,
  ABOUT_YOU_QUESTIONS,
} from '@hfos/core';
import { requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder } from 'expo-audio';
import * as React from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';

import { Mic, Square } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import { workerPost } from '@/lib/worker';
import { forget, hear } from '@/voice/speech';
import { VOICE_RECORDING } from '@/voice/session';

type Phase = 'answering' | 'listening' | 'hearing' | 'writing';

/**
 * About you's interview on the phone (docs/outreach.md, decision 186), as on the web: one question at a time, typed or
 * said out loud (the recording goes to the worker to be written down, as voice mode's do), with Back, Skip and Next.
 * At the end the AI writes the box from the answers, keeping what's in it, and hands it back unsaved for the person to
 * read and Save. Both need signal.
 */
export function AboutYouInterview({
  workspaceId,
  about,
  online,
  onWritten,
  onClose,
}: {
  workspaceId: string;
  about: string;
  online: boolean;
  onWritten: (about: string) => void;
  onClose: () => void;
}) {
  const recorder = useAudioRecorder(VOICE_RECORDING);
  const [at, setAt] = React.useState(0);
  const [answers, setAnswers] = React.useState<Record<string, string>>({});
  const [phase, setPhase] = React.useState<Phase>('answering');
  const q = ABOUT_YOU_QUESTIONS[at]!;
  const last = at === ABOUT_YOU_QUESTIONS.length - 1;
  const busy = phase !== 'answering';

  const setAnswer = (key: string, text: string) =>
    setAnswers((a) => ({ ...a, [key]: text.slice(0, ABOUT_YOU_ANSWER_MOST) }));

  const speak = async () => {
    const permission = await requestRecordingPermissionsAsync().catch(() => null);
    if (!permission?.granted) {
      toast.error(IW.noMic);
      return;
    }
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true }).catch(
      () => undefined,
    );
    try {
      await recorder.prepareToRecordAsync(VOICE_RECORDING);
      recorder.record();
      setPhase('listening');
    } catch {
      toast.error(IW.noMic);
    }
  };

  const stopSpeaking = async () => {
    const key = q.key;
    await recorder.stop().catch(() => undefined);
    void setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
    const uri = recorder.uri;
    if (!uri) {
      setPhase('answering');
      return;
    }
    setPhase('hearing');
    try {
      const heard = await hear(workspaceId, uri);
      if (heard.text)
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
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      forget(uri);
      setPhase('answering');
    }
  };

  const finish = async () => {
    const said = ABOUT_YOU_QUESTIONS.map((each) => ({
      key: each.key,
      said: (answers[each.key] ?? '').trim(),
    })).filter((a) => a.said);
    if (!said.length) {
      toast.error(IW.nothing);
      return;
    }
    if (!online) {
      toast.error(IW.needsSignal);
      return;
    }
    setPhase('writing');
    try {
      const out = await workerPost<{ about: string }>('/v1/about-you/write', {
        workspaceId,
        answers: said,
        about: about.trim(),
      });
      onWritten(out.about);
      toast.show(IW.written);
    } catch (e) {
      toast.error(errorMessage(e));
      setPhase('answering');
    }
  };

  return (
    <Card className="gap-2.5 p-3.5" testID="about-you-interview">
      <Text className="text-[12.5px] font-medium text-text-3">
        {IW.of(at + 1, ABOUT_YOU_QUESTIONS.length)}
      </Text>
      <Text className="text-[16px] font-semibold" testID="about-you-question">
        {q.ask}
      </Text>
      <Text className="text-[13px] leading-[19px] text-text-2">{q.hint}</Text>
      <Input
        key={q.key}
        value={answers[q.key] ?? ''}
        onChangeText={(text) => setAnswer(q.key, text)}
        multiline
        editable={phase !== 'writing'}
        maxLength={ABOUT_YOU_ANSWER_MOST}
        placeholder={IW.placeholder}
        accessibilityLabel={IW.answerLabel}
        textAlignVertical="top"
        className="h-28 items-stretch"
        style={{ paddingTop: 11, paddingBottom: 11 }}
        testID="about-you-answer"
      />
      {phase !== 'answering' ? (
        <View className="flex-row items-center gap-1.5" accessibilityLiveRegion="polite">
          {phase === 'listening' ? (
            <View className="size-2 rounded-full bg-danger" />
          ) : (
            <ActivityIndicator size="small" />
          )}
          <Text className="min-w-0 flex-1 text-[12.5px] text-text-2">
            {phase === 'listening' ? IW.listening : phase === 'hearing' ? IW.hearing : IW.writing}
          </Text>
        </View>
      ) : null}
      {phase === 'listening' ? (
        <Button
          variant="danger"
          size="md"
          icon={Square}
          onPress={() => void stopSpeaking()}
          testID="about-you-stop"
        >
          {IW.stop}
        </Button>
      ) : (
        <Button
          variant="secondary"
          size="md"
          onPress={() => void speak()}
          icon={Mic}
          disabled={busy || !online}
          testID="about-you-speak"
        >
          {IW.speak}
        </Button>
      )}
      <View className="flex-row gap-2">
        <Button
          variant="ghost"
          size="md"
          className="flex-1"
          onPress={() => setAt((n) => n - 1)}
          disabled={at === 0 || busy}
        >
          {IW.back}
        </Button>
        {last ? (
          <Button
            size="md"
            className="flex-1"
            onPress={() => void finish()}
            loading={phase === 'writing'}
            disabled={busy && phase !== 'writing'}
            testID="about-you-finish"
          >
            {IW.finish}
          </Button>
        ) : (
          <>
            <Button
              variant="ghost"
              size="md"
              className="flex-1"
              onPress={() => {
                setAnswer(q.key, '');
                setAt((n) => n + 1);
              }}
              disabled={busy}
              testID="about-you-skip"
            >
              {IW.skip}
            </Button>
            <Button
              size="md"
              className="flex-1"
              onPress={() => setAt((n) => n + 1)}
              disabled={busy}
              testID="about-you-next"
            >
              {IW.next}
            </Button>
          </>
        )}
      </View>
      <Pressable
        onPress={onClose}
        disabled={phase === 'writing'}
        accessibilityRole="button"
        hitSlop={8}
        testID="about-you-cancel"
      >
        <Text className="text-[12.5px] text-text-3 underline">{IW.cancel}</Text>
      </Pressable>
    </Card>
  );
}
