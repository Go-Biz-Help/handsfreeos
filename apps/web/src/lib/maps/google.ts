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
/** Google's shading of an area kind (here, ZIP codes), styled per area by its place ID. */
export interface FeatureLayer {
  readonly isAvailable: boolean;
  style: ((o: { feature: { placeId: string } }) => Record<string, unknown> | null) | null;
  addListener(
    name: 'click',
    fn: (e: { features: { placeId: string }[] }) => void,
  ): MapsEventListener;
}
export interface GMap {
  setCenter(c: LatLngLiteral): void;
  setZoom(z: number): void;
  fitBounds(b: unknown): void;
  addListener(name: 'click', fn: (e: { latLng: LatLng | null }) => void): MapsEventListener;
  addListener(name: 'idle', fn: () => void): MapsEventListener;
  getFeatureLayer(type: string): FeatureLayer;
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
  Circle: new (opts: Record<string, unknown>) => GShape & {
    getBounds(): unknown;
    setCenter(c: LatLngLiteral): void;
  };
  Polygon: new (opts: Record<string, unknown>) => GShape & {
    setPaths(p: readonly LatLngLiteral[]): void;
  };
  Marker: new (opts: Record<string, unknown>) => GShape & {
    addListener(name: 'drag' | 'dragend', fn: (e: { latLng: LatLng | null }) => void): unknown;
  };
  Geocoder: new () => {
    geocode(
      req:
        | { address: string }
        | { location: LatLngLiteral }
        | { placeId: string }
        | { componentRestrictions: { country: string; postalCode: string } },
    ): Promise<{
      results: {
        geometry: { location: LatLng; viewport: unknown };
        formatted_address: string;
        place_id: string;
        types: string[];
        address_components: { short_name: string; types: string[] }[];
      }[];
    }>;
  };
  LatLngBounds: new () => { union(other: unknown): void };
  FeatureType: { POSTAL_CODE: string };
  ColorScheme?: { LIGHT: string; DARK: string };
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

/** Whether the app looks dark right now: the person's own setting, else the device's. */
function looksDark(): boolean {
  if (typeof document === 'undefined') return false;
  const theme = document.documentElement.getAttribute('data-theme');
  if (theme) return theme === 'dark';
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

/** The map ID whose style turns on Google's ZIP code areas; without one, ZIP areas have no map. */
export const mapsMapId = (): string | null => publicEnv.googleMapsMapId;

/**
 * What every map here opens with: the map ID, and the app's light or dark look, which Google draws from the
 * style's light or dark mode (or its own, without a map ID). Google fixes the look when a map opens.
 */
export function mapLook(maps: GoogleMaps): Record<string, unknown> {
  const mapId = mapsMapId();
  return {
    ...(mapId ? { mapId } : {}),
    ...(maps.ColorScheme
      ? { colorScheme: looksDark() ? maps.ColorScheme.DARK : maps.ColorScheme.LIGHT }
      : {}),
  };
}

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

/** The address at a point on the map (a distance area's pin someone dragged), or null when there isn't one. */
export async function addressAt(point: LatLngLiteral): Promise<string | null> {
  const maps = await loadGoogleMaps();
  try {
    const { results } = await new maps.Geocoder().geocode({ location: point });
    return results[0]?.formatted_address ?? null;
  } catch {
    return null;
  }
}

// A ZIP code's place and the other way round, kept for the page's life so a territory's ZIPs are looked up once.
const zipPlaces = new Map<string, Promise<{ placeId: string; viewport: unknown } | null>>();
const placeZips = new Map<string, Promise<string | null>>();

/** A ZIP code's place on Google's map (to shade it) and its extent (to show it), or null for no such ZIP. */
export function zipPlace(zip: string): Promise<{ placeId: string; viewport: unknown } | null> {
  let found = zipPlaces.get(zip);
  if (!found) {
    found = (async () => {
      const maps = await loadGoogleMaps();
      try {
        const { results } = await new maps.Geocoder().geocode({
          componentRestrictions: { country: 'US', postalCode: zip },
        });
        const top = results.find((r) => r.types.includes('postal_code'));
        if (!top) return null;
        placeZips.set(top.place_id, Promise.resolve(zip));
        return { placeId: top.place_id, viewport: top.geometry.viewport };
      } catch {
        zipPlaces.delete(zip); // No answer this time (or no such ZIP): ask again next time.
        return null;
      }
    })();
    zipPlaces.set(zip, found);
  }
  return found;
}

/** The ZIP code of an area clicked on the map, from its place ID. */
export function zipOfPlace(placeId: string): Promise<string | null> {
  let found = placeZips.get(placeId);
  if (!found) {
    found = (async () => {
      const maps = await loadGoogleMaps();
      try {
        const { results } = await new maps.Geocoder().geocode({ placeId });
        const top = results[0];
        const zip = top?.address_components.find((c) => c.types.includes('postal_code'));
        if (!top || !zip || !/^\d{5}$/.test(zip.short_name)) return null;
        if (!zipPlaces.has(zip.short_name))
          zipPlaces.set(
            zip.short_name,
            Promise.resolve({ placeId, viewport: top.geometry.viewport }),
          );
        return zip.short_name;
      } catch {
        placeZips.delete(placeId);
        return null;
      }
    })();
    placeZips.set(placeId, found);
  }
  return found;
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
