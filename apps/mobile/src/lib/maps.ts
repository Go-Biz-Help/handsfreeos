import { Linking, Platform } from 'react-native';

/** The phone's own maps app at an address, as the canvas's Directions does; the browser's when there's none. */
export async function openMaps(address: string): Promise<void> {
  const q = encodeURIComponent(address);
  const url = Platform.OS === 'ios' ? `maps://?q=${q}` : `geo:0,0?q=${q}`;
  const fallback = `https://maps.google.com/?q=${q}`;
  try {
    if (await Linking.canOpenURL(url)) await Linking.openURL(url);
    else await Linking.openURL(fallback);
  } catch {
    await Linking.openURL(fallback).catch(() => undefined);
  }
}
