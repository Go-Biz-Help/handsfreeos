import { OWN_MAIL_DRAFT_WORDS as W } from '@hfos/core';
import * as React from 'react';
import { View } from 'react-native';

import { useAiColors } from '@/components/drafts';
import { Lock, Pencil, Sparkles } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import type { OwnMailDraft } from '@/inbox/use-own-mail-draft';

/**
 * The AI teammate's draft on someone's own mail ("Let Ava read this mail", the owner 2026-11-22), after the newest
 * message in the thread, as on the web. It is theirs alone to read, as the thread is. "Use this draft" puts the words
 * in the message box, where they change what they like and send it as their own. Nothing is sent from this card.
 */
export function OwnMailDraftCard({
  draft,
  busy,
  onUse,
  onDismiss,
}: {
  draft: Pick<OwnMailDraft, 'body' | 'by'>;
  /** Putting it away is on its way. */
  busy: boolean;
  onUse: () => void;
  onDismiss: () => void;
}) {
  const ai = useAiColors();
  return (
    <View
      role="group"
      accessibilityLabel={W.title(draft.by)}
      testID="own-mail-draft"
      className="mt-3 gap-2.5 rounded-2xl border-[1.5px] border-dashed bg-card px-3.5 py-3"
      style={{ borderColor: ai.dash }}
    >
      <View className="flex-row items-center gap-[7px]">
        <Sparkles size={13} color={ai.text} strokeWidth={1.75} />
        <Text
          numberOfLines={1}
          className="min-w-0 flex-1 text-[13px] font-semibold"
          style={{ color: ai.text }}
        >
          {W.title(draft.by)}
        </Text>
        <View className="flex-row items-center gap-1">
          <Icon as={Lock} className="size-3 text-text-3" />
          <Text className="text-xs font-medium text-text-3">{W.onlyYou}</Text>
        </View>
      </View>
      <Text className="text-[15px] leading-[21px]" selectable testID="own-mail-draft-body">
        {draft.body}
      </Text>
      <Text className="text-xs text-text-3">{W.nothingSent}</Text>
      <View className="flex-row gap-2">
        <Button
          variant="secondary"
          size="md"
          className="flex-1"
          loading={busy}
          onPress={onDismiss}
          testID="own-mail-draft-dismiss"
        >
          {W.dismiss}
        </Button>
        <Button
          size="md"
          className="flex-1"
          icon={Pencil}
          disabled={busy}
          onPress={onUse}
          testID="own-mail-draft-use"
        >
          {W.use}
        </Button>
      </View>
    </View>
  );
}

/** In the card's place once its words are in the message box. */
export function OwnMailDraftUsed({ by }: { by: string }) {
  return (
    <View
      className="mt-3 flex-row items-center justify-center gap-1.5 px-3"
      testID="own-mail-draft-used"
    >
      <Icon as={Sparkles} className="size-3.5 text-text-3" />
      <Text className="min-w-0 shrink text-center text-xs text-text-3">{W.inBox(by)}</Text>
    </View>
  );
}
