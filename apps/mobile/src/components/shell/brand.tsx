import { Image, View } from 'react-native';

import MARK from '@/assets/images/handsfreeos-mark.png';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

/** The HandsFreeOS mark (design/brand/handsfreeos-icon.png is the master). */
export function BrandMark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <Image
      source={MARK}
      accessibilityIgnoresInvertColors
      style={{ width: size, height: size }}
      className={cn('shrink-0', className)}
    />
  );
}

/** The mark and the name, "HandsFree" with "OS" in the accent colour, as the web's sign-in page draws it. */
export function Brand({ className, size = 34 }: { className?: string; size?: number }) {
  return (
    <View
      className={cn('flex-row items-center gap-2.5', className)}
      accessibilityLabel="HandsFreeOS"
    >
      <BrandMark size={size} />
      <Text className="text-lg font-semibold tracking-[-0.18px]">
        HandsFree
        <Text className="text-lg font-semibold tracking-[-0.18px] text-accent-text">OS</Text>
      </Text>
    </View>
  );
}
