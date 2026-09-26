'use client';
import { useEffect, useRef, useState } from 'react';
import {
  loadGoogleMaps,
  mapsMapId,
  zipOfPlace,
  zipPlace,
  type FeatureLayer,
  type GMap,
  type GoogleMaps,
  type LatLngLiteral,
} from '@/lib/maps/google';

const US_MIDDLE: LatLngLiteral = { lat: 39.5, lng: -98.35 };

/** Past this many the map shades the first ones only: each ZIP is a lookup the first time it's shown. */
export const ZIP_MAP_LIMIT = 300;

const SHADE = {
  strokeColor: '#2d69d8',
  strokeOpacity: 1,
  strokeWeight: 2,
  fillColor: '#2d69d8',
  fillOpacity: 0.15,
};

/** Runs `fn` over `items` a few at a time, so a long list doesn't hit Google all at once. */
async function inBatches<T, R>(items: readonly T[], fn: (t: T) => Promise<R>, size = 5) {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

/**
 * The map in a ZIP code area's dialog (M18): its ZIP codes shaded like a distance or drawn area, and a click on
 * any ZIP code adds it or takes it off. Google draws the ZIP codes (postal code boundaries, which the map ID's
 * style turns on) and knows each by a place ID, looked up once per page. The map moves to show ZIPs someone
 * typed in, not ones they clicked (those are already in view). `focus` moves it to an address someone looked up.
 */
export function ZipMap({
  zips,
  focus,
  onToggle,
}: {
  zips: readonly string[];
  focus: LatLngLiteral | null;
  onToggle: (zip: string) => void;
}) {
  const el = useRef<HTMLDivElement>(null);
  const [maps, setMaps] = useState<GoogleMaps | null>(null);
  const [failed, setFailed] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const map = useRef<GMap | null>(null);
  const layer = useRef<FeatureLayer | null>(null);
  const toggleRef = useRef(onToggle);
  toggleRef.current = onToggle;
  const clicked = useRef(new Set<string>());
  const shown = useRef(new Set<string>());

  useEffect(() => {
    let live = true;
    loadGoogleMaps()
      .then((m) => live && setMaps(m))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!maps || !el.current || map.current) return;
    const m = new maps.Map(el.current, {
      center: US_MIDDLE,
      zoom: 4,
      mapId: mapsMapId(),
      disableDefaultUI: true,
      zoomControl: true,
      clickableIcons: false,
    });
    map.current = m;
    const zipLayer = m.getFeatureLayer(maps.FeatureType.POSTAL_CODE);
    layer.current = zipLayer;
    // Known once the map has loaded its style: false when the map ID's style doesn't have ZIP codes on.
    const loaded = m.addListener('idle', () => {
      loaded.remove();
      setUnavailable(!zipLayer.isAvailable);
    });
    zipLayer.addListener('click', (e) => {
      const placeId = e.features[0]?.placeId;
      if (!placeId) return;
      void zipOfPlace(placeId).then((zip) => {
        if (!zip) return;
        clicked.current.add(zip);
        toggleRef.current(zip);
      });
    });
  }, [maps]);

  useEffect(() => {
    if (map.current && focus) {
      map.current.setCenter(focus);
      map.current.setZoom(12);
    }
  }, [focus]);

  const key = zips.slice(0, ZIP_MAP_LIMIT).join(' ');
  useEffect(() => {
    const zipLayer = layer.current;
    if (!maps || !zipLayer) return;
    const wanted = key ? key.split(' ') : [];
    let live = true;
    void (async () => {
      const found = await inBatches(wanted, zipPlace);
      if (!live) return;
      const ids = new Set(found.flatMap((f) => (f ? [f.placeId] : [])));
      zipLayer.style = ({ feature }) => (ids.has(feature.placeId) ? SHADE : null);
      const typedIn = wanted.some(
        (z, i) => found[i] && !shown.current.has(z) && !clicked.current.has(z),
      );
      shown.current = new Set(wanted);
      if (typedIn && map.current) {
        const bounds = new maps.LatLngBounds();
        for (const f of found) if (f) bounds.union(f.viewport);
        map.current.fitBounds(bounds);
      }
    })();
    return () => {
      live = false;
    };
  }, [maps, key]);

  if (failed)
    return (
      <p className="rounded-md border border-border bg-card-2 px-3 py-6 text-center text-[13px] text-text-2">
        The map didn’t load. Check your connection and try again.
      </p>
    );
  return (
    <div>
      <div
        ref={el}
        className="h-[260px] w-full overflow-hidden rounded-md border border-border bg-card-2"
        data-testid="zip-map"
        aria-label="Map: click a ZIP code to add or remove it"
      />
      {unavailable ? (
        <p className="mt-1.5 text-xs text-text-3">
          ZIP codes aren’t turned on for this map yet, so they can’t be shaded or clicked. Ask
          whoever set up HandsFreeOS to turn on postal code boundaries for the map ID.
        </p>
      ) : zips.length > ZIP_MAP_LIMIT ? (
        <p className="mt-1.5 text-xs text-text-3">
          The map shades the first {ZIP_MAP_LIMIT} ZIP codes. All {zips.length} count.
        </p>
      ) : null}
    </div>
  );
}
