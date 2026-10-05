'use client';
/**
 * The deal page's side column: key dates, the people on it, the commission, client updates and the linked deal.
 */
import { termValueWords, type TermKey } from '@hfos/core/addons/realestate/terms';
import { MILESTONE_WORDS } from '@hfos/core/addons/realestate/prompts';
import { DEAL_ROLE_LABELS, type DealRole } from '@hfos/core/addons/realestate/words';
import { money } from '@hfos/core';
import { X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { CardHead, dealHref, Line } from './bits';
import {
  CommissionDialog,
  FinalCommissionDialog,
  PartyDialog,
  PropertyDialog,
  TeamDialog,
} from './deal-dialogs';
import type { DealGet, Draft, Teammate } from './types';
import { useAct } from './use-act';

const DATE_ORDER: readonly TermKey[] = [
  'acceptance',
  'emd_due',
  'inspection_end',
  'financing_end',
  'appraisal_end',
  'rate_lock_expiry',
  'walkthrough',
  'closing',
  'possession',
  'listing_launch',
];

export function KeyDatesCard({ workspaceId, deal }: { workspaceId: string; deal: DealGet }) {
  const dates = deal.terms
    .filter((t) => t.kind === 'date' && t.entries.length)
    .sort(
      (a, b) =>
        (DATE_ORDER.indexOf(a.key as TermKey) + 1 || 99) -
        (DATE_ORDER.indexOf(b.key as TermKey) + 1 || 99),
    );
  return (
    <Card className="p-4 md:p-5" data-testid="deal-key-dates">
      <CardHead
        title="Key dates"
        action={
          <Link
            href={dealHref(workspaceId, deal.deal.dealId, 'dates')}
            className="text-[13px] text-accent-text hover:underline"
          >
            All dates
          </Link>
        }
      />
      {dates.length === 0 ? (
        <p className="text-[13px] text-text-2">
          None yet. Type them in from the contract on{' '}
          <Link
            href={dealHref(workspaceId, deal.deal.dealId, 'dates')}
            className="text-accent-text hover:underline"
          >
            Key dates
          </Link>
          ; duties that rest on them start when they’re confirmed.
        </p>
      ) : (
        dates.map((t) => {
          const live = t.entries[0]!;
          return (
            <Line key={t.key} label={t.label}>
              <span className="inline-flex items-center gap-1.5">
                {termValueWords({
                  valueDate: live.date,
                  valueTime: live.time,
                  valueCents: live.cents,
                  valueText: live.text,
                }).replace(/, \d{4}/, '')}
                {t.conflict ? (
                  <Badge variant="danger">Conflict</Badge>
                ) : !t.confirmed ? (
                  <Badge variant="pending">Confirm</Badge>
                ) : live.source === 'amendment' ? (
                  <Badge variant="pending">Amended</Badge>
                ) : null}
              </span>
            </Line>
          );
        })
      )}
      {deal.dateProblems.length ? (
        <ul className="mt-2 space-y-1 text-[12.5px]">
          {deal.dateProblems.map((p) => (
            <li
              key={p.check + p.keys.join()}
              className={p.severity === 'problem' ? 'text-danger-text' : 'text-warning-text'}
            >
              {p.words}
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

export function PeopleCard({
  workspaceId,
  deal,
  members,
}: {
  workspaceId: string;
  deal: DealGet;
  members: readonly Teammate[];
}) {
  const [adding, setAdding] = useState<'team' | 'party' | 'property' | null>(null);
  const { busy, act } = useAct();
  const dealId = deal.deal.dealId;
  const open = !deal.deal.archived;
  return (
    <Card className="p-4 md:p-5" data-testid="deal-people">
      <CardHead title="People" />
      <ul className="space-y-0.5">
        {deal.team.map((t) => (
          <li
            key={t.userId}
            className="group flex items-baseline justify-between gap-3 py-1 text-[13.5px]"
          >
            <span>{t.name}</span>
            <span className="flex items-center gap-1.5 text-text-2">
              {DEAL_ROLE_LABELS[t.role as DealRole] ?? t.role}
              {deal.can.changeTeam && !t.main && open ? (
                <button
                  type="button"
                  aria-label={`Take ${t.name} off the deal`}
                  className="rounded p-0.5 text-text-3 hover:text-danger-text"
                  disabled={busy !== null}
                  onClick={() =>
                    confirm(`Take ${t.name} off this deal? They won’t see it anymore.`) &&
                    void act(
                      `team-${t.userId}`,
                      async () =>
                        unwrap(
                          await apiBrowser().POST('/v1/commands/realestate.deal.remove_person', {
                            body: { workspaceId, dealId, userId: t.userId },
                          }),
                        ),
                      `${t.name} is off the deal.`,
                    )
                  }
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </span>
          </li>
        ))}
        {deal.parties.map((p) => (
          <li
            key={p.relationshipId}
            className="flex items-baseline justify-between gap-3 py-1 text-[13.5px]"
          >
            <Link
              href={
                p.personId
                  ? `/app/w/${workspaceId}/customers/people/${p.personId}`
                  : `/app/w/${workspaceId}/customers/companies/${p.companyId}`
              }
              className="truncate hover:underline"
            >
              {p.name}
            </Link>
            <span className="flex flex-none items-center gap-1.5 text-text-2">
              {p.label}
              {open ? (
                <button
                  type="button"
                  aria-label={`Take ${p.name} off the deal`}
                  className="rounded p-0.5 text-text-3 hover:text-danger-text"
                  disabled={busy !== null}
                  onClick={() =>
                    confirm(`Take ${p.name} off this deal as ${p.label.toLowerCase()}?`) &&
                    void act(
                      `party-${p.relationshipId}`,
                      async () =>
                        unwrap(
                          await apiBrowser().POST('/v1/commands/realestate.party.remove', {
                            body: { workspaceId, dealId, relationshipId: p.relationshipId },
                          }),
                        ),
                      'Taken off the deal.',
                    )
                  }
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </span>
          </li>
        ))}
        <li className="flex items-baseline justify-between gap-3 py-1 text-[13.5px]">
          <span className="text-text-2">Property</span>
          {deal.property ? (
            <Link
              href={`/app/w/${workspaceId}/customers/records/${deal.property.propertyId}`}
              className="truncate hover:underline"
            >
              {deal.property.address}
            </Link>
          ) : open ? (
            <button
              type="button"
              className="text-accent-text hover:underline"
              onClick={() => setAdding('property')}
            >
              Add the property
            </button>
          ) : (
            <span>—</span>
          )}
        </li>
      </ul>
      {open ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {deal.can.changeTeam ? (
            <Button size="sm" variant="secondary" onClick={() => setAdding('team')}>
              Add from your team
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setAdding('party')}
            data-testid="add-party"
          >
            Add a client or contact
          </Button>
        </div>
      ) : null}
      <TeamDialog
        open={adding === 'team'}
        onOpenChange={(o) => !o && setAdding(null)}
        workspaceId={workspaceId}
        dealId={dealId}
        members={members}
        team={deal.team}
        canChooseMain={deal.can.chooseMainAgent}
      />
      <PartyDialog
        open={adding === 'party'}
        onOpenChange={(o) => !o && setAdding(null)}
        workspaceId={workspaceId}
        dealId={dealId}
      />
      <PropertyDialog
        open={adding === 'property'}
        onOpenChange={(o) => !o && setAdding(null)}
        workspaceId={workspaceId}
        dealId={dealId}
      />
    </Card>
  );
}

export function CommissionCard({ workspaceId, deal }: { workspaceId: string; deal: DealGet }) {
  const [editing, setEditing] = useState<'terms' | 'final' | null>(null);
  const c = deal.commission;
  const price = deal.terms.find((t) => t.key === 'price')?.entries[0]?.cents ?? null;
  const agreed =
    c.rateBp !== null
      ? `${c.rateBp / 100}%${price !== null ? ` of ${money(price)}` : ''}`
      : c.flatCents !== null
        ? money(c.flatCents)
        : 'Not set';
  return (
    <Card className="p-4 md:p-5" data-testid="deal-commission">
      <CardHead
        title="Commission"
        action={
          !deal.deal.archived ? (
            <Button size="sm" variant="ghost" onClick={() => setEditing('terms')}>
              Edit
            </Button>
          ) : null
        }
      />
      <Line label="Agreed">{agreed}</Line>
      {c.creditCents ? <Line label="Credit to the client">{money(c.creditCents)}</Line> : null}
      {c.splitBp !== null ? (
        <Line label="Brokerage split">
          {c.splitBp / 100} / {100 - c.splitBp / 100}
        </Line>
      ) : null}
      <Line label="Expected to you">
        {c.agentShareCents !== null
          ? money(c.agentShareCents)
          : c.expectedCents !== null
            ? money(c.expectedCents)
            : '—'}
      </Line>
      <Line label="Final">
        {c.finalCents !== null ? (
          money(c.finalCents)
        ) : deal.can.except ? (
          <button
            type="button"
            className="text-accent-text hover:underline"
            onClick={() => setEditing('final')}
          >
            Set it
          </button>
        ) : (
          <span className="text-text-3">Set by an owner or admin after closing</span>
        )}
      </Line>
      <CommissionDialog
        open={editing === 'terms'}
        onOpenChange={(o) => !o && setEditing(null)}
        workspaceId={workspaceId}
        dealId={deal.deal.dealId}
        commission={c}
      />
      <FinalCommissionDialog
        open={editing === 'final'}
        onOpenChange={(o) => !o && setEditing(null)}
        workspaceId={workspaceId}
        dealId={deal.deal.dealId}
        expectedCents={c.agentShareCents ?? c.expectedCents}
      />
    </Card>
  );
}

const DRAFT_STATUS: Readonly<Record<Draft['status'], string>> = {
  drafting: 'Being written',
  ready: 'Ready to check',
  sent: 'Sent',
  discarded: 'Thrown away',
  failed: 'Couldn’t be written',
};

export function UpdatesCard({
  workspaceId,
  dealId,
  drafts,
}: {
  workspaceId: string;
  dealId: string;
  drafts: readonly Draft[];
}) {
  const router = useRouter();
  const { busy, act } = useAct();
  const shown = drafts.filter((d) => d.status !== 'discarded').slice(0, 4);
  return (
    <Card className="p-4 md:p-5" data-testid="deal-updates">
      <CardHead
        title="Client updates"
        action={
          <Button
            size="sm"
            variant="ghost"
            loading={busy === 'ask'}
            onClick={() =>
              void act('ask', async () => {
                const out = unwrap(
                  await apiBrowser().POST('/v1/commands/realestate.status_email.request', {
                    body: { workspaceId, dealId, milestone: 'asked' },
                  }),
                );
                router.push(dealHref(workspaceId, dealId, `updates/${out.draftId}`));
              })
            }
            data-testid="request-update"
          >
            Draft one
          </Button>
        }
      />
      {shown.length === 0 ? (
        <p className="text-[13px] text-text-2">
          The Assistant drafts one from this deal’s facts at each milestone. You check it and send
          it.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {shown.map((d) => (
            <li key={d.draftId}>
              <Link
                href={dealHref(workspaceId, dealId, `updates/${d.draftId}`)}
                className="flex items-baseline justify-between gap-3 text-[13.5px] hover:underline"
              >
                <span className="truncate">
                  {d.subject ?? MILESTONE_WORDS[d.milestone] ?? 'Update'}
                </span>
                <span className="flex-none text-text-2">{DRAFT_STATUS[d.status]}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
