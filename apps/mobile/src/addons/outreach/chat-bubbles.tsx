/**
 * Messages drawn as chat bubbles, the person's on the right in the accent and theirs on the left: a chat's latest
 * messages beside a message waiting for an OK (docs/outreach.md, "How the AI writes"), and how the person's voice reads
 * on the Settings tab. The web's twin is apps/web/src/addons/outreach/chat-bubbles.tsx.
 */
import { View } from 'react-native';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

export interface Bubble {
  readonly fromMe: boolean;
  readonly text: string;
  /** Said under the bubble, small: when it was sent. */
  readonly when?: string | null;
}

export function ChatBubbles({
  bubbles,
  label,
  testID,
}: {
  bubbles: readonly Bubble[];
  label: string;
  testID?: string;
}) {
  return (
    <View
      className="gap-1 rounded-md bg-card-2 px-3 py-2"
      accessibilityLabel={label}
      testID={testID}
    >
      {bubbles.map((b, i) => (
        <View key={i} className={b.fromMe ? 'items-end' : 'items-start'}>
          <View
            className={cn(
              'max-w-[86%] rounded-[16px] px-3 py-1.5',
              b.fromMe
                ? 'rounded-br-[5px] bg-accent'
                : 'rounded-bl-[5px] border border-border bg-card',
            )}
          >
            <Text className={cn('text-[14px] leading-[20px]', b.fromMe ? 'text-white' : null)}>
              {b.text}
            </Text>
          </View>
          {b.when ? <Text className="px-1 text-[11.5px] text-text-3">{b.when}</Text> : null}
        </View>
      ))}
    </View>
  );
}
