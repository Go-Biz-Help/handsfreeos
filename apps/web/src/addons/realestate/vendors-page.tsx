'use client';
/**
 * The vendors directory (board 75, design/realestate/Vendors.dc.html): the inspectors, contractors, photographers,
 * lenders and others the business's deals use, each a company in Contacts, with what they do, where they work and
 * any disclosure (a referral fee, an ownership). Anyone on a deal can add one; an owner or admin approves them, and
 * only approved vendors are offered on a duty. A client is always offered every one that fits, never only one.
 */
import {
  VENDOR_SERVICES,
  VENDOR_SERVICE_KEYS,
  type VendorService,
} from '@hfos/core/addons/realestate/vendors';
import { useState } from 'react';
import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { cn, relativeTime } from '@/lib/utils';
import { ReasonDialog } from './deal-dialogs';
import type { Vendor, VendorList } from './types';
import { useAct } from './use-act';

export function VendorsPage({
  workspaceId,
  businessName,
  list,
  canManage,
}: {
  workspaceId: string;
  businessName: string;
  list: VendorList;
  /** Owners and admins approve and archive. */
  canManage: boolean;
}) {
  useLiveRefresh(['custom_record']);
  const { busy, act } = useAct();
  const [editing, setEditing] = useState<Vendor | 'new' | null>(null);
  const [archiving, setArchiving] = useState<Vendor | null>(null);
  const [service, setService] = useState<VendorService | 'all'>('all');
  const shown = list.vendors.filter((v) => service === 'all' || v.services.includes(service));
  const used = VENDOR_SERVICE_KEYS.filter((k) => list.vendors.some((v) => v.services.includes(k)));
  return (
    <div data-testid="realestate-vendors">
      <PageHeader
        title="Vendors"
        description={`${businessName} · the people your deals use`}
        actions={
          <Button onClick={() => setEditing('new')} data-testid="vendor-add">
            Add a vendor
          </Button>
        }
      />
      {used.length > 1 ? (
        <div className="mb-4 flex flex-wrap gap-2" role="tablist" aria-label="Which vendors">
          {(['all', ...used] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={service === k}
              onClick={() => setService(k)}
              className={cn(
                'inline-flex h-8 items-center rounded-full border px-3 text-[13px]',
                service === k
                  ? 'border-accent-soft bg-accent-soft text-accent-text'
                  : 'border-border-strong text-text-2 hover:bg-card-2',
              )}
            >
              {k === 'all' ? 'All' : VENDOR_SERVICES[k]}
            </button>
          ))}
        </div>
      ) : null}
      <Card className="overflow-x-auto p-0">
        {shown.length === 0 ? (
          <p className="px-5 py-8 text-center text-[13.5px] text-text-2">
            No vendors yet. Add the inspectors, contractors and lenders your deals use; each is a
            company in Contacts.
          </p>
        ) : (
          <table
            className="w-full min-w-[640px] text-left text-[13.5px]"
            data-testid="vendors-table"
          >
            <thead className="border-b border-border text-xs font-semibold uppercase tracking-wide text-text-3">
              <tr>
                <th className="px-5 py-3 font-semibold">Vendor</th>
                <th className="px-3 py-3 font-semibold">Services</th>
                <th className="px-3 py-3 font-semibold">Areas</th>
                <th className="px-3 py-3 font-semibold">Used</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody>
              {shown.map((v) => (
                <tr
                  key={v.id}
                  className="border-b border-border align-top last:border-b-0"
                  data-testid={`vendor-${v.name}`}
                >
                  <td className="px-5 py-3">
                    <div className="font-semibold">{v.name}</div>
                    <div
                      className={cn(
                        'text-[12.5px]',
                        v.disclosure ? 'text-warning-text' : 'text-text-3',
                      )}
                    >
                      {v.disclosureWords}
                    </div>
                    {v.email || v.phone ? (
                      <div className="text-[12px] text-text-3">
                        {[v.phone, v.email].filter(Boolean).join(' · ')}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-3 py-3">{v.servicesWords}</td>
                  <td className="px-3 py-3 text-text-2">{v.areas.join(', ') || 'Anywhere'}</td>
                  <td className="px-3 py-3 text-text-2">
                    {v.uses
                      ? `${v.uses} ${v.uses === 1 ? 'time' : 'times'}${v.lastUsedAt ? ` · last ${relativeTime(v.lastUsedAt)}` : ''}`
                      : 'Not yet'}
                  </td>
                  <td className="whitespace-nowrap px-5 py-3 text-right">
                    {v.approved ? (
                      <Badge variant="ok">Approved</Badge>
                    ) : canManage ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        loading={busy === `approve:${v.id}`}
                        onClick={() =>
                          void act(
                            `approve:${v.id}`,
                            async () =>
                              unwrap(
                                await apiBrowser().POST('/v1/commands/realestate.vendor.approve', {
                                  body: { workspaceId, vendorId: v.id, approved: true },
                                }),
                              ),
                            `${v.name} is approved. Duties offer them now.`,
                          )
                        }
                        data-testid="vendor-approve"
                      >
                        Approve
                      </Button>
                    ) : (
                      <Badge variant="pending">Waiting for approval</Badge>
                    )}
                    <div className="mt-1.5 flex justify-end gap-3 text-[12.5px]">
                      <button
                        type="button"
                        className="text-accent-text hover:underline"
                        onClick={() => setEditing(v)}
                      >
                        Change
                      </button>
                      {canManage ? (
                        <button
                          type="button"
                          className="text-text-3 hover:text-danger-text hover:underline"
                          onClick={() => setArchiving(v)}
                        >
                          Archive
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <p className="mt-3 text-[12.5px] text-text-3">
        A client is offered every approved vendor that fits, never only one, and each disclosure is
        said where the vendor is shown.{' '}
        {canManage ? '' : 'An owner or admin approves a vendor before duties offer them.'}
      </p>
      <VendorDialog
        vendor={editing}
        onClose={() => setEditing(null)}
        workspaceId={workspaceId}
        canManage={canManage}
      />
      <ReasonDialog
        open={archiving !== null}
        onOpenChange={(o) => !o && setArchiving(null)}
        title={archiving ? `Archive ${archiving.name}?` : 'Archive'}
        description="Duties stop offering them. They stay in Contacts, and on the deals that used them."
        submit="Archive"
        danger
        optional
        done="Archived."
        run={async (reason) =>
          archiving &&
          unwrap(
            await apiBrowser().POST('/v1/commands/realestate.vendor.archive', {
              body: {
                workspaceId,
                vendorId: archiving.id,
                ...(reason.trim() ? { reason: reason.trim() } : {}),
              },
            }),
          )
        }
      />
    </div>
  );
}

/** Adding a vendor, or changing one. */
function VendorDialog({
  vendor,
  onClose,
  workspaceId,
  canManage,
}: {
  vendor: Vendor | 'new' | null;
  onClose: () => void;
  workspaceId: string;
  canManage: boolean;
}) {
  const v = vendor && vendor !== 'new' ? vendor : null;
  const key = vendor === null ? 'none' : (v?.id ?? 'new');
  return (
    <Dialog open={vendor !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={v ? `Change ${v.name}` : 'Add a vendor'}
        description={
          v
            ? undefined
            : canManage
              ? 'They go in Contacts as a company. Approve them so duties offer them.'
              : 'They go in Contacts as a company. An owner or admin approves them before duties offer them.'
        }
        className="max-h-[92dvh] w-[min(560px,calc(100vw-32px))] overflow-y-auto"
      >
        <VendorForm key={key} vendor={v} workspaceId={workspaceId} onClose={onClose} />
      </DialogContent>
    </Dialog>
  );
}

function VendorForm({
  vendor: v,
  workspaceId,
  onClose,
}: {
  vendor: Vendor | null;
  workspaceId: string;
  onClose: () => void;
}) {
  const [name, setName] = useState(v?.name ?? '');
  const [email, setEmail] = useState(v?.email ?? '');
  const [phone, setPhone] = useState(v?.phone ?? '');
  const [services, setServices] = useState<VendorService[]>(v ? [...v.services] : []);
  const [areas, setAreas] = useState(v?.areas.join(', ') ?? '');
  const [disclosure, setDisclosure] = useState(v?.disclosure ?? '');
  const [note, setNote] = useState(v?.note ?? '');
  const { busy, errors, act } = useAct(onClose);
  return (
    <form
      className="mt-4 space-y-3.5"
      onSubmit={(e) => {
        e.preventDefault();
        void act(
          'save',
          async () =>
            unwrap(
              await apiBrowser().POST('/v1/commands/realestate.vendor.save', {
                body: {
                  workspaceId,
                  ...(v ? { vendorId: v.id } : { name: name.trim() }),
                  ...(email.trim() ? { email: email.trim() } : {}),
                  ...(phone.trim() ? { phone: phone.trim() } : {}),
                  services,
                  areas: areas
                    .split(',')
                    .map((a) => a.trim())
                    .filter(Boolean),
                  disclosure: disclosure.trim() || null,
                  note: note.trim() || null,
                },
              }),
            ),
          v ? 'Saved.' : 'Added.',
        );
      }}
    >
      {!v ? (
        <Field label="Name" htmlFor="v-name" error={errors.name}>
          <Input
            id="v-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            data-testid="vendor-name"
          />
        </Field>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Email (optional)" htmlFor="v-email" error={errors.email}>
          <Input
            id="v-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label="Phone (optional)" htmlFor="v-phone" error={errors.phone}>
          <Input id="v-phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
      </div>
      <div>
        <div className="mb-1.5 text-[13px] font-medium">What they do</div>
        <div className="flex flex-wrap gap-1.5">
          {VENDOR_SERVICE_KEYS.map((k) => {
            const on = services.includes(k);
            return (
              <button
                key={k}
                type="button"
                aria-pressed={on}
                onClick={() => setServices(on ? services.filter((s) => s !== k) : [...services, k])}
                className={cn(
                  'h-8 rounded-full border px-3 text-[13px]',
                  on
                    ? 'border-accent-soft bg-accent-soft text-accent-text'
                    : 'border-border-strong text-text-2',
                )}
                data-testid={`vendor-service-${k}`}
              >
                {VENDOR_SERVICES[k]}
              </button>
            );
          })}
        </div>
        {errors.services ? (
          <p className="mt-1 text-[12.5px] text-danger-text">{errors.services}</p>
        ) : null}
      </div>
      <Field
        label="Where they work"
        htmlFor="v-areas"
        hint="Towns, counties or ZIP codes, with commas. Left empty: anywhere."
      >
        <Input id="v-areas" value={areas} onChange={(e) => setAreas(e.target.value)} />
      </Field>
      <Field
        label="Disclosure (optional)"
        htmlFor="v-disclosure"
        hint="A referral fee, or that someone here owns part of it. Said to the client wherever the vendor is offered."
        error={errors.disclosure}
      >
        <Input
          id="v-disclosure"
          value={disclosure}
          onChange={(e) => setDisclosure(e.target.value)}
          data-testid="vendor-disclosure"
        />
      </Field>
      <Field label="Note for the team (optional)" htmlFor="v-note">
        <Textarea id="v-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" loading={busy === 'save'} data-testid="vendor-save">
          {v ? 'Save' : 'Add them'}
        </Button>
      </div>
    </form>
  );
}
