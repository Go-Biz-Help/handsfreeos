'use client';
/**
 * The Documents page: what's been sent and where each one is, and the templates they're sent from.
 */
import { DOCUMENT_STATUS_LABELS, signerStatusLabel, type DocumentStatus } from '@hfos/core';
import { Copy, FilePenLine, Send } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Segmented } from '@/components/ui/segmented';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { DocumentRow, DocumentTemplateRow } from '@/lib/api/types';
import { formatDate } from '@/lib/format';
import { documentBadge } from '@/lib/documents/words';
import { cn } from '@/lib/utils';

export type DocumentsTab = 'sent' | 'templates';
type Tab = DocumentsTab;
type Filter = 'all' | DocumentStatus;

export function DocumentsHome({
  workspaceId,
  tab,
  documents,
  more,
  templates,
  canManage,
  canSend,
}: {
  workspaceId: string;
  tab: Tab;
  documents: readonly DocumentRow[];
  more: boolean;
  templates: readonly DocumentTemplateRow[];
  canManage: boolean;
  canSend: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();

  return (
    <div className="flex flex-col gap-4">
      <Segmented
        value={tab}
        onChange={(t) =>
          router.replace(t === 'sent' ? pathname : `${pathname}?tab=${t}`, { scroll: false })
        }
        ariaLabel="Sent documents or templates"
        options={[
          { value: 'sent', label: 'Sent', testId: 'documents-tab-sent' },
          {
            value: 'templates',
            label: `Templates ${templates.length || ''}`.trim(),
            testId: 'documents-tab-templates',
          },
        ]}
      />
      {tab === 'sent' ? (
        <SentList
          workspaceId={workspaceId}
          initial={documents}
          initialMore={more}
          hasTemplates={templates.length > 0}
          canSend={canSend}
          canManage={canManage}
        />
      ) : (
        <TemplateList
          workspaceId={workspaceId}
          initial={templates}
          canManage={canManage}
          canSend={canSend}
        />
      )}
    </div>
  );
}

function SentList({
  workspaceId,
  initial,
  initialMore,
  hasTemplates,
  canSend,
  canManage,
}: {
  workspaceId: string;
  initial: readonly DocumentRow[];
  initialMore: boolean;
  hasTemplates: boolean;
  canSend: boolean;
  canManage: boolean;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const [rows, setRows] = useState(initial);
  const [more, setMore] = useState(initialMore);
  const [busy, setBusy] = useState(false);

  async function load(next: Filter, before?: string) {
    setBusy(true);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/queries/document.list', {
          body: {
            workspaceId,
            limit: 50,
            ...(next === 'all' ? {} : { status: next }),
            ...(before ? { before } : {}),
          },
        }),
      );
      setRows((was) => (before ? [...was, ...out.documents] : out.documents));
      setMore(out.more);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <Segmented
        value={filter}
        onChange={(f) => {
          setFilter(f);
          void load(f);
        }}
        ariaLabel="Which documents"
        options={[
          { value: 'all', label: 'All' },
          { value: 'out', label: 'Out for signing' },
          { value: 'completed', label: DOCUMENT_STATUS_LABELS.completed },
          { value: 'declined', label: DOCUMENT_STATUS_LABELS.declined },
          { value: 'voided', label: DOCUMENT_STATUS_LABELS.voided },
          { value: 'expired', label: DOCUMENT_STATUS_LABELS.expired },
        ]}
      />
      {rows.length === 0 ? (
        <Card>
          <EmptyState
            title={filter === 'all' ? 'Nothing sent yet' : 'None here'}
            actions={
              filter !== 'all' ? null : hasTemplates && canSend ? (
                <ButtonLink variant="primary" href={`/app/w/${workspaceId}/documents/send`}>
                  <Send className="h-4 w-4" strokeWidth={1.75} />
                  Send a document
                </ButtonLink>
              ) : canManage ? (
                <ButtonLink
                  variant="secondary"
                  href={`/app/w/${workspaceId}/documents?tab=templates`}
                >
                  Make a template first
                </ButtonLink>
              ) : null
            }
          >
            {filter === 'all'
              ? 'Send a contract or agreement to a customer and they sign it online. You see every step here.'
              : 'No documents are in that state.'}
          </EmptyState>
        </Card>
      ) : (
        <Card className="divide-y divide-border" data-testid="documents-sent">
          {rows.map((r) => (
            <DocumentLine key={r.id} workspaceId={workspaceId} row={r} />
          ))}
        </Card>
      )}
      {more ? (
        <div className="flex justify-center">
          <Button
            variant="secondary"
            size="sm"
            loading={busy}
            onClick={() => void load(filter, rows[rows.length - 1]?.sentAt)}
          >
            Show older ones
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function DocumentLine({ workspaceId, row }: { workspaceId: string; row: DocumentRow }) {
  const badge = documentBadge(row.status, row.finishing);
  const signers = row.signers.filter((s) => s.kind === 'signer');
  return (
    <Link
      href={`/app/w/${workspaceId}/documents/${row.id}`}
      className="flex flex-col gap-1.5 px-4 py-3 hover:bg-card-2 sm:flex-row sm:items-center sm:gap-4"
      data-testid="document-row"
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <FilePenLine className="h-4 w-4 flex-none text-text-3" strokeWidth={1.5} />
          <span className="truncate text-[14px] font-medium">{row.name}</span>
        </span>
        <span className="truncate text-[12.5px] text-text-3">
          {[
            row.about?.name,
            signers
              .map((s) => `${s.name}: ${signerStatusLabel(s, signers).toLowerCase()}`)
              .join(', '),
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </span>
      <span className="flex flex-none items-center gap-3">
        <Badge variant={badge.variant}>{badge.label}</Badge>
        <span className="w-24 text-right text-[12.5px] text-text-3">{formatDate(row.sentAt)}</span>
      </span>
    </Link>
  );
}

function TemplateList({
  workspaceId,
  initial,
  canManage,
  canSend,
}: {
  workspaceId: string;
  initial: readonly DocumentTemplateRow[];
  canManage: boolean;
  canSend: boolean;
}) {
  const router = useRouter();
  const [archived, setArchived] = useState(false);
  const [rows, setRows] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);

  async function show(next: boolean) {
    setArchived(next);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/queries/document_template.list', {
          body: { workspaceId, archived: next },
        }),
      );
      setRows(out.templates);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  async function duplicate(t: DocumentTemplateRow) {
    setBusy(t.id);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/document_template.duplicate', {
          body: { workspaceId, templateId: t.id },
        }),
      );
      router.push(`/app/w/${workspaceId}/documents/templates/${out.templateId}`);
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <Segmented
        value={archived ? 'archived' : 'live'}
        onChange={(v) => void show(v === 'archived')}
        ariaLabel="Templates in use or archived"
        options={[
          { value: 'live', label: 'In use' },
          { value: 'archived', label: 'Archived' },
        ]}
      />
      {rows.length === 0 ? (
        <Card>
          <EmptyState title={archived ? 'Nothing archived' : 'No templates yet'}>
            {archived
              ? 'Templates you archive wait here, and can be restored.'
              : canManage
                ? 'Make one from the PDF of a contract or agreement you send often: New template, top right.'
                : 'An owner or admin makes the templates. Ask them for the one you need.'}
          </EmptyState>
        </Card>
      ) : (
        <div
          className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3"
          data-testid="documents-templates"
        >
          {rows.map((t) => (
            <Card key={t.id} className="flex flex-col gap-2 p-4" data-testid="template-card">
              <Link
                href={`/app/w/${workspaceId}/documents/templates/${t.id}`}
                className="truncate text-[15px] font-semibold hover:underline"
              >
                {t.name}
              </Link>
              <p className="text-[12.5px] text-text-3">
                {[
                  t.hasPdf
                    ? `${t.pageCount} ${t.pageCount === 1 ? 'page' : 'pages'}`
                    : 'No PDF yet',
                  t.roles.map((r) => r.label).join(', '),
                  `${t.fieldCount} ${t.fieldCount === 1 ? 'field' : 'fields'}`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {t.archivedAt ? (
                  <Badge>Archived</Badge>
                ) : t.ready ? (
                  <Badge variant="ok">Ready to send</Badge>
                ) : (
                  <Badge variant="pending">Not ready yet</Badge>
                )}
                {t.documentsOut ? (
                  <span className="text-[12px] text-text-3">{t.documentsOut} out for signing</span>
                ) : null}
              </div>
              <div className={cn('mt-auto flex flex-wrap gap-2 pt-1')}>
                {t.ready && !t.archivedAt && canSend ? (
                  <ButtonLink
                    size="sm"
                    variant="primary"
                    href={`/app/w/${workspaceId}/documents/send?template=${t.id}`}
                  >
                    <Send className="h-4 w-4" strokeWidth={1.75} />
                    Send
                  </ButtonLink>
                ) : null}
                <ButtonLink size="sm" href={`/app/w/${workspaceId}/documents/templates/${t.id}`}>
                  {canManage && !t.archivedAt ? 'Edit' : 'Open'}
                </ButtonLink>
                {canManage ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={busy === t.id}
                    onClick={() => void duplicate(t)}
                  >
                    <Copy className="h-4 w-4" strokeWidth={1.75} />
                    Copy
                  </Button>
                ) : null}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
