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
import { useLiveRefresh } from '@/lib/realtime/live-provider';

/** Five-digit ZIP codes found in some text ("77002, 77003 77004"). */
export function zipsIn(text: string): string[] {
  return [...new Set((text.match(/\d{5}/g) ?? []).map((z) => z))];
}

/** Settings → Calendars → Territories: ZIP code lists and who covers them. */
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
      !confirm(`Delete ${t.name}? Calendars routing by ZIP stop sending its codes to its people.`)
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
              ZIP codes and the people who cover them, for calendars that route by ZIP.
            </p>
          </div>
          <Button variant="secondary" size="sm" onClick={() => setEditing('new')}>
            <Plus className="h-4 w-4" strokeWidth={1.75} />
            New
          </Button>
        </div>
        {territories.length === 0 ? (
          <EmptyState title="No territories yet" className="mt-3 border-t border-border">
            A territory is a list of ZIP codes and the people who go there.
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
              </li>
            ))}
          </ul>
        )}
        <p className="mt-1 text-[12.5px] text-text-3">
          A ZIP can be in more than one area. Anyone outside every area is asked to call.
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
  const [name, setName] = useState(territory?.name ?? '');
  const [zips, setZips] = useState(territory?.postalCodes.join(', ') ?? '');
  const [userIds, setUserIds] = useState<string[]>(territory?.userIds ?? []);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      const body = { workspaceId, name: name.trim(), postalCodes: zipsIn(zips), userIds };
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
          <Button loading={busy} disabled={!name.trim()} onClick={() => void save()}>
            {territory ? 'Save' : 'Add territory'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
