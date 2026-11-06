/**
 * An answer's words on the phone (core's `answerBlocks` and `answerParts`, as the web shows them): **bold**, lists,
 * and each web and email address one to press, opened outside the app.
 *
 * It's one Text, so all of it can be selected. Android picks any part of it where it is. iOS only copies a whole
 * Text, so there pressing and holding opens the answer in Select text: a read-only box where any part can be picked
 * and copied, or Select All takes everything.
 */
import { answerBlocks, answerCopyText, answerParts, ASSISTANT_WORDS } from '@hfos/core';
import * as React from 'react';
import { Linking, Modal, Platform, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

/** One line or list item: its words, bold where marked, and its links. */
function line(text: string, key: string): React.ReactNode[] {
  return answerParts(text).map((p, i) => {
    const k = `${key}-${i}`;
    // A page in the app is the web's; on the phone its words show as they are.
    if (!p.href || p.inApp)
      return p.bold ? (
        <Text key={k} className="font-semibold">
          {p.text}
        </Text>
      ) : (
        p.text
      );
    const href = p.href;
    return (
      <React.Fragment key={k}>
        <Text
          className={
            p.bold
              ? 'font-semibold text-accent-text underline'
              : 'font-medium text-accent-text underline'
          }
          accessibilityRole="link"
          onPress={() => void Linking.openURL(href).catch(() => undefined)}
          testID="assistant-link"
        >
          {p.text}
        </Text>
        {p.site ? <Text className="text-text-3">{` (${p.site})`}</Text> : null}
      </React.Fragment>
    );
  });
}

/** The whole answer as runs of one Text: paragraphs apart, each list item on its own line. */
function runs(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  answerBlocks(text).forEach((b, i) => {
    if (i) out.push('\n\n');
    const rows = b.kind === 'p' ? b.lines : b.items;
    rows.forEach((row, j) => {
      if (j) out.push('\n');
      if (b.kind !== 'p') out.push(b.kind === 'ul' ? '•  ' : `${j + 1}.  `);
      out.push(...line(row, `${i}-${j}`));
    });
  });
  return out;
}

/** iOS's Select text: the answer in a read-only box, where any part of it can be picked and copied. */
function SelectText({ text, open, onClose }: { text: string; open: boolean; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const W = ASSISTANT_WORDS.copy;
  return (
    <Modal
      visible={open}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View
        className="flex-1 bg-bg"
        style={{ paddingBottom: insets.bottom }}
        testID="assistant-select-text"
      >
        <View className="flex-row items-center gap-3 border-b border-border bg-card px-4 py-3">
          <Text className="min-w-0 flex-1 text-[17px] font-semibold">{W.selectTitle}</Text>
          <Button
            size="md"
            variant="secondary"
            onPress={onClose}
            testID="assistant-select-text-done"
          >
            {W.close}
          </Button>
        </View>
        <Text className="px-4 pt-3 text-[13px] leading-[18px] text-text-3">{W.selectHint}</Text>
        <TextInput
          value={answerCopyText(text)}
          editable={false}
          multiline
          scrollEnabled
          className="flex-1 px-4 pt-2 font-sans text-[16px] leading-[24px] text-text"
          textAlignVertical="top"
          testID="assistant-select-text-body"
        />
      </View>
    </Modal>
  );
}

export function AnswerText({ text }: { text: string }) {
  const [selecting, setSelecting] = React.useState(false);
  const ios = Platform.OS === 'ios';
  return (
    <>
      <Text
        className="text-[15px] leading-[22px]"
        selectable={!ios}
        onLongPress={ios ? () => setSelecting(true) : undefined}
        accessibilityHint={ios ? ASSISTANT_WORDS.copy.selectTitle : undefined}
        testID="assistant-answer-text"
      >
        {runs(text)}
      </Text>
      {ios ? <SelectText text={text} open={selecting} onClose={() => setSelecting(false)} /> : null}
    </>
  );
}
