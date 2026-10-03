'use client';
/**
 * Keeping a deal (round six, board 93, design/realestate/PhoneRecords.dc.html): Deal settings → Keeping records (how
 * long closed deals are kept, and the deals on legal hold), a deal's legal hold (its banner, placing and lifting it,
 * core's `record_hold.*`, `records.hold`), and the whole transaction exported (`realestate.deal.export`, listed on the
 * deal's Documents). Every word is core's (`@hfos/core` record-holds.ts, realestate/keeping-words.ts), so the phone
 * says the same.
 */
import { fmtAt, LEGAL_HOLD_WORDS, legalHoldBanner, legalHoldLine } from '@hfos/core';
import {
  EXPORT_WORDS,
  exportLine,
  KEEPING_WORDS,
} from '@hfos/core/addons/realestate/keeping-words';
import {
  RealestateSettingsSchema,
  type RealestateSettings,
} from '@hfos/core/addons/realestate/settings';
import { Download, FileArchive, Lock } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Callout } from '@/components/crm/chips';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { CardHead, dealHref } from './bits';
import { ReasonDialog } from './deal-dialogs';
import type { DealExport, Hold } from './types';
import { useAct } from './use-act';

/** Deal settings → Keeping records: the years closed deals are kept, and every deal on legal hold. */
export function KeepingRecords({
  workspaceId,
  timeZone,
  settings,
  holds,
  canHold,
}: {
  workspaceId: string;
  timeZone: string;
  settings: RealestateSettings;
  holds: readonly Hold[];
  canHold: boolean;
}) {
  const router = useRouter();
  const [years, setYears] = useState(String(settings.keepClosedYears));
  const [lifting, setLifting] = useState<Hold | null>(null);
  const { busy, act } = useAct();
  useEffect(() => setYears(String(settings.keepClosedYears)), [settings.keepClosedYears]);
  // The add-on's own rule, so the words here are the server's.
  const checked = RealestateSettingsSchema.shape.keepClosedYears.safeParse(Number(years));
  const problem =
    years.trim() === ''
      ? 'Enter how many years.'
      : !Number.isInteger(Number(years))
        ? 'Pick a whole number of years.'
        : checked.success
          ? null
          : (checked.error.issues[0]?.message ?? 'Pick a whole number of years.');
  const changed = checked.success && checked.data !== settings.keepClosedYears;
  return (
    <div className="grid max-w-3xl gap-4" data-testid="keeping-records">
      <Card className="p-4 md:p-5">
        <h2 className="text-[15px] font-semibold">{KEEPING_WORDS.keepTitle}</h2>
        <form
          className="mt-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!checked.success || !changed) return;
            const n = checked.data;
            void act(
              'keep',
              async () => {
                unwrap(
                  await apiBrowser().POST('/v1/commands/addon.save_settings', {
                    body: {
                      workspaceId,
                      addonId: 'realestate',
                      settings: { ...settings, keepClosedYears: n } as unknown as Record<
                        string,
                        unknown
                      >,
                    },
                  }),
                );
                router.refresh();
              },
              KEEPING_WORDS.keepSaved(n),
            );
          }}
        >
          <div className="flex flex-wrap items-center gap-2.5">
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              max={30}
              step={1}
              className="w-20"
              aria-label="Years"
              aria-invalid={problem ? true : undefined}
              value={years}
              onChange={(e) => setYears(e.target.value)}
              data-testid="keep-years"
            />
            <span className="text-[13.5px]">{KEEPING_WORDS.yearsAfter}</span>
            <Button
              type="submit"
              variant="secondary"
              size="sm"
              disabled={!changed}
              loading={busy === 'keep'}
              data-testid="keep-save"
            >
              Save
            </Button>
          </div>
          {problem ? (
            <p className="mt-1.5 text-[12.5px] text-danger-text" role="alert">
              {problem}
            </p>
          ) : null}
        </form>
        <p className="mt-3 text-[13px] text-text-2">{KEEPING_WORDS.keepAbout}</p>
      </Card>
      <Card className="p-4 md:p-5" data-testid="legal-holds">
        <h2 className="text-[15px] font-semibold">{KEEPING_WORDS.holdsTitle(holds.length)}</h2>
        {holds.length ? (
          <ul className="mt-2 divide-y divide-border">
            {holds.map((h) => (
              <li
                key={h.id}
                className="flex items-center justify-between gap-3 py-2.5"
                data-testid={`legal-hold-${h.customRecordId}`}
              >
                <div className="min-w-0">
                  <Link
                    href={dealHref(workspaceId, h.customRecordId)}
                    className="text-[14px] hover:underline"
                  >
                    {h.recordName}
                  </Link>
                  <div className="text-[12.5px] text-text-3">{legalHoldLine(h, timeZone)}</div>
                </div>
                {canHold ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setLifting(h)}
                    data-testid={`lift-hold-${h.customRecordId}`}
                  >
                    {LEGAL_HOLD_WORDS.lift}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-[13.5px] text-text-2">{KEEPING_WORDS.noHolds}</p>
        )}
        <p className="mt-2 text-[12.5px] text-text-3">
          {KEEPING_WORDS.holdsAbout}
          {canHold ? '' : ` ${KEEPING_WORDS.holdsOnlyOwners}`}
        </p>
      </Card>
      <LiftHoldDialog workspaceId={workspaceId} hold={lifting} onClose={() => setLifting(null)} />
    </div>
  );
}

/** A deal's banner while it's on legal hold (board 93's first panel), with Lift… for owners and admins. */
export function HoldBanner({
  hold,
  timeZone,
  onLift,
}: {
  hold: Hold;
  timeZone: string;
  onLift?: () => void;
}) {
  const words = legalHoldBanner(hold, timeZone);
  return (
    <Callout
      tone="info"
      icon={Lock}
      className="mb-4"
      data-testid="deal-hold"
      action={
        onLift ? (
          <Button size="sm" variant="secondary" onClick={onLift} data-testid="deal-hold-lift">
            {LEGAL_HOLD_WORDS.lift}
          </Button>
        ) : undefined
      }
    >
      <span className="font-semibold">{words.title}</span>{' '}
      <span className="text-text-2">{words.body}</span>
    </Callout>
  );
}

/** Placing a legal hold on a deal: a reason, kept with the hold and in the deal's history. */
export function PlaceHoldDialog({
  open,
  onOpenChange,
  workspaceId,
  dealId,
  dealName,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  workspaceId: string;
  dealId: string;
  dealName: string;
}) {
  return (
    <ReasonDialog
      open={open}
      onOpenChange={onOpenChange}
      title={LEGAL_HOLD_WORDS.placeTitle(dealName)}
      description={LEGAL_HOLD_WORDS.placeAbout}
      label={LEGAL_HOLD_WORDS.reasonLabel}
      submit={LEGAL_HOLD_WORDS.placeSubmit}
      done={LEGAL_HOLD_WORDS.placeDone}
      run={async (reason) =>
        unwrap(
          await apiBrowser().POST('/v1/commands/record_hold.place', {
            body: { workspaceId, customRecordId: dealId, reason },
          }),
        )
      }
    />
  );
}

/** Lifting one: a reason, kept in the deal's history. */
export function LiftHoldDialog({
  workspaceId,
  hold,
  onClose,
}: {
  workspaceId: string;
  hold: Hold | null;
  onClose: () => void;
}) {
  return (
    <ReasonDialog
      open={hold !== null}
      onOpenChange={(o) => !o && onClose()}
      title={hold ? LEGAL_HOLD_WORDS.liftTitle(hold.recordName) : LEGAL_HOLD_WORDS.liftSubmit}
      description={LEGAL_HOLD_WORDS.liftAbout}
      label={LEGAL_HOLD_WORDS.reasonLabel}
      submit={LEGAL_HOLD_WORDS.liftSubmit}
      danger
      done={LEGAL_HOLD_WORDS.liftDone}
      run={async (reason) =>
        hold &&
        unwrap(
          await apiBrowser().POST('/v1/commands/record_hold.lift', {
            body: { workspaceId, holdId: hold.id, reason },
          }),
        )
      }
    />
  );
}

/** "Export the whole transaction" (board 93's second panel, as the web says it): what's in it, and Make the file. */
export function ExportDialog({
  open,
  onOpenChange,
  workspaceId,
  dealId,
  onAsked,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  workspaceId: string;
  dealId: string;
  /** After it's asked for: the deal page offers its Documents; Documents shows it making. */
  onAsked?: () => void;
}) {
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const { busy, act } = useAct(close);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={EXPORT_WORDS.title} description={EXPORT_WORDS.about}>
        <p className="mt-3 text-[13px] text-text-2">{EXPORT_WORDS.told}</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            loading={busy === 'export'}
            onClick={() =>
              void act(
                'export',
                async () => {
                  unwrap(
                    await apiBrowser().POST('/v1/commands/realestate.deal.export', {
                      body: { workspaceId, dealId },
                    }),
                  );
                  onAsked?.();
                },
                EXPORT_WORDS.asked,
              )
            }
            data-testid="export-go"
          >
            {EXPORT_WORDS.submit}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** A file the browser can open: what file.list says about the export's zip. */
export interface ExportFile {
  readonly id: string;
  readonly name: string;
  readonly sizeBytes: number | null;
  readonly open: () => Promise<void>;
}

/** The deal's Documents → Exports: each export's file, where it stands, and Download once it's ready. */
export function ExportsCard({
  workspaceId,
  dealId,
  timeZone,
  exports,
  fileOf,
}: {
  workspaceId: string;
  dealId: string;
  timeZone: string;
  exports: readonly DealExport[];
  fileOf: (fileId: string | null) => ExportFile | null;
}) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  // The worker builds it in a minute or so: look again until it has.
  const making = exports.some((x) => x.state === 'building');
  useEffect(() => {
    if (!making) return;
    const t = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(t);
  }, [making, router]);
  return (
    <Card className="mt-4 p-4 md:p-5" data-testid="deal-exports">
      <CardHead
        title={EXPORT_WORDS.listTitle}
        action={
          <Button
            size="sm"
            variant="secondary"
            disabled={making}
            onClick={() => setAsking(true)}
            data-testid="exports-new"
          >
            {EXPORT_WORDS.menu}
          </Button>
        }
      />
      {exports.length === 0 ? (
        <p className="text-[13.5px] text-text-2">{EXPORT_WORDS.none}</p>
      ) : (
        <ul className="divide-y divide-border">
          {exports.map((x) => {
            const f = x.state === 'ready' ? fileOf(x.fileId) : null;
            return (
              <li
                key={x.id}
                className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 py-2.5"
                data-testid={`export-${x.id}`}
              >
                <div className="flex min-w-0 flex-1 basis-[16rem] items-start gap-2.5">
                  <FileArchive className="mt-0.5 h-4 w-4 flex-none text-text-3" strokeWidth={1.5} />
                  <div className="min-w-0">
                    <div className="break-words text-[13.5px] font-medium">
                      {f?.name ??
                        (x.state === 'building'
                          ? EXPORT_WORDS.making
                          : `Asked for ${fmtAt(x.requestedAt, timeZone)}`)}
                    </div>
                    <div className="text-[12.5px] text-text-3">
                      {x.state === 'ready'
                        ? exportLine({
                            files: typeof x.counts.files === 'number' ? x.counts.files : null,
                            sizeBytes: f?.sizeBytes ?? null,
                          })
                        : x.state === 'failed'
                          ? (x.failure ?? EXPORT_WORDS.failedLine)
                          : `Asked for ${fmtAt(x.requestedAt, timeZone)}. ${EXPORT_WORDS.makingLine}`}
                    </div>
                  </div>
                </div>
                <div className="flex flex-none items-center gap-2">
                  <Badge
                    variant={
                      x.state === 'ready' ? 'ok' : x.state === 'failed' ? 'danger' : 'pending'
                    }
                    data-testid="export-state"
                  >
                    {EXPORT_WORDS.states[x.state]}
                  </Badge>
                  {f ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => f.open().catch((e: Error) => toast.error(e.message))}
                      data-testid="export-download"
                    >
                      <Download className="h-4 w-4" strokeWidth={1.75} />
                      {EXPORT_WORDS.download}
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <ExportDialog
        open={asking}
        onOpenChange={setAsking}
        workspaceId={workspaceId}
        dealId={dealId}
      />
    </Card>
  );
}
