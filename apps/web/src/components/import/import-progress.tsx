'use client';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { ImportGet } from '@/lib/api/types';
import { useLiveVersion } from '@/lib/realtime/live-provider';
import { cn } from '@/lib/utils';

const POLL_MS = 2500;

/** Progress, result and the rows that failed. Updates live (broadcast per batch) with a polling fallback. */
export function ImportProgress({
  workspaceId,
  importId,
  initial,
}: {
  workspaceId: string;
  importId: string;
  initial?: ImportGet;
}) {
  const [data, setData] = useState<ImportGet | null>(initial ?? null);
  const [cancelling, setCancelling] = useState(false);
  const version = useLiveVersion(['import']);
  const status = data?.import.status;
  const active = !status || status === 'pending' || status === 'running';

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const out = unwrap(
          await apiBrowser().POST('/v1/queries/import.get', { body: { workspaceId, importId } }),
        );
        if (!cancelled) setData(out);
      } catch (e) {
        if (!cancelled) toast.error(errorMessage(e));
      }
    };
    void load();
    const timer = active ? setInterval(load, POLL_MS) : null;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [workspaceId, importId, version, active]);

  async function cancel() {
    setCancelling(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/import.cancel', { body: { workspaceId, importId } }),
      );
      toast.success('Import cancelled. Rows already imported stay.');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setCancelling(false);
    }
  }

  if (!data)
    return (
      <Card className="p-6 text-[13px] text-text-2" data-testid="import-progress">
        Loading…
      </Card>
    );
  const imp = data.import;
  const total = imp.totalRows;
  const fraction = total > 0 ? Math.min(1, imp.processedRows / total) : status === 'done' ? 1 : 0;
  const title =
    status === 'done'
      ? 'Import finished'
      : status === 'cancelled'
        ? 'Import cancelled'
        : status === 'failed'
          ? 'Import failed'
          : `Importing ${imp.fileName}`;
  const badge =
    status === 'done' ? (
      <Badge variant="ok">Done</Badge>
    ) : status === 'cancelled' ? (
      <Badge variant="gray">Cancelled</Badge>
    ) : status === 'failed' ? (
      <Badge variant="revoked">Failed</Badge>
    ) : status === 'running' ? (
      <Badge variant="pending">Running</Badge>
    ) : (
      <Badge variant="pending">Waiting for the worker</Badge>
    );
  const finished = status === 'done' || status === 'cancelled' || status === 'failed';

  return (
    <div className="flex flex-col gap-4" data-testid="import-progress" data-status={status}>
      <Card className="p-5 md:p-6">
        <div className="mb-2.5 flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
          {badge}
        </div>
        <div
          className="mb-2 h-2 overflow-hidden rounded-full bg-card-2"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={total || 100}
          aria-valuenow={imp.processedRows}
        >
          <div
            className={cn(
              'h-full rounded-full transition-transform duration-300',
              status === 'failed' ? 'bg-danger' : 'bg-accent',
            )}
            style={{ transform: `scaleX(${fraction})`, transformOrigin: 'left center' }}
          />
        </div>
        <div className="flex items-center justify-between text-[13px] text-text-2">
          <span data-testid="import-processed">
            {imp.processedRows} of {total || '?'} rows
          </span>
          {imp.lastError ? <span className="text-danger-text">{imp.lastError}</span> : null}
        </div>
        {finished ? null : (
          <div className="mt-3 flex items-center justify-between gap-3">
            <p className="text-xs text-text-3">
              Runs in the background. You can leave this page; every imported record shows up on the
              customers list as it lands.
            </p>
            <Button
              variant="ghost"
              size="sm"
              onClick={cancel}
              loading={cancelling}
              data-testid="import-cancel"
            >
              Cancel
            </Button>
          </div>
        )}
      </Card>

      {finished ? (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="import-result">
            {(
              [
                ['Created', imp.createdCount, 'text-success-text'],
                ['Updated', imp.updatedCount, ''],
                ['Skipped', imp.skippedCount, ''],
                ['Errors', imp.errorCount, imp.errorCount ? 'text-danger-text' : ''],
              ] as const
            ).map(([label, n, cls]) => (
              <Card key={label} className="p-4">
                <div className={cn('text-2xl font-semibold tracking-tight', cls)}>{n}</div>
                <div className="text-[13px] text-text-2">{label}</div>
              </Card>
            ))}
          </div>
          {data.errors.length > 0 ? (
            <Card className="overflow-hidden">
              <div className="px-5 pb-1.5 pt-4 md:px-6">
                <h3 className="text-[15px] font-semibold">Rows that did not import</h3>
                {imp.errorCount > data.errors.length ? (
                  <p className="text-xs text-text-3">
                    Showing the first {data.errors.length} of {imp.errorCount}.
                  </p>
                ) : null}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="import-errors">
                  <thead>
                    <tr className="bg-card-2 text-left text-xs font-medium text-text-2">
                      <th className="w-20 px-4 py-2">Row</th>
                      <th className="px-3 py-2">Problem</th>
                      <th className="px-3 py-2">Data</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.errors.map((e) => (
                      <tr key={e.rowNumber} className="border-t border-border align-top">
                        <td className="px-4 py-2 text-[13px] text-text-3">{e.rowNumber}</td>
                        <td className="px-3 py-2 text-[13px]">{e.message}</td>
                        <td className="max-w-[420px] truncate px-3 py-2 font-mono text-xs text-text-2">
                          {Object.values(e.raw ?? {})
                            .filter((v) => typeof v === 'string' && v)
                            .join(', ')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center gap-2 px-5 py-3.5 md:px-6">
                <a
                  href={`data:text/csv;charset=utf-8,${encodeURIComponent(errorsCsv(data.errors))}`}
                  download={`${imp.fileName.replace(/\.csv$/i, '')}-errors.csv`}
                  className="text-[13px] font-medium text-accent-text hover:underline"
                >
                  Download errors as CSV
                </a>
              </div>
            </Card>
          ) : null}
          <div className="flex justify-end">
            <ButtonLink
              href={`/app/w/${workspaceId}/customers${imp.kind === 'companies' ? '?tab=companies' : ''}`}
              variant="primary"
            >
              See the customers
            </ButtonLink>
          </div>
        </>
      ) : null}
    </div>
  );
}

function errorsCsv(errors: ImportGet['errors']): string {
  const quote = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const columns = [...new Set(errors.flatMap((e) => Object.keys(e.raw ?? {})))];
  const head = ['Row', 'Problem', ...columns].map(quote).join(',');
  const lines = errors.map((e) =>
    [
      e.rowNumber,
      e.message,
      ...columns.map((c) => (e.raw as Record<string, unknown> | null)?.[c] ?? ''),
    ]
      .map(quote)
      .join(','),
  );
  return [head, ...lines].join('\n');
}
