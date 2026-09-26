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
interface FormattableText {
  text: string;
}
interface PlacePrediction {
  text: FormattableText;
  mainText: FormattableText | null;
  secondaryText: FormattableText | null;
  toPlace(): {
    fetchFields(req: { fields: string[] }): Promise<unknown>;
    location?: LatLng | null;
    formattedAddress?: string | null;
  };
}
/** Places API (New): suggestions as someone types, one billing session from the first letter to the pick. */
interface Places {
  AutocompleteSessionToken: new () => object;
  AutocompleteSuggestion: {
    fetchAutocompleteSuggestions(req: {
      input: string;
      sessionToken: object;
      includedRegionCodes?: string[];
    }): Promise<{ suggestions: { placePrediction: PlacePrediction | null }[] }>;
  };
}
export interface GoogleMaps {
  Map: new (el: HTMLElement, opts: Record<string, unknown>) => GMap;
  Circle: new (opts: Record<string, unknown>) => GShape & { getBounds(): unknown };
  Polygon: new (opts: Record<string, unknown>) => GShape & {
    setPaths(p: readonly LatLngLiteral[]): void;
  };
  Marker: new (opts: Record<string, unknown>) => GShape & {
    addListener(name: 'drag' | 'dragend', fn: (e: { latLng: LatLng | null }) => void): unknown;
  };
  Geocoder: new () => {
    geocode(req: {
      address: string;
    }): Promise<{ results: { geometry: { location: LatLng }; formatted_address: string }[] }>;
  };
  places: Places;
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
      libraries: 'places',
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

export interface AddressSuggestion {
  /** "1500 Marilla St" */
  readonly main: string;
  /** "Dallas, TX, USA" */
  readonly more: string;
  /** Where it is, and Google's name for it. Ends the typing session it came from. */
  readonly place: () => Promise<{ point: LatLngLiteral; formatted: string } | null>;
}

/**
 * US addresses matching what's typed so far, from Places API (New), which the browser key needs turned on. Each
 * search keeps one session token until a suggestion is picked, so Google bills the typing and the pick as one
 * lookup. Rejects when Places isn't available; the Find button (the Geocoder) still works then.
 */
export function addressSearch(): (input: string) => Promise<AddressSuggestion[]> {
  let session: object | null = null;
  return async (input) => {
    const { places } = await loadGoogleMaps();
    const sessionToken = (session ??= new places.AutocompleteSessionToken());
    const { suggestions } = await places.AutocompleteSuggestion.fetchAutocompleteSuggestions({
      input,
      sessionToken,
      includedRegionCodes: ['us'],
    });
    return suggestions.flatMap(({ placePrediction: p }) =>
      p
        ? [
            {
              main: p.mainText?.text ?? p.text.text,
              more: p.secondaryText?.text ?? '',
              place: async () => {
                if (session === sessionToken) session = null;
                const place = p.toPlace();
                try {
                  await place.fetchFields({ fields: ['location', 'formattedAddress'] });
                } catch {
                  return null;
                }
                if (!place.location) return null;
                return {
                  point: { lat: place.location.lat(), lng: place.location.lng() },
                  formatted: place.formattedAddress ?? p.text.text,
                };
              },
            },
          ]
        : [],
    );
  };
}

export const METERS_PER_MILE = 1609.344;
