'use client';
import { WIZARD_WORDS, type CustomerSource } from '@hfos/core';
import { Clock } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { ImportWizard } from '@/components/import/import-wizard';
import { ConnectSourceButton, StartMigrationButton } from '@/components/migrations/connect';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { RadioCard } from '@/components/ui/radio-card';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { keepSetupReturn } from '@/lib/setup-return';

type Way = 'migrate' | 'sheet' | 'asYouGo';

/** The way that fits where the quick questions said the customers are. */
const FITS: Record<CustomerSource, Way> = {
  ghl: 'migrate',
  sheet: 'sheet',
  crm: 'sheet',
  phone: 'sheet',
  none: 'asYouGo',
};

const WAYS: readonly Way[] = ['migrate', 'sheet', 'asYouGo'];

/**
 * The wizard's customers step (board 4): move from GoHighLevel, import a spreadsheet, or add them as they come.
 * Each is the screen that already does it. A move from GoHighLevel starts by counting what's there, which takes a
 * while on a big account, so the wizard carries on meanwhile and the move has its own page.
 */
export function CustomersSetup({
  workspaceId,
  organizationId,
  customersIn,
  connection,
  move,
  canImport,
  canMigrate,
}: {
  workspaceId: string;
  organizationId: string;
  customersIn: CustomerSource | null;
  /** GoHighLevel, connected and ready to look at. */
  connection: { id: string; sourceLabel: string } | null;
  /** The newest move not finished or stopped: still counting (`running`), or waiting for a look. */
  move: { id: string; running: boolean; words: string } | null;
  canImport: boolean;
  canMigrate: boolean;
}) {
  const router = useRouter();
  const fits = customersIn ? FITS[customersIn] : null;
  const [way, setWay] = useState<Way>(move ? 'migrate' : (fits ?? 'sheet'));
  const [busy, setBusy] = useState(false);
  const offered = WAYS.filter(
    (w) => (w !== 'migrate' || canMigrate) && (w !== 'sheet' || canImport),
  );

  async function asYouGo() {
    setBusy(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/onboarding.as_you_go', {
          body: { workspaceId, asYouGo: true },
        }),
      );
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {customersIn ? (
        <p className="-mt-2 text-[13.5px] text-text-2">{WIZARD_WORDS.customersSaid[customersIn]}</p>
      ) : null}
      <div
        role="radiogroup"
        aria-label={WIZARD_WORDS.titles.customers}
        className="flex flex-col gap-2.5"
      >
        {offered.map((w) => (
          <RadioCard
            key={w}
            selected={way === w}
            onSelect={() => setWay(w)}
            title={
              <span className="flex flex-wrap items-center gap-2">
                {WIZARD_WORDS.ways[w].title}
                {w === fits ? <Badge variant="ok">{WIZARD_WORDS.fitsAnswer}</Badge> : null}
              </span>
            }
            description={WIZARD_WORDS.ways[w].detail}
            testId={`setup-customers-${w}`}
          />
        ))}
      </div>

      {way === 'migrate' ? (
        move ? (
          <div
            className="flex flex-wrap items-start gap-3 rounded-menu bg-accent-soft px-4 py-3.5"
            data-testid="setup-customers-move"
          >
            <Clock className="mt-0.5 h-4 w-4 flex-none text-accent-text" strokeWidth={1.75} />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="font-medium">
                {move.running ? WIZARD_WORDS.migrationCounting.title : move.words}
              </span>
              <span className="text-[13px] text-text-2">
                {move.running ? WIZARD_WORDS.migrationCounting.detail : WIZARD_WORDS.migrationReady}
              </span>
            </div>
            <ButtonLink
              href={`/app/w/${workspaceId}/settings/migrations/${move.id}`}
              variant="secondary"
              size="sm"
            >
              {WIZARD_WORDS.migrationOpen}
            </ButtonLink>
          </div>
        ) : connection ? (
          <div>
            <StartMigrationButton
              organizationId={organizationId}
              workspaceId={workspaceId}
              connectionId={connection.id}
              sourceLabel={connection.sourceLabel}
              onStarted={() => router.refresh()}
            />
          </div>
        ) : (
          <div>
            <ConnectSourceButton
              organizationId={organizationId}
              workspaceId={workspaceId}
              beforeLeave={() => keepSetupReturn(workspaceId, 'customers')}
            />
          </div>
        )
      ) : way === 'sheet' ? (
        <ImportWizard workspaceId={workspaceId} />
      ) : (
        <div>
          <Button
            loading={busy}
            onClick={() => void asYouGo()}
            data-testid="setup-customers-as-you-go"
          >
            {WIZARD_WORDS.asYouGoAction}
          </Button>
        </div>
      )}
    </>
  );
}
