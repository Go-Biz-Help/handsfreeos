'use client';
import { Upload } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Segmented } from '@/components/ui/segmented';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { parseFaqCsv, type FaqCsv } from '@/lib/knowledge/csv';
import { cn } from '@/lib/utils';

const MAX_BYTES = 2 * 1024 * 1024;

/** "Import CSV": pick a spreadsheet of FAQs, check the rows and their problems, then import the good ones. */
export function ImportFaqs({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<{ name: string; csv: FaqCsv } | null>(null);
  const [status, setStatus] = useState<'draft' | 'published'>('draft');
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const good = file?.csv.rows.filter((r) => !r.problems.length) ?? [];
  const bad = file?.csv.rows.filter((r) => r.problems.length) ?? [];

  function reset(next: boolean) {
    setOpen(next);
    if (!next) {
      setFile(null);
      setServerError(null);
      setStatus('draft');
    }
  }
  async function choose(f: File | undefined) {
    if (!f) return;
    setServerError(null);
    if (f.size > MAX_BYTES)
      return toast.error('That file is over 2 MB. Split it into smaller files.');
    try {
      setFile({ name: f.name, csv: parseFaqCsv(await f.text()) });
    } catch (e) {
      toast.error(`Couldn’t read the file: ${errorMessage(e)}`);
    }
  }
  async function importRows() {
    if (!good.length) return;
    setBusy(true);
    setServerError(null);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/knowledge_item.import_faqs', {
          body: {
            workspaceId,
            status,
            rows: good.map((r) => ({ question: r.question, answer: r.answer, tags: [...r.tags] })),
          },
        }),
      );
      const skipped = out.skipped.length
        ? ` ${out.skipped.length} ${out.skipped.length === 1 ? 'was' : 'were'} already in the knowledge base.`
        : '';
      toast.success(
        `Imported ${out.created} ${out.created === 1 ? 'FAQ' : 'FAQs'}${status === 'published' ? ' and published them' : ' as drafts'}.${skipped}`,
      );
      reset(false);
      router.refresh();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'validation' && Array.isArray(e.details)) {
        const first = (e.details as { path?: string; message?: string }[])[0];
        const row = /rows\.(\d+)/.exec(first?.path ?? '')?.[1];
        setServerError(
          row !== undefined && good[Number(row)]
            ? `Row ${good[Number(row)]!.line}: ${first?.message ?? 'this row has a problem.'}`
            : e.message,
        );
      } else setServerError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={reset}>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)} data-testid="import-csv">
        <Upload className="h-4 w-4" strokeWidth={1.5} />
        Import CSV
      </Button>
      <DialogContent
        title="Import FAQs from a spreadsheet"
        description="A CSV with a question and an answer on each row, and tags if you like (separate several with ;)."
        className="w-[min(720px,calc(100vw-32px))]"
      >
        <div className="mt-4 flex flex-col gap-3" data-testid="import-dialog">
          <input
            ref={input}
            type="file"
            accept=".csv,text/csv,text/plain"
            className="sr-only"
            aria-label="Choose a CSV file"
            data-testid="import-file"
            onChange={(e) => {
              void choose(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
          {!file ? (
            <div className="flex flex-col items-center gap-2 rounded-card border-[1.5px] border-dashed border-border-strong px-4 py-6 text-center">
              <pre className="rounded-control bg-card-2 px-3 py-2 text-left font-mono text-[12px] leading-relaxed text-text-2">
                {'question,answer,tags\n"Do you offer financing?","Yes, on new systems.",Financing'}
              </pre>
              <Button size="sm" variant="secondary" onClick={() => input.current?.click()}>
                Choose a CSV file
              </Button>
              <span className="text-xs text-text-3">
                Up to 500 rows. The first row can name the columns.
              </span>
            </div>
          ) : file.csv.error ? (
            <div className="flex flex-col gap-2">
              <p
                role="alert"
                className="rounded-[10px] bg-danger-soft px-3 py-2.5 text-[13px] text-danger-text"
              >
                {file.name}: {file.csv.error}
              </p>
              <Button
                size="sm"
                variant="secondary"
                className="self-start"
                onClick={() => input.current?.click()}
              >
                Choose another file
              </Button>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
                <span data-testid="import-summary">
                  <span className="font-medium">{file.name}</span>: {good.length}{' '}
                  {good.length === 1 ? 'FAQ' : 'FAQs'} ready
                  {bad.length
                    ? `, ${bad.length} ${bad.length === 1 ? 'row has a problem' : 'rows have problems'} and will be left out`
                    : ''}
                  .
                </span>
                <button
                  type="button"
                  onClick={() => input.current?.click()}
                  className="text-[13px] font-medium text-accent-text hover:underline"
                >
                  Choose another file
                </button>
              </div>
              <div className="max-h-[320px] overflow-auto rounded-[10px] border border-border">
                <table className="w-full min-w-[520px] border-separate border-spacing-0 text-left text-[13px]">
                  <thead className="sticky top-0 bg-card-2 text-xs text-text-3">
                    <tr>
                      <th className="border-b border-border px-3 py-2 font-medium">Row</th>
                      <th className="border-b border-border px-3 py-2 font-medium">Question</th>
                      <th className="border-b border-border px-3 py-2 font-medium">Answer</th>
                      <th className="border-b border-border px-3 py-2 font-medium">Tags</th>
                    </tr>
                  </thead>
                  <tbody>
                    {file.csv.rows.map((r) => (
                      <tr
                        key={r.line}
                        data-testid={r.problems.length ? 'import-row-bad' : 'import-row'}
                        className={cn(r.problems.length && 'bg-danger-soft')}
                      >
                        <td className="border-b border-border px-3 py-2 align-top text-text-3">
                          {r.line}
                        </td>
                        <td className="border-b border-border px-3 py-2 align-top">
                          {r.question || <span className="italic text-text-3">(empty)</span>}
                          {r.problems.length ? (
                            <span className="mt-1 block text-xs text-danger-text">
                              {r.problems.join(' ')}
                            </span>
                          ) : null}
                        </td>
                        <td className="border-b border-border px-3 py-2 align-top text-text-2">
                          <span className="line-clamp-2">{r.answer}</span>
                        </td>
                        <td className="border-b border-border px-3 py-2 align-top text-text-2">
                          {r.tags.join(', ')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-[13px]">
                <span className="text-text-2">Import them as</span>
                <Segmented<'draft' | 'published'>
                  ariaLabel="Import them as"
                  value={status}
                  onChange={setStatus}
                  options={[
                    { value: 'draft', label: 'Drafts to review', testId: 'import-as-draft' },
                    { value: 'published', label: 'Published', testId: 'import-as-published' },
                  ]}
                />
              </div>
              <p className="text-xs text-text-3">
                Questions already in the knowledge base are skipped.
              </p>
            </>
          )}
          {serverError ? (
            <p
              role="alert"
              className="rounded-[10px] bg-danger-soft px-3 py-2.5 text-[13px] text-danger-text"
            >
              {serverError}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => reset(false)}>
              Cancel
            </Button>
            <Button
              loading={busy}
              disabled={!good.length}
              onClick={() => void importRows()}
              data-testid="import-go"
            >
              {good.length
                ? `Import ${good.length} ${good.length === 1 ? 'FAQ' : 'FAQs'}`
                : 'Import'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
