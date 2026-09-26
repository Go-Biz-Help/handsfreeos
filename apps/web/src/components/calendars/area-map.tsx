'use client';
import { useEffect, useRef, useState } from 'react';
import {
  loadGoogleMaps,
  mapLook,
  METERS_PER_MILE,
  type GMap,
  type GoogleMaps,
  type GShape,
  type LatLngLiteral,
} from '@/lib/maps/google';

const US_MIDDLE: LatLngLiteral = { lat: 39.5, lng: -98.35 };

/** Where a map event happened, if it happened somewhere. */
const at = (e: { latLng: { lat(): number; lng(): number } | null }): LatLngLiteral | null =>
  e.latLng ? { lat: e.latLng.lat(), lng: e.latLng.lng() } : null;

/**
 * The map in a service area's dialog (M18). A distance area shows its circle around a pin you can drag; a drawn
 * area adds a corner where you click, moves one you drag, and shows the shape so far. Whatever is dragged follows
 * the pin while it moves and is kept where it's let go. `focus` moves the map there (an address someone looked
 * up).
 */
export function AreaMap({
  kind,
  center,
  miles,
  corners,
  focus,
  onCorner,
  onMoveCorner,
  onMoveCenter,
}: {
  kind: 'radius' | 'polygon';
  center: LatLngLiteral | null;
  miles: number;
  corners: readonly LatLngLiteral[];
  focus: LatLngLiteral | null;
  onCorner?: (p: LatLngLiteral) => void;
  onMoveCorner?: (i: number, p: LatLngLiteral) => void;
  onMoveCenter?: (p: LatLngLiteral) => void;
}) {
  const el = useRef<HTMLDivElement>(null);
  const [maps, setMaps] = useState<GoogleMaps | null>(null);
  const [failed, setFailed] = useState(false);
  const map = useRef<GMap | null>(null);
  const shapes = useRef<GShape[]>([]);
  const cornerRef = useRef(onCorner);
  cornerRef.current = onCorner;
  const moveRef = useRef(onMoveCorner);
  moveRef.current = onMoveCorner;
  const moveCenterRef = useRef(onMoveCenter);
  moveCenterRef.current = onMoveCenter;

  useEffect(() => {
    let live = true;
    loadGoogleMaps()
      .then((m) => live && setMaps(m))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, []);

  // The map itself, once, started where there is something to see.
  const startAt = useRef(focus ?? center ?? corners[0] ?? null);
  useEffect(() => {
    if (!maps || !el.current || map.current) return;
    map.current = new maps.Map(el.current, {
      ...mapLook(maps),
      center: startAt.current ?? US_MIDDLE,
      zoom: startAt.current ? 10 : 4,
      disableDefaultUI: true,
      zoomControl: true,
      clickableIcons: false,
      draggableCursor: kind === 'polygon' ? 'crosshair' : undefined,
    });
    map.current.addListener('click', (e) => {
      if (!e.latLng) return;
      cornerRef.current?.({ lat: e.latLng.lat(), lng: e.latLng.lng() });
    });
  }, [maps, kind]);

  useEffect(() => {
    if (map.current && focus) {
      map.current.setCenter(focus);
      map.current.setZoom(11);
    }
  }, [focus]);

  // The circle or the shape, redrawn when it changes.
  useEffect(() => {
    if (!maps || !map.current) return;
    for (const s of shapes.current) s.setMap(null);
    shapes.current = [];
    const style = {
      strokeColor: '#2d69d8',
      strokeWeight: 2,
      fillColor: '#2d69d8',
      fillOpacity: 0.15,
      clickable: false,
    };
    if (kind === 'radius' && center) {
      const circle = new maps.Circle({
        ...style,
        map: map.current,
        center,
        radius: miles * METERS_PER_MILE,
      });
      shapes.current.push(circle);
      map.current.fitBounds(circle.getBounds());
      if (moveCenterRef.current) {
        const pin = new maps.Marker({
          map: map.current,
          position: center,
          title: 'Where it’s measured from. Drag to move it.',
          draggable: true,
        });
        pin.addListener('drag', (e) => {
          const p = at(e);
          if (p) circle.setCenter(p);
        });
        pin.addListener('dragend', (e) => {
          const p = at(e);
          if (p) moveCenterRef.current?.(p);
        });
        shapes.current.push(pin);
      }
    }
    if (kind === 'polygon') {
      const shape =
        corners.length >= 2
          ? new maps.Polygon({ ...style, map: map.current, paths: corners })
          : null;
      if (shape) shapes.current.push(shape);
      const movable = !!moveRef.current;
      for (const [i, c] of corners.entries()) {
        const pin = new maps.Marker({
          map: map.current,
          position: c,
          label: String(i + 1),
          title: movable ? `Corner ${i + 1}. Drag to move it.` : `Corner ${i + 1}`,
          clickable: movable,
          draggable: movable,
        });
        if (movable) {
          pin.addListener('drag', (e) => {
            const p = at(e);
            if (p && shape) shape.setPaths(corners.map((x, j) => (j === i ? p : x)));
          });
          pin.addListener('dragend', (e) => {
            const p = at(e);
            if (p) moveRef.current?.(i, p);
          });
        }
        shapes.current.push(pin);
      }
    }
  }, [maps, kind, center, miles, corners]);

  if (failed)
    return (
      <p className="rounded-md border border-border bg-card-2 px-3 py-6 text-center text-[13px] text-text-2">
        The map didn’t load. Check your connection and try again.
      </p>
    );
  return (
    <div
      ref={el}
      className="h-[260px] w-full overflow-hidden rounded-md border border-border bg-card-2"
      data-testid="area-map"
      aria-label={
        kind === 'polygon'
          ? 'Map: click to add a corner, drag a corner to move it'
          : 'Map of the area: drag the pin to move where it’s measured from'
      }
    />
  );
}
