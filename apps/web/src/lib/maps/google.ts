/**
 * Google Maps in the browser (M18 service areas): loaded once, only on the screens that draw a map, with the
 * browser key (NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY, restricted to our domains). Without a key there is no map,
 * and the screens offer ZIP areas only.
 *
 * Only the few pieces of the Maps API we use are typed here.
 */
import { publicEnv } from '@/lib/env';

export interface LatLngLiteral {
  lat: number;
  lng: number;
}
interface LatLng {
  lat(): number;
  lng(): number;
}
interface MapsEventListener {
  remove(): void;
}
export interface GMap {
  setCenter(c: LatLngLiteral): void;
  setZoom(z: number): void;
  fitBounds(b: unknown): void;
  addListener(name: 'click', fn: (e: { latLng: LatLng | null }) => void): MapsEventListener;
}
export interface GShape {
  setMap(m: GMap | null): void;
}
export interface GoogleMaps {
  Map: new (el: HTMLElement, opts: Record<string, unknown>) => GMap;
  Circle: new (opts: Record<string, unknown>) => GShape & { getBounds(): unknown };
  Polygon: new (opts: Record<string, unknown>) => GShape;
  Marker: new (opts: Record<string, unknown>) => GShape;
  Geocoder: new () => {
    geocode(
      req: { address: string },
    ): Promise<{ results: { geometry: { location: LatLng }; formatted_address: string }[] }>;
  };
}

declare global {
  interface Window {
    google?: { maps: GoogleMaps };
    __hfosMapsReady?: () => void;
  }
}

let loading: Promise<GoogleMaps> | null = null;

export const mapsKey = (): string | null => publicEnv.googleMapsBrowserKey;

/** Loads the Maps script once; rejects without a key or when Google doesn't answer. */
export function loadGoogleMaps(): Promise<GoogleMaps> {
  if (typeof window === 'undefined') return Promise.reject(new Error('Maps load in the browser.'));
  if (window.google?.maps?.Map) return Promise.resolve(window.google.maps);
  const key = mapsKey();
  if (!key) return Promise.reject(new Error('No Google Maps key is set.'));
  loading ??= new Promise<GoogleMaps>((resolve, reject) => {
    window.__hfosMapsReady = () => {
      if (window.google?.maps) resolve(window.google.maps);
      else reject(new Error('Google Maps did not load.'));
    };
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?${new URLSearchParams({
      key,
      v: 'weekly',
      callback: '__hfosMapsReady',
    })}`;
    script.async = true;
    script.onerror = () => {
      loading = null;
      reject(new Error('Google Maps did not load.'));
    };
    document.head.appendChild(script);
  });
  return loading;
}

/** Where an address is, found with the browser key: for the point a distance area is measured from. */
export async function findPlace(
  address: string,
): Promise<{ point: LatLngLiteral; formatted: string } | null> {
  const maps = await loadGoogleMaps();
  try {
    const { results } = await new maps.Geocoder().geocode({ address });
    const top = results[0];
    if (!top) return null;
    return {
      point: { lat: top.geometry.location.lat(), lng: top.geometry.location.lng() },
      formatted: top.formatted_address,
    };
  } catch {
    return null;
  }
}

export const METERS_PER_MILE = 1609.344;
