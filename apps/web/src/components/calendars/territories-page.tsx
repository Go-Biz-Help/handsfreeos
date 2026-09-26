'use client';
import { Pencil, Plus, Trash2, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Label } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { TerritoryItem } from '@/lib/api/types';
import { findPlace, mapsKey, type LatLngLiteral } from '@/lib/maps/google';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { AddressInput } from './address-input';
import { AreaMap } from './area-map';

/** Five-digit ZIP codes found in some text ("77002, 77003 77004"). */
export function zipsIn(text: string): string[] {
  return [...new Set((text.match(/\d{5}/g) ?? []).map((z) => z))];
}

/** "10 miles from 1500 Marilla St", "An area drawn on the map (6 corners)". */
export function areaSummary(
  t: Pick<TerritoryItem, 'kind' | 'radiusMiles' | 'centerAddress' | 'polygon' | 'postalCodes'>,
): string {
  if (t.kind === 'radius')
    return `${t.radiusMiles ?? 0} miles from ${t.centerAddress ?? 'a point on the map'}`;
  if (t.kind === 'polygon') return `An area drawn on the map (${t.polygon?.length ?? 0} corners)`;
  return `${t.postalCodes.length} ZIP code${t.postalCodes.length === 1 ? '' : 's'}`;
}

/** Settings → Calendars → Territories: ZIP code lists, distances and drawn areas, and who covers them. */
export function TerritoriesPage({
  workspaceId,
  territories,
  people,
}: {
  workspaceId: string;
  territories: TerritoryItem[];
  people: { id: string; fullName: string }[];
}) {
  const router = useRouter();
  useLiveRefresh(['territory']);
  const [editing, setEditing] = useState<TerritoryItem | 'new' | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [zipText, setZipText] = useState('');

  async function update(t: TerritoryItem, postalCodes: string[]) {
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/territory.update', {
          body: { workspaceId, territoryId: t.id, postalCodes },
        }),
      );
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }
  async function remove(t: TerritoryItem) {
    if (
      !confirm(
        `Delete ${t.name}? Calendars that route by service area stop sending visits there to its people.`,
      )
    )
      return;
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/territory.delete', {
          body: { workspaceId, territoryId: t.id },
        }),
      );
      toast.success('Deleted.');
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  const name = (id: string) => people.find((p) => p.id === id)?.fullName ?? 'Someone';

  return (
    <div className="max-w-[640px]">
      <Card className="px-5 py-4" data-testid="territories">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Territories</h2>
            <p className="mt-1 text-[13px] text-text-2">
              Where you go and who covers it, for calendars that route by service area: a list of
              ZIP codes, so many miles from an address, or an area drawn on a map.
            </p>
          </div>
          <Button variant="secondary" size="sm" onClick={() => setEditing('new')}>
            <Plus className="h-4 w-4" strokeWidth={1.75} />
            New
          </Button>
        </div>
        {territories.length === 0 ? (
          <EmptyState title="No territories yet" className="mt-3 border-t border-border">
            A territory is where you go (ZIP codes, a distance, or an area on the map) and the
            people who go there.
          </EmptyState>
        ) : (
          <ul className="mt-1.5">
            {territories.map((t) => (
              <li
                key={t.id}
                className="border-t border-border py-2.5"
                data-testid={`territory-${t.name}`}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[13px] font-medium">{t.name}</span>
                  <span className="flex items-center gap-1">
                    {t.userIds.map((u) => (
                      <span key={u} title={name(u)}>
                        <Avatar name={name(u)} seed={u} size="sm" />
                      </span>
                    ))}
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Edit ${t.name}`}
                      onClick={() => setEditing(t)}
                    >
                      <Pencil className="h-3.5 w-3.5" strokeWidth={1.5} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Delete ${t.name}`}
                      onClick={() => void remove(t)}
                    >
                      <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />
                    </Button>
                  </span>
                </div>
                {t.kind !== 'zip' ? (
                  <p className="mt-1 text-[12.5px] text-text-2" data-testid="area-summary">
                    {areaSummary(t)}
                  </p>
                ) : (
                  <div className="mt-1.5 flex flex-wrap items-center gap-[5px]">
                    {t.postalCodes.map((z) => (
                      <span
                        key={z}
                        className="inline-flex h-6 items-center gap-1 rounded-[6px] border border-border bg-card-2 pl-2 pr-1 font-mono text-xs"
                      >
                        {z}
                        <button
                          type="button"
                          aria-label={`Remove ${z} from ${t.name}`}
                          className="text-text-3 hover:text-text"
                          onClick={() =>
                            void update(
                              t,
                              t.postalCodes.filter((x) => x !== z),
                            )
                          }
                        >
                          <X className="h-3 w-3" strokeWidth={1.75} />
                        </button>
                      </span>
                    ))}
                    {adding === t.id ? (
                      <form
                        className="flex items-center gap-1"
                        onSubmit={(e) => {
                          e.preventDefault();
                          const extra = zipsIn(zipText).filter((z) => !t.postalCodes.includes(z));
                          if (extra.length) void update(t, [...t.postalCodes, ...extra]);
                          setAdding(null);
                          setZipText('');
                        }}
                      >
                        <Input
                          inputSize="sm"
                          autoFocus
                          className="h-7 w-[150px] font-mono text-xs"
                          placeholder="77002, 77003"
                          aria-label={`ZIP codes to add to ${t.name}`}
                          value={zipText}
                          onChange={(e) => setZipText(e.target.value)}
                        />
                        <Button type="submit" size="sm" className="h-7">
                          Add
                        </Button>
                      </form>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-1.5 text-xs"
                        onClick={() => {
                          setAdding(t.id);
                          setZipText('');
                        }}
                      >
                        <Plus className="h-3 w-3" strokeWidth={1.75} />
                        ZIP
                      </Button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-1 text-[12.5px] text-text-3">
          A place can be in more than one area. Anyone outside every area is asked to call.
        </p>
      </Card>
      {editing ? (
        <TerritoryDialog
          workspaceId={workspaceId}
          territory={editing === 'new' ? null : editing}
          people={people}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}

type Kind = TerritoryItem['kind'];
const KIND_LABEL: Record<Kind, string> = {
  zip: 'ZIP codes',
  radius: 'Distance',
  polygon: 'Draw on map',
};

function TerritoryDialog({
  workspaceId,
  territory,
  people,
  onClose,
}: {
  workspaceId: string;
  territory: TerritoryItem | null;
  people: { id: string; fullName: string }[];
  onClose: () => void;
}) {
  const router = useRouter();
  const withMap = !!mapsKey();
  const [name, setName] = useState(territory?.name ?? '');
  const [kind, setKind] = useState<Kind>(territory?.kind ?? 'zip');
  const [zips, setZips] = useState(territory?.postalCodes.join(', ') ?? '');
  const [address, setAddress] = useState(territory?.centerAddress ?? '');
  const [center, setCenter] = useState<LatLngLiteral | null>(territory?.center ?? null);
  const [miles, setMiles] = useState(String(territory?.radiusMiles ?? 15));
  const [corners, setCorners] = useState<LatLngLiteral[]>(
    (territory?.polygon ?? []).map(([lat, lng]) => ({ lat: lat ?? 0, lng: lng ?? 0 })),
  );
  const [focus, setFocus] = useState<LatLngLiteral | null>(null);
  const [finding, setFinding] = useState(false);
  const [userIds, setUserIds] = useState<string[]>(territory?.userIds ?? []);
  const [busy, setBusy] = useState(false);
  const milesValue = Number(miles);
  const milesOk = Number.isFinite(milesValue) && milesValue >= 0.1 && milesValue <= 250;

  /** An address found, typed and Found or picked from Google's suggestions: the map goes there. */
  function goTo(found: { point: LatLngLiteral; formatted: string } | null) {
    if (!found) {
      toast.error('That address wasn’t found on the map. Check it and try again.');
      return;
    }
    setFocus(found.point);
    if (kind === 'radius') {
      setCenter(found.point);
      setAddress(found.formatted);
    }
  }

  async function find() {
    if (!address.trim()) return;
    setFinding(true);
    try {
      goTo(await findPlace(address.trim()));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setFinding(false);
    }
  }

  const ready =
    !!name.trim() &&
    (kind === 'zip' || (kind === 'radius' ? !!center && milesOk : corners.length >= 3));

  async function save() {
    setBusy(true);
    try {
      const shape =
        kind === 'radius' && center
          ? {
              kind: 'radius' as const,
              address: address.trim(),
              lat: center.lat,
              lng: center.lng,
              miles: milesValue,
            }
          : kind === 'polygon'
            ? {
                kind: 'polygon' as const,
                corners: corners.map((c) => [c.lat, c.lng] as [number, number]),
              }
            : { kind: 'zip' as const };
      const body = {
        workspaceId,
        name: name.trim(),
        postalCodes: kind === 'zip' ? zipsIn(zips) : [],
        shape,
        userIds,
      };
      if (territory)
        unwrap(
          await apiBrowser().POST('/v1/commands/territory.update', {
            body: { ...body, territoryId: territory.id },
          }),
        );
      else unwrap(await apiBrowser().POST('/v1/commands/territory.create', { body }));
      toast.success(territory ? 'Saved.' : `${name.trim()} added.`);
      onClose();
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={territory ? territory.name : 'New territory'}>
        <div className="mt-4 flex flex-col gap-3.5">
          <Field label="Name" htmlFor="territory-name">
            <Input
              id="territory-name"
              value={name}
              maxLength={120}
              placeholder="Houston Central"
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <div>
            <Label>Where it covers</Label>
            <div className="flex gap-1.5" role="radiogroup" aria-label="Where it covers">
              {(['zip', 'radius', 'polygon'] as const).map((k) => (
                <Button
                  key={k}
                  type="button"
                  size="sm"
                  variant={kind === k ? 'primary' : 'secondary'}
                  role="radio"
                  aria-checked={kind === k}
                  disabled={k !== 'zip' && !withMap}
                  onClick={() => setKind(k)}
                  data-testid={`area-kind-${k}`}
                >
                  {KIND_LABEL[k]}
                </Button>
              ))}
            </div>
            {!withMap ? (
              <p className="mt-1.5 text-xs text-text-3">
                Distance and drawn areas need a Google Maps key. Ask whoever set up HandsFreeOS to
                add one.
              </p>
            ) : null}
          </div>
          {kind === 'zip' ? (
            <Field
              label="ZIP codes"
              htmlFor="territory-zips"
              hint={`${zipsIn(zips).length} ZIP codes. Separate them with commas, spaces or new lines.`}
            >
              <Textarea
                id="territory-zips"
                value={zips}
                className="font-mono text-[13px]"
                onChange={(e) => setZips(e.target.value)}
              />
            </Field>
          ) : (
            <>
              <Field
                label={kind === 'radius' ? 'Measured from' : 'Go to an address'}
                htmlFor="territory-address"
                hint={
                  kind === 'radius'
                    ? 'Usually your shop or office. Start typing and pick it (or press Find), then set how far you go.'
                    : 'Then click the map to add each corner of the area, in order. Drag a corner to move it.'
                }
              >
                <div className="flex gap-2">
                  <AddressInput
                    id="territory-address"
                    value={address}
                    onChange={setAddress}
                    onPick={goTo}
                    onFind={() => void find()}
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    loading={finding}
                    onClick={() => void find()}
                  >
                    Find
                  </Button>
                </div>
              </Field>
              {kind === 'radius' ? (
                <Field label="How far, in miles" htmlFor="territory-miles">
                  <Input
                    id="territory-miles"
                    inputMode="decimal"
                    className="w-[120px]"
                    value={miles}
                    invalid={!milesOk}
                    onChange={(e) => setMiles(e.target.value)}
                  />
                </Field>
              ) : null}
              <AreaMap
                kind={kind}
                center={center}
                miles={milesOk ? milesValue : 0}
                corners={corners}
                focus={focus}
                onCorner={
                  kind === 'polygon'
                    ? (p) => setCorners((cs) => (cs.length >= 200 ? cs : [...cs, p]))
                    : undefined
                }
                onMoveCorner={
                  kind === 'polygon'
                    ? (i, p) => setCorners((cs) => cs.map((c, j) => (j === i ? p : c)))
                    : undefined
                }
              />
              {kind === 'polygon' ? (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-text-3">
                    {corners.length < 3
                      ? `Add at least ${3 - corners.length} more corner${3 - corners.length === 1 ? '' : 's'}.`
                      : `${corners.length} corners.`}
                  </span>
                  <span className="flex gap-1.5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={!corners.length}
                      onClick={() => setCorners((cs) => cs.slice(0, -1))}
                    >
                      Undo corner
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={!corners.length}
                      onClick={() => setCorners([])}
                    >
                      Start over
                    </Button>
                  </span>
                </div>
              ) : null}
            </>
          )}
          <div>
            <Label>Who covers it</Label>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {people.map((p) => (
                <Checkbox
                  key={p.id}
                  label={p.fullName}
                  checked={userIds.includes(p.id)}
                  onChange={(e) =>
                    setUserIds(
                      e.target.checked ? [...userIds, p.id] : userIds.filter((x) => x !== p.id),
                    )
                  }
                />
              ))}
            </div>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={busy} disabled={!ready} onClick={() => void save()}>
            {territory ? 'Save' : 'Add territory'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
