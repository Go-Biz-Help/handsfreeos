'use client';
/**
 * Start a buyer deal or a listing (board 2, design/realestate/StartDeal.dc.html): from the Deals page, or from a
 * customer, a company or a Pipeline lead, which fill in what they know. Only the deal's people see it; owners and
 * admins may open one for someone else (`records.assign`).
 */
import {
  FIRST_STAGE,
  LISTING_STAGES,
  BUYER_STAGES,
  STAGE_LABELS,
} from '@hfos/core/addons/realestate/states';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { RecordPicker, type PickedRecord } from '@/components/crm/record-picker';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { fieldErrors } from '@/lib/api/field-errors';
import { useOpenedWith } from '@/lib/use-opened-with';
import { dealHref } from './bits';
import type { Teammate } from './types';

export interface StartDealDefaults {
  readonly client?: { readonly personId: string; readonly name: string } | null;
  readonly lead?: { readonly leadId: string; readonly title: string } | null;
  readonly property?: { readonly propertyId: string; readonly address: string } | null;
}

type Side = 'buyer' | 'listing';

/** "Nguyen purchase" or "Listing · 45 Oak Ave": a name to start from. */
function suggestName(side: Side, client: PickedRecord | null, address: string): string {
  if (side === 'listing') return address.trim() ? `Listing · ${address.trim()}` : 'Listing';
  const last = client?.name.split(',')[0]?.trim().split(/\s+/).at(-1);
  return last ? `${last} purchase` : 'Purchase';
}

export function StartDealDialog({
  workspaceId,
  side,
  open,
  onOpenChange,
  defaults: latest,
  members,
  myUserId,
  canChooseAgent,
}: {
  workspaceId: string;
  side: Side;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaults?: StartDealDefaults;
  /** The business's people, to pick a main agent from (owners and admins only). */
  members?: readonly Teammate[];
  myUserId?: string;
  canChooseAgent?: boolean;
}) {
  // What the page knew as the dialog opened, not as it refreshes underneath: see useOpenedWith.
  const defaults = useOpenedWith(open, latest);
  const router = useRouter();
  const [client, setClient] = useState<PickedRecord | null>(null);
  const [address, setAddress] = useState('');
  const [property, setProperty] = useState<{ propertyId: string; address: string } | null>(null);
  const [matches, setMatches] = useState<{ propertyId: string; address: string; deals: number }[]>(
    [],
  );
  const [name, setName] = useState('');
  const [named, setNamed] = useState(false);
  const [stage, setStage] = useState<string>(FIRST_STAGE[side]);
  const [agent, setAgent] = useState(myUserId ?? '');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Each time it opens, it starts from what the page knows.
  useEffect(() => {
    if (!open) return;
    const c = defaults?.client
      ? { kind: 'person' as const, id: defaults.client.personId, name: defaults.client.name }
      : null;
    setClient(c);
    setProperty(defaults?.property ?? null);
    setAddress('');
    setMatches([]);
    setStage(FIRST_STAGE[side]);
    setAgent(myUserId ?? '');
    setNamed(false);
    setName(suggestName(side, c, defaults?.property?.address ?? ''));
    setErrors({});
  }, [open, side, defaults, myUserId]);

  useEffect(() => {
    if (!named) setName(suggestName(side, client, property?.address ?? address));
  }, [side, client, property, address, named]);

  // Homes already here with that address, so a second deal on one lands on the same property.
  useEffect(() => {
    const q = address.trim();
    if (property || q.length < 3) {
      setMatches([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const out = unwrap(
          await apiBrowser().POST('/v1/queries/realestate.property.search', {
            body: { workspaceId, q, limit: 5 },
          }),
        );
        if (!cancelled) setMatches(out.properties);
      } catch {
        if (!cancelled) setMatches([]);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [address, property, workspaceId]);

  const stages = (side === 'buyer' ? BUYER_STAGES : LISTING_STAGES).filter(
    (s) => s !== 'past_client' && s !== 'sold' && s !== 'possession',
  );

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (client && client.kind !== 'person')
      return setErrors({ clientPersonId: 'Pick a person as the client. Add their company later.' });
    setBusy(true);
    setErrors({});
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/realestate.deal.open', {
          body: {
            workspaceId,
            side,
            name: name.trim(),
            stage,
            facts: [],
            ...(client ? { clientPersonId: client.id } : {}),
            ...(defaults?.lead ? { leadId: defaults.lead.leadId } : {}),
            ...(property
              ? { propertyId: property.propertyId }
              : address.trim()
                ? { newPropertyAddress: address.trim() }
                : {}),
            ...(canChooseAgent && agent && agent !== myUserId ? { mainAgentUserId: agent } : {}),
          },
        }),
      );
      toast.success(
        out.dutiesCreated
          ? `Deal started, with ${out.dutiesCreated} ${out.dutiesCreated === 1 ? 'duty' : 'duties'}.`
          : 'Deal started.',
      );
      onOpenChange(false);
      router.push(dealHref(workspaceId, out.dealId));
    } catch (err) {
      const fe = fieldErrors(err);
      if (Object.keys(fe).length) setErrors(fe);
      else toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const before = stages.slice(0, stages.indexOf(stage as (typeof stages)[number]));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={side === 'buyer' ? 'Start a buyer deal' : 'Start a listing'}
        className="w-[min(560px,calc(100vw-32px))]"
      >
        <form onSubmit={(e) => void submit(e)} className="mt-3 space-y-4" data-testid="start-deal">
          <Field label="Deal name" htmlFor="deal-name" error={errors.name}>
            <Input
              id="deal-name"
              value={name}
              maxLength={160}
              onChange={(e) => {
                setName(e.target.value);
                setNamed(true);
              }}
              invalid={!!errors.name}
              data-testid="start-deal-name"
            />
          </Field>
          <Field
            label={side === 'buyer' ? 'Client' : 'Seller'}
            htmlFor="deal-client"
            error={errors.clientPersonId}
            hint={
              side === 'buyer'
                ? 'The person buying. Add a spouse or co-buyer on the deal’s page.'
                : 'The person selling. Add a co-owner on the deal’s page.'
            }
          >
            <RecordPicker
              id="deal-client"
              workspaceId={workspaceId}
              value={client}
              onChange={setClient}
            />
          </Field>
          <Field
            label="Property"
            htmlFor="deal-property"
            error={errors.propertyId ?? errors.newPropertyAddress}
            hint={
              property
                ? 'A home already here. Its other deals stay on it too.'
                : side === 'buyer'
                  ? 'None yet? Leave it empty and add it when an offer is accepted.'
                  : 'The address of the home being sold.'
            }
          >
            {property ? (
              <div className="flex h-10 items-center gap-2.5 rounded-control border border-border-strong bg-card-2 px-3">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {property.address}
                </span>
                <button
                  type="button"
                  className="text-[13px] text-accent-text hover:underline"
                  onClick={() => setProperty(null)}
                >
                  Change
                </button>
              </div>
            ) : (
              <div className="relative">
                <Input
                  id="deal-property"
                  value={address}
                  maxLength={160}
                  placeholder="Street address"
                  autoComplete="off"
                  onChange={(e) => setAddress(e.target.value)}
                  data-testid="start-deal-address"
                />
                {matches.length ? (
                  <ul className="absolute left-0 right-0 top-full z-40 mt-1 rounded-menu border border-border bg-card p-1.5 shadow-2">
                    {matches.map((m) => (
                      <li key={m.propertyId}>
                        <button
                          type="button"
                          className="flex h-9 w-full items-center justify-between gap-2 rounded-[6px] px-2.5 text-left text-sm hover:bg-card-2"
                          onClick={() => {
                            setProperty({ propertyId: m.propertyId, address: m.address });
                            setMatches([]);
                          }}
                        >
                          <span className="truncate font-medium">{m.address}</span>
                          <span className="flex-none text-xs text-text-3">
                            {m.deals === 1 ? '1 deal' : `${m.deals} deals`}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            )}
          </Field>
          <Field
            label="Starting stage"
            htmlFor="deal-stage"
            error={errors.stage}
            hint={
              before.length
                ? `Duties for ${before.map((s) => STAGE_LABELS[s].toLowerCase()).join(', ')} are added too. Cancel any that don’t apply.`
                : 'Where the deal is now. Its duties are added for this stage.'
            }
          >
            <Select id="deal-stage" value={stage} onChange={(e) => setStage(e.target.value)}>
              {stages.map((s) => (
                <option key={s} value={s}>
                  {STAGE_LABELS[s]}
                </option>
              ))}
            </Select>
          </Field>
          {defaults?.lead ? (
            <Field
              label="From the Pipeline"
              htmlFor="deal-lead"
              hint="The lead stays on the Pipeline, linked to this deal."
            >
              <Input id="deal-lead" value={defaults.lead.title} readOnly disabled />
            </Field>
          ) : null}
          {canChooseAgent && members?.length ? (
            <Field
              label="Main agent"
              htmlFor="deal-agent"
              error={errors.mainAgentUserId}
              hint="Only the people on a deal see it. Owners and admins see every deal."
            >
              <Select id="deal-agent" value={agent} onChange={(e) => setAgent(e.target.value)}>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id === myUserId ? `${m.fullName} (you)` : m.fullName}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <p className="text-[12.5px] text-text-3">
              You’ll be its main agent. Only the people on a deal see it; owners and admins see
              every deal.
            </p>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} data-testid="start-deal-submit">
              Start the deal
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
