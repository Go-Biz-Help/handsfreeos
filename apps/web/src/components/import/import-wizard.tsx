'use client';
import {
  guessMapping,
  IMPORT_MAX_BYTES,
  IMPORT_MAX_ROWS,
  mapCompanyRow,
  mapPersonRow,
  normalizePhone,
  SKIP,
} from '@hfos/core';
import { Check, FileText, Upload } from 'lucide-react';
import Link from 'next/link';
import Papa from 'papaparse';
import { useRef, useState, type DragEvent } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { RadioCard } from '@/components/ui/radio-card';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { formatBytes } from '@/lib/format';
import { supabaseBrowser } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';
import { FIELD_LABELS, fieldsFor } from './fields';
import { ImportProgress } from './import-progress';

type Kind = 'people' | 'companies';
interface Parsed {
  file: File;
  headers: string[];
  rows: Record<string, string>[];
  total: number;
}
const STEPS = ['Upload', 'Match columns', 'Preview', 'Run'];
const PREVIEW_ROWS = 200;

export function ImportWizard({ workspaceId }: { workspaceId: string }) {
  const [step, setStep] = useState(1);
  const [kind, setKind] = useState<Kind>('people');
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [parsing, setParsing] = useState(false);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [onMatch, setOnMatch] = useState<'skip' | 'update'>('skip');
  const [callWhere, setCallWhere] = useState('');
  const [running, setRunning] = useState(false);
  const [importId, setImportId] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  function parse(file: File) {
    if (!/\.csv$/i.test(file.name) && file.type !== 'text/csv')
      return toast.error('Choose a CSV file.');
    if (file.size > IMPORT_MAX_BYTES) return toast.error('CSV files can be up to 10 MB.');
    setParsing(true);
    const rows: Record<string, string>[] = [];
    let total = 0;
    let headers: string[] = [];
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim(),
      step: (result) => {
        total++;
        if (headers.length === 0 && result.meta.fields) headers = result.meta.fields;
        if (rows.length < PREVIEW_ROWS) rows.push(result.data);
      },
      complete: () => {
        setParsing(false);
        if (total === 0 || headers.length === 0)
          return toast.error('That file has no rows to import.');
        if (total > IMPORT_MAX_ROWS)
          return toast.error(
            `That file has ${total.toLocaleString()} rows; the limit is ${IMPORT_MAX_ROWS.toLocaleString()}.`,
          );
        setParsed({ file, headers, rows, total });
        setMapping(guessMapping(headers, kind));
      },
      error: (err) => {
        setParsing(false);
        toast.error(`Could not read the file: ${err.message}`);
      },
    });
  }
  function pickKind(next: Kind) {
    setKind(next);
    if (parsed) setMapping(guessMapping(parsed.headers, next));
  }
  function onDrop(e: DragEvent) {
    e.preventDefault();
    setOver(false);
    const file = e.dataTransfer.files[0];
    if (file) parse(file);
  }

  const fields = fieldsFor(kind);
  const mapped = new Set(Object.values(mapping).filter((f) => f !== SKIP));
  const hasName =
    kind === 'people'
      ? mapped.has('first_name') || mapped.has('last_name') || mapped.has('full_name')
      : mapped.has('name');
  // "Agreed to calls": a yes needs where they agreed, from the row's own column or this one answer for the file.
  const callConsent = kind === 'people' && mapped.has('call_consent');
  const callWhereColumn = mapped.has('call_consent_source');
  const needsCallWhere = callConsent && !callWhereColumn && !callWhere.trim();
  const sample = (header: string) => parsed?.rows.find((r) => r[header]?.trim())?.[header] ?? '';

  const preview = (parsed?.rows ?? []).slice(0, 20).map((row, i) => {
    if (kind === 'people') {
      const m = mapPersonRow(row, mapping);
      const problems: string[] = [];
      if (!m.firstName && !m.lastName && !m.email && !m.phone) problems.push('empty');
      else if (!m.firstName && !m.lastName) problems.push('no name');
      if ([m.email, ...m.otherEmails].some((e) => e && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)))
        problems.push('bad email');
      if ([m.phone, ...m.otherPhones].some((p) => p && !normalizePhone(p)))
        problems.push('bad phone');
      const c = m.callConsent;
      if (c?.answer === 'unclear') problems.push('calls not yes or no');
      else if (c?.answer === 'opted_in' && !c.where && callWhereColumn && !callWhere.trim())
        problems.push('no where for calls');
      return {
        row: i + 2,
        name: [m.firstName, m.lastName].filter(Boolean).join(' ') || '—',
        phone: m.phone ?? '—',
        email: m.email ?? '—',
        company: m.company ?? '—',
        calls: c?.answer === 'opted_in' ? 'Agreed' : c?.answer === 'opted_out' ? 'No calls' : '—',
        problems,
      };
    }
    const m = mapCompanyRow(row, mapping);
    const problems: string[] = [];
    if (!m.name && !m.email && !m.phone) problems.push('empty');
    else if (!m.name) problems.push('no name');
    if (m.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(m.email)) problems.push('bad email');
    if (m.phone && !normalizePhone(m.phone)) problems.push('bad phone');
    return {
      row: i + 2,
      name: m.name || '—',
      phone: m.phone ?? '—',
      email: m.email ?? '—',
      company: m.website ?? '—',
      calls: '—',
      problems,
    };
  });
  const warnings = preview.filter((p) => p.problems.length).length;

  async function run() {
    if (!parsed) return;
    setRunning(true);
    try {
      const created = unwrap(
        await apiBrowser().POST('/v1/commands/import.create', {
          body: { workspaceId, kind, fileName: parsed.file.name },
        }),
      );
      const { error } = await supabaseBrowser()
        .storage.from(created.bucket)
        .upload(created.objectPath, parsed.file, { contentType: 'text/csv', upsert: false });
      if (error) throw new Error(`Upload failed: ${error.message}`);
      unwrap(
        await apiBrowser().POST('/v1/commands/import.start', {
          body: {
            workspaceId,
            importId: created.importId,
            mapping,
            options: {
              onMatch,
              ...(callConsent && callWhere.trim() ? { callConsentSource: callWhere.trim() } : {}),
            },
          },
        }),
      );
      setImportId(created.importId);
      setStep(4);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="max-w-[980px]">
      <ol className="mb-5 flex flex-wrap items-center gap-1.5" aria-label="Steps">
        {STEPS.map((name, i) => {
          const n = i + 1;
          const state = n === step ? 'active' : n < step ? 'done' : 'todo';
          return (
            <li key={name} className="flex items-center gap-1.5">
              <span
                className={cn(
                  'flex items-center gap-2 text-[13px] font-medium',
                  state === 'active'
                    ? 'text-accent-text'
                    : state === 'done'
                      ? 'text-success-text'
                      : 'text-text-3',
                )}
                aria-current={state === 'active' ? 'step' : undefined}
              >
                <span
                  className={cn(
                    'inline-flex h-6 w-6 items-center justify-center rounded-full border-[1.5px] text-xs',
                    state === 'active'
                      ? 'border-accent bg-accent text-white'
                      : state === 'done'
                        ? 'border-success bg-success text-white'
                        : 'border-border-strong',
                  )}
                >
                  {state === 'done' ? <Check className="h-3.5 w-3.5" strokeWidth={2.5} /> : n}
                </span>
                {name}
              </span>
              {i < STEPS.length - 1 ? (
                <span className="h-px w-6 bg-border sm:w-8" aria-hidden />
              ) : null}
            </li>
          );
        })}
      </ol>

      {step === 1 ? (
        <Card className="max-w-[760px] p-5 md:p-6" data-testid="import-step-upload">
          <div
            role="radiogroup"
            aria-label="What is in the file"
            className="mb-4 flex flex-col gap-3 sm:flex-row"
          >
            <RadioCard
              selected={kind === 'people'}
              onSelect={() => pickKind('people')}
              title="People"
              description="Homeowners and contacts, one per row"
              testId="import-kind-people"
            />
            <RadioCard
              selected={kind === 'companies'}
              onSelect={() => pickKind('companies')}
              title="Companies"
              description="Businesses and property managers"
              testId="import-kind-companies"
            />
          </div>
          <input
            ref={input}
            type="file"
            accept=".csv,text/csv"
            className="sr-only"
            aria-label="Choose a CSV file"
            data-testid="import-file"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) parse(f);
              e.target.value = '';
            }}
          />
          {parsed ? (
            <div
              className="flex items-center gap-3 rounded-menu border border-border px-4 py-3.5"
              data-testid="import-file-summary"
            >
              <span className="inline-flex h-8 w-8 flex-none items-center justify-center rounded-control bg-card-2 text-text-2">
                <FileText className="h-[18px] w-[18px]" strokeWidth={1.5} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-semibold">{parsed.file.name}</span>
                <span className="text-xs text-text-3">
                  {parsed.total.toLocaleString()} rows · {parsed.headers.length} columns ·{' '}
                  {formatBytes(parsed.file.size)}
                </span>
              </span>
              <Badge variant="ok">
                <Check className="h-3.5 w-3.5" strokeWidth={2} />
                Looks good
              </Badge>
              <Button variant="ghost" size="sm" onClick={() => setParsed(null)}>
                Remove
              </Button>
            </div>
          ) : (
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setOver(true);
              }}
              onDragLeave={() => setOver(false)}
              onDrop={onDrop}
              className={cn(
                'flex flex-col items-center rounded-card border-[1.5px] border-dashed p-8 text-center',
                over ? 'border-accent bg-accent-soft' : 'border-border-strong',
              )}
            >
              <Upload className="h-5 w-5 text-text-2" strokeWidth={1.5} />
              <div className="mt-2 font-semibold">Drop a CSV here</div>
              <div className="mt-1 text-[13px] text-text-3">
                Exported from a spreadsheet, QuickBooks or another CRM. Up to 10 MB or 20,000 rows.
              </div>
              <Button
                variant="secondary"
                className="mt-3.5"
                loading={parsing}
                onClick={() => input.current?.click()}
              >
                Choose file
              </Button>
            </div>
          )}
          <div className="mt-4 flex justify-end">
            <Button disabled={!parsed} onClick={() => setStep(2)} data-testid="import-next">
              Continue
            </Button>
          </div>
        </Card>
      ) : null}

      {step === 2 && parsed ? (
        <Card className="max-w-[860px] overflow-hidden" data-testid="import-step-map">
          <div className="px-5 pb-1.5 pt-4 md:px-6">
            <h2 className="text-lg font-semibold tracking-tight">Match columns</h2>
            <p className="text-[13px] text-text-2">
              We guessed from the headers. Fix anything that looks wrong.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-card-2 text-left text-xs font-medium text-text-2">
                  <th className="w-[32%] px-4 py-2">Column in your file</th>
                  <th className="w-[30%] px-3 py-2">Sample</th>
                  <th className="px-3 py-2">Becomes</th>
                </tr>
              </thead>
              <tbody>
                {parsed.headers.map((h) => (
                  <tr key={h} className="border-t border-border">
                    <td className="px-4 py-2 text-[13px] font-semibold">{h}</td>
                    <td className="max-w-[240px] truncate px-3 py-2 text-[13px] text-text-2">
                      {sample(h)}
                    </td>
                    <td className="px-3 py-1.5">
                      <Select
                        selectSize="sm"
                        className="w-[240px]"
                        value={mapping[h] ?? SKIP}
                        onChange={(e) => setMapping((m) => ({ ...m, [h]: e.target.value }))}
                        aria-label={`Field for ${h}`}
                      >
                        {[...fields, SKIP].map((f) => (
                          <option key={f} value={f}>
                            {FIELD_LABELS[f] ?? f}
                          </option>
                        ))}
                      </Select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between gap-3 px-5 py-4 md:px-6">
            <Button variant="ghost" onClick={() => setStep(1)}>
              Back
            </Button>
            <span className="flex items-center gap-3">
              {!hasName ? (
                <span className="text-[13px] text-warning-text">
                  Map a name column to continue.
                </span>
              ) : null}
              <Button disabled={!hasName} onClick={() => setStep(3)} data-testid="import-next">
                Continue
              </Button>
            </span>
          </div>
        </Card>
      ) : null}

      {step === 3 && parsed ? (
        <div className="flex flex-col gap-4" data-testid="import-step-preview">
          <Card className="overflow-hidden">
            <div className="flex flex-wrap items-start justify-between gap-2 px-5 pb-1.5 pt-4 md:px-6">
              <div>
                <h2 className="text-lg font-semibold tracking-tight">Preview</h2>
                <p className="text-[13px] text-text-2">
                  First {preview.length} of {parsed.total.toLocaleString()} rows.{' '}
                  {warnings ? `${warnings} need attention.` : 'They look good.'}
                </p>
              </div>
              <span className="flex gap-2">
                <Badge variant="ok">{preview.length - warnings} ready</Badge>
                {warnings ? <Badge variant="pending">{warnings} warnings</Badge> : null}
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-card-2 text-left text-xs font-medium text-text-2">
                    <th className="px-4 py-2">Row</th>
                    <th className="px-3 py-2">Name</th>
                    <th className="px-3 py-2">Phone</th>
                    <th className="px-3 py-2">Email</th>
                    <th className="px-3 py-2">{kind === 'people' ? 'Company' : 'Website'}</th>
                    {callConsent ? <th className="px-3 py-2">Calls</th> : null}
                    <th className="px-3 py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.map((p) => (
                    <tr key={p.row} className="border-t border-border">
                      <td className="px-4 py-2 text-[13px] text-text-3">{p.row}</td>
                      <td className="px-3 py-2 text-[13px] font-semibold">{p.name}</td>
                      <td className="px-3 py-2 text-[13px]">{p.phone}</td>
                      <td className="max-w-[220px] truncate px-3 py-2 text-[13px]">{p.email}</td>
                      <td className="max-w-[200px] truncate px-3 py-2 text-[13px]">{p.company}</td>
                      {callConsent ? (
                        <td className="px-3 py-2 text-[13px]" data-testid="import-preview-calls">
                          {p.calls}
                        </td>
                      ) : null}
                      <td className="px-3 py-2">
                        {p.problems.length ? (
                          <Badge variant={p.problems.includes('empty') ? 'gray' : 'revoked'}>
                            {p.problems.includes('empty')
                              ? 'Empty · skipped'
                              : `${p.problems.join(', ')} · error`}
                          </Badge>
                        ) : (
                          <Badge variant="ok">New or match</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          {callConsent ? (
            <Card className="p-5 md:p-6" data-testid="import-call-consent">
              <h3 className="text-[15px] font-semibold">Calls from us</h3>
              <p className="mb-3 text-[13px] text-text-2">
                Everyone the file says yes to is marked “Agreed in writing”, so your AI teammate can
                call them in a call campaign, and everyone it says no to “Doesn’t want calls”. Keep
                your own proof of each yes.
              </p>
              <Field
                label={
                  callWhereColumn
                    ? 'Where did they agree? (for rows that don’t say)'
                    : 'Where did they agree in writing?'
                }
                htmlFor="import-call-where"
                hint="Like “Website form, Oct 2026”. Someone already marked “Doesn’t want calls” stays that way. People you already have only change when you pick Update it below."
              >
                <Input
                  id="import-call-where"
                  value={callWhere}
                  onChange={(e) => setCallWhere(e.target.value)}
                  placeholder="Website form, Oct 2026"
                  maxLength={120}
                  data-testid="import-call-where"
                />
              </Field>
            </Card>
          ) : null}
          <Card className="p-5 md:p-6">
            <h3 className="text-[15px] font-semibold">
              When a row matches someone you already have
            </h3>
            <p className="mb-3 text-[13px] text-text-2">
              Matched by email first, then phone number{kind === 'companies' ? ', then name' : ''}.
            </p>
            <div
              role="radiogroup"
              aria-label="On match"
              className="flex flex-col gap-3 sm:flex-row"
            >
              <RadioCard
                selected={onMatch === 'skip'}
                onSelect={() => setOnMatch('skip')}
                title="Skip it"
                description="Keep what is in HandsFreeOS untouched"
                testId="import-match-skip"
              />
              <RadioCard
                selected={onMatch === 'update'}
                onSelect={() => setOnMatch('update')}
                title="Update it"
                description="Fill in blanks and refresh changed fields"
                testId="import-match-update"
              />
            </div>
          </Card>
          <div className="flex items-center justify-between">
            <Button variant="ghost" onClick={() => setStep(2)}>
              Back
            </Button>
            <span className="flex items-center gap-3">
              {needsCallWhere ? (
                <span className="text-[13px] text-warning-text">
                  Say where they agreed to calls to continue.
                </span>
              ) : null}
              <Button
                onClick={run}
                loading={running}
                disabled={needsCallWhere}
                data-testid="import-run"
              >
                <Upload className="h-4 w-4" strokeWidth={1.75} />
                Run import · {parsed.total.toLocaleString()} rows
              </Button>
            </span>
          </div>
        </div>
      ) : null}

      {step === 4 && importId ? (
        <div className="flex flex-col gap-3">
          <ImportProgress workspaceId={workspaceId} importId={importId} />
          <div className="text-[13px] text-text-3">
            Saved as an import:{' '}
            <Link
              href={`/app/w/${workspaceId}/imports/${importId}`}
              className="text-accent-text hover:underline"
            >
              open its page
            </Link>{' '}
            any time.
          </div>
        </div>
      ) : null}
    </div>
  );
}
