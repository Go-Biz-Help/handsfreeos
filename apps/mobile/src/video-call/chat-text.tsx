/**
 * A chat message from a video call, with each link and email address in it one to press (core's `chatLinkParts`):
 * in the call's chat, and in the chat kept with the call. Its own file, so the call's record can show it without
 * loading LiveKit (./room.tsx).
 */
import { chatLinkParts } from '@hfos/core';
import * as React from 'react';
import { Linking } from 'react-native';

import { Text } from '@/components/ui/text';

export function ChatText({ text, className }: { text: string; className?: string }) {
  return (
    <Text className={className ?? 'text-[15px]'}>
      {chatLinkParts(text).map((p, i) =>
        p.href ? (
          <Text
            key={i}
            className="font-medium text-accent-text underline"
            accessibilityRole="link"
            onPress={() => void Linking.openURL(p.href!).catch(() => undefined)}
            testID="call-chat-link"
          >
            {p.text}
          </Text>
        ) : (
          p.text
        ),
      )}
    </Text>
  );
}
