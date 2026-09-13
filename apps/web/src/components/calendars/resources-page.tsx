'use client';
import { formatHours, type WeeklyHours } from '@hfos/core';
import {
  Armchair,
  DoorOpen,
  Home,
  Package,
  Plus,
  Truck,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Stepper } from '@/components/ui/stepper';
import { Switch } from '@/components/ui/switch';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { ResourceItem, ResourceKind } from '@/lib/api/types';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { hoursProblem, WeeklyHoursEditor } from './weekly-hours';

export const RESOURCE_KINDS: Record<ResourceKind, { label: string; icon: LucideIcon }> = {
  room: { label: 'Room', icon: DoorOpen },
  equipment: { label: 'Equipment', icon: Wrench },
  vehicle: { label: 'Vehicle', icon: Truck },
  property: { label: 'Property', icon: Home },
  chair: { label: 'Chair', icon: Armchair },
  other: { label: 'Other', icon: Package },
};

const WEEKDAYS_9_TO_5: WeeklyHours = [1, 2, 3, 4, 5].map((day) => ({
  day,
  start: '09:00',
  end: '17:00',
}));

export function ResourceIcon({ kind, className }: { kind: ResourceKind; className?: string }) {
  const Icon = RESOURCE_KINDS[kind]?.icon ?? Package;
  return <Icon className={className ?? 'h-4 w-4'} strokeWidth={1.5} />;
}

/** Settings → Calendars → Resources: rooms, trucks and equipment, and how many can be booked at once. */
export function ResourcesPage({
  workspaceId,
  resources,
}: {
  workspaceId: string;
  resources: ResourceItem[];
}) {
  const router = useRouter();
  useLiveRefresh(['resource']);
  const [editing, setEditing] = useState<ResourceItem | 'new' | null>(null);

  async function setQuantity(r: ResourceItem, quantity: number) {
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/resource.update', {
          body: { workspaceId, resourceId: r.id, quantity },
        }),
      );
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  return (
    <div className="max-w-[640px]">
      <Card className="px-5 py-4" data-testid="resources">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Resources</h2>
            <p className="mt-1 text-[13px] text-text-2">
              Rooms, trucks and equipment that bookings reserve.
            </p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setEditing('new')}
            data-testid="resource-new"
          >
            <Plus className="h-4 w-4" strokeWidth={1.75} />
            New
          </Button>
        </div>
        {resources.length === 0 ? (
          <EmptyState title="No resources yet" className="mt-3 border-t border-border">
            Add a room, a truck or a piece of equipment that two jobs can’t share.
          </EmptyState>
        ) : (
          <ul className="mt-1.5">
            {resources.map((r) => (
              <li
                key={r.id}
                className="flex items-center gap-3 border-t border-border py-2"
                data-testid={`resource-row-${r.name}`}
              >
                <span className="inline-flex h-8 w-8 flex-none items-center justify-center rounded-full bg-card-2 text-text-2">
                  <ResourceIcon kind={r.kind} />
                </span>
                <button
                  type="button"
                  className="flex min-w-0 flex-1 flex-col text-left"
                  onClick={() => setEditing(r)}
                >
                  <span className="text-[13px] font-medium hover:underline">{r.name}</span>
                  <span className="truncate text-xs text-text-3">
                    {RESOURCE_KINDS[r.kind].label} ·{' '}
                    {r.hours ? formatHours(r.hours as WeeklyHours) : 'any time'}
                    {r.location ? ` · ${r.location}` : ''}
                  </span>
                </button>
                <Stepper
                  value={r.quantity}
                  min={1}
                  max={100}
                  label={`How many ${r.name}`}
                  onChange={(q) => void setQuantity(r, q)}
                />
              </li>
            ))}
          </ul>
        )}
        <p className="mt-1 text-[12.5px] text-text-3">
          How many can be booked at once. With one, two jobs can’t share it.
        </p>
      </Card>
      {editing ? (
        <ResourceDialog
          workspaceId={workspaceId}
          resource={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}

function ResourceDialog({
  workspaceId,
  resource,
  onClose,
}: {
  workspaceId: string;
  resource: ResourceItem | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState(resource?.name ?? '');
  const [kind, setKind] = useState<ResourceKind>(resource?.kind ?? 'vehicle');
  const [quantity, setQuantity] = useState(resource?.quantity ?? 1);
  const [location, setLocation] = useState(resource?.location ?? '');
  const [hours, setHours] = useState<WeeklyHours | null>(
    (resource?.hours as WeeklyHours | null) ?? null,
  );
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      const body = {
        workspaceId,
        name: name.trim(),
        kind,
        quantity,
        location: location.trim() || null,
        hours,
      };
      if (resource)
        unwrap(
          await apiBrowser().POST('/v1/commands/resource.update', {
            body: { ...body, resourceId: resource.id },
          }),
        );
      else unwrap(await apiBrowser().POST('/v1/commands/resource.create', { body }));
      toast.success(resource ? 'Saved.' : `${name.trim()} added.`);
      onClose();
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function archive() {
    if (!resource || !confirm(`Archive ${resource.name}?`)) return;
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/resource.archive', {
          body: { workspaceId, resourceId: resource.id },
        }),
      );
      toast.success(
        out.calendars.length
          ? `Archived. ${out.calendars.map((c) => c.name).join(', ')} still need${out.calendars.length === 1 ? 's' : ''} it; the builder offers a fix.`
          : 'Archived.',
      );
      onClose();
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={resource ? resource.name : 'New resource'}
        className="max-h-[90vh] w-[min(520px,calc(100vw-32px))] overflow-y-auto"
      >
        <div className="mt-4 flex flex-col gap-3.5">
          <div className="grid grid-cols-[minmax(0,1fr)_150px] gap-3">
            <Field label="Name" htmlFor="resource-name">
              <Input
                id="resource-name"
                value={name}
                maxLength={120}
                placeholder="Truck 2"
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field label="Kind" htmlFor="resource-kind">
              <Select
                id="resource-kind"
                value={kind}
                onChange={(e) => setKind(e.target.value as ResourceKind)}
              >
                {(Object.keys(RESOURCE_KINDS) as ResourceKind[]).map((k) => (
                  <option key={k} value={k}>
                    {RESOURCE_KINDS[k].label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="flex flex-col">
              <span className="text-[13px] font-medium">How many</span>
              <span className="text-xs text-text-3">Booked at the same time, at most.</span>
            </span>
            <Stepper value={quantity} min={1} max={100} label="How many" onChange={setQuantity} />
          </div>
          <Field label="Where it is (optional)" htmlFor="resource-location">
            <Input
              id="resource-location"
              value={location}
              maxLength={300}
              onChange={(e) => setLocation(e.target.value)}
            />
          </Field>
          <div>
            <label className="flex items-center justify-between gap-3 text-[13px] font-medium">
              Only at certain hours
              <Switch
                checked={!!hours}
                label="Only at certain hours"
                onChange={(on) => setHours(on ? WEEKDAYS_9_TO_5 : null)}
              />
            </label>
            {hours ? (
              <div className="mt-2">
                <WeeklyHoursEditor value={hours} onChange={setHours} idPrefix="resource-hours" />
              </div>
            ) : null}
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          {resource ? (
            <Button variant="ghost" onClick={() => void archive()}>
              Archive
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={!name.trim() || (hours ? !!hoursProblem(hours) : false)}
            onClick={() => void save()}
            data-testid="resource-save"
          >
            {resource ? 'Save' : 'Add resource'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
