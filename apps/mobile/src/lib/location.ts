import * as Location from 'expo-location';

/**
 * Where the phone is, once, for something the person just tapped (On my way, checking in, Help): asked for the first
 * time it's needed, one quick reading, and nothing when they say no or it takes too long, so what they tapped still
 * goes, without a place. Never in the background (app.json's wording says so).
 */
export async function hereOrNull(timeoutMs = 8000): Promise<{ lat: number; lng: number } | null> {
  try {
    const asked = await Location.requestForegroundPermissionsAsync();
    if (!asked.granted) return null;
    const got = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    return got ? { lat: got.coords.latitude, lng: got.coords.longitude } : null;
  } catch {
    return null;
  }
}
