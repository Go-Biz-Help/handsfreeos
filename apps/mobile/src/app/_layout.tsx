import '../global.css';

import { Stack } from 'expo-router';

import { SpikeDriver } from '@/spike/driver';

export default function RootLayout() {
  return (
    <>
      <Stack />
      {/* Opt in with EXPO_PUBLIC_SPIKE_DRIVER=1 when starting Metro, so normal runs don't poll the spike server. */}
      {__DEV__ && process.env.EXPO_PUBLIC_SPIKE_DRIVER === '1' ? <SpikeDriver /> : null}
    </>
  );
}
