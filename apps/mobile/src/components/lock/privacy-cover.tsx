import { View } from 'react-native';

import { BrandMark } from '@/components/shell/brand';

/**
 * Covers the app while it's in the background, so the phone's app switcher shows the mark rather than customers'
 * names. Only when the app is locked with Face ID.
 */
export function PrivacyCover() {
  return (
    <View className="absolute inset-0 items-center justify-center bg-bg" testID="privacy-cover">
      <BrandMark size={72} />
    </View>
  );
}
