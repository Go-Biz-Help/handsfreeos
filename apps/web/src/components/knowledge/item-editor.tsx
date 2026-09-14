'use client';
import { ArrowLeft, ExternalLink, File, History, Sparkles, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field, Label } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { fieldErrors } from '@/lib/api/field-errors';
import type { KnowledgeItemDetail, KnowledgeItemKind } from '@/lib/api/types';
import { formatDate } from '@/lib/format';
import { AI_TINT, SOURCE_LABEL, shortUrl } from '@/lib/knowledge/labels';
import { cn, relativeTime } from '@/lib/utils';
import { ChipInput } from './chip-input';
import { ItemStatusBadge, KindChip } from './chips';

type WritableKind = Exclude<KnowledgeItemKind, 'document'>;

const COPY: Record<
  KnowledgeItemKind,
  {
    title: string;
    body: string;
    titleHint?: string;
    bodyHint: string;
    titlePh: string;
    bodyPh: string;
  }
> = {
  faq: {
    title: 'Question',
    body: 'Answer',
    titlePh: 'Do you offer financing?',
    bodyPh: 'Yes. We offer financing on new systems and bigger repairs.',
    bodyHint: 'Write it the way you’d answer a customer. AI steps reword it in your tone of voice.',
  },
  article: {
    title: 'Title',
    body: 'Article',
    titlePh: 'Our warranty',
    bodyPh: 'What’s covered, for how long, and how to claim it.',
    bodyHint: 'AI steps use articles as background, not word for word.',
  },
  fact: {
    title: 'What it’s about',
    body: 'The fact',
    titlePh: 'Brands we service',
    bodyPh: 'Carrier, Trane, Lennox and most other major brands.',
    bodyHint: 'Short and exact. The AI quotes facts as written.',
  },
  document: {
    title: 'Title',
    body: 'Text from the file',
    titlePh: 'Maintenance plan',
    bodyPh: 'The text read from the file.',
    bodyHint: 'Check the text before it’s used. Fix anything the file got wrong.',
  },
};

/** The item editor: kind, question and answer (or title and text), tags, and Draft · Publish · Archive. */
export function ItemEditor({
  workspaceId,
  canManage,
  item,
  newKind,
}: {
  workspaceId: string;
  canManage: boolean;
  item: KnowledgeItemDetail | null;
  newKind: WritableKind | null;
}) {
  const router = useRouter();
  const base = `/app/w/${workspaceId}/knowledge`;
  const [kind, setKind] = useState<KnowledgeItemKind>(item?.kind ?? newKind ?? 'faq');
  const [title, setTitle] = useState(item?.title ?? '');
  const [body, setBody] = useState(item?.body ?? '');
  const [tags, setTags] = useState<string[]>(item?.tags ?? []);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const ro = !canManage;
  const copy = COPY[kind];
  const dirty =
    !item ||
    kind !== item.kind ||
    title !== item.title ||
    body !== item.body ||
    tags.join('\n') !== item.tags.join('\n');

  const content = () =>
    kind === 'faq'
      ? { kind, question: title.trim(), answer: body.trim(), tags }
      : { kind, title: title.trim(), body: kind === 'document' ? body : body.trim(), tags };

  function check(publishing: boolean): boolean {
    const next: Record<string, string> = {};
    if (!title.trim()) next.title = kind === 'faq' ? 'Write the question.' : 'Give it a title.';
    if (!body.trim() && (kind !== 'document' || publishing))
      next.body = kind === 'faq' ? 'Write the answer.' : 'Add the text.';
    setErrors(next);
    return !Object.keys(next).length;
  }
  function showError(e: unknown) {
    const fe = fieldErrors(e);
    const mapped: Record<string, string> = {};
    for (const [k, v] of Object.entries(fe))
      mapped[k === 'question' ? 'title' : k === 'answer' ? 'body' : k] = v;
    if (Object.keys(mapped).length) setErrors(mapped);
    toast.error(errorMessage(e));
  }

  async function create(status: 'draft' | 'published') {
    if (!check(status === 'published')) return;
    setBusy(status);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/knowledge_item.create', {
          body: { workspaceId, content: content() as never, status },
        }),
      );
      toast.success(
        status === 'published' ? 'Published. The AI can use it now.' : 'Saved as a draft.',
      );
      router.replace(`${base}/items/${out.itemId}`);
      router.refresh();
    } catch (e) {
      showError(e);
    } finally {
      setBusy(null);
    }
  }

  /** Saves changes (if any); true when it worked. */
  async function save(quiet = false): Promise<boolean> {
    if (!item) return false;
    if (!dirty) return true;
    if (!check(false)) return false;
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/knowledge_item.update', {
          body: { workspaceId, itemId: item.id, content: content() as never },
        }),
      );
      if (!quiet) toast.success('Saved.');
      return true;
    } catch (e) {
      showError(e);
      return false;
    }
  }

  async function run(action: 'save' | 'publish' | 'archive') {
    if (!item) return;
    if (action === 'publish' && !check(true)) return;
    setBusy(action);
    try {
      if (action === 'save') {
        if (await save()) router.refresh();
        return;
      }
      if (action === 'publish' && !(await save(true))) return;
      unwrap(
        await apiBrowser().POST(
          action === 'publish'
            ? '/v1/commands/knowledge_item.publish'
            : '/v1/commands/knowledge_item.archive',
          { body: { workspaceId, itemId: item.id } },
        ),
      );
      toast.success(
        action === 'publish'
          ? 'Published. The AI can use it now.'
          : 'Archived. The AI won’t use it any more.',
      );
      router.refresh();
    } catch (e) {
      showError(e);
    } finally {
      setBusy(null);
    }
  }

  const empty = item?.kind === 'document' && !item.body.trim();
  const truncated = item?.kind === 'document' && item.body.length >= 100_000;

  return (
    <div className="flex max-w-[760px] flex-col gap-3.5" data-testid="item-editor">
      <Link
        href={`${base}/items`}
        className="inline-flex items-center gap-1.5 self-start text-[13px] font-medium text-text-2 hover:text-text"
      >
        <ArrowLeft className="h-4 w-4" strokeWidth={1.5} />
        All items
      </Link>
      <Card className="flex flex-col gap-3.5 px-[18px] py-4">
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          <span className="flex flex-wrap items-center gap-2">
            {item?.kind === 'document' || ro ? (
              <KindChip kind={kind} />
            ) : (
              <Segmented<WritableKind>
                ariaLabel="Kind"
                value={kind as WritableKind}
                onChange={(k) => setKind(k)}
                options={[
                  { value: 'faq', label: 'FAQ', testId: 'kind-faq' },
                  { value: 'article', label: 'Article', testId: 'kind-article' },
                  { value: 'fact', label: 'Fact', testId: 'kind-fact' },
                ]}
              />
            )}
            {item ? (
              <span className="text-xs text-text-3">
                Updated {formatDate(item.updatedAt)}
                {item.updatedBy ? ` by ${item.updatedBy.fullName}` : ''}
              </span>
            ) : null}
          </span>
          {item ? <ItemStatusBadge status={item.status} /> : null}
        </div>

        {ro ? (
          <p className="rounded-[10px] bg-card-2 px-3 py-2 text-[13px] text-text-2">
            Only owners and admins can change the knowledge base.
          </p>
        ) : null}
        {empty ? (
          <div
            className="flex items-start gap-2 rounded-[10px] bg-warning-soft px-3 py-2.5 text-[13px] text-warning-text"
            data-testid="document-empty"
          >
            <TriangleAlert className="mt-0.5 h-4 w-4 flex-none" strokeWidth={1.75} />
            <span>
              No text could be read from this file. A scanned PDF is only pictures of pages, and
              files over 5 MB aren’t read. Type the key points below, or upload a text version.
            </span>
          </div>
        ) : truncated ? (
          <div className="flex items-start gap-2 rounded-[10px] bg-warning-soft px-3 py-2.5 text-[13px] text-warning-text">
            <TriangleAlert className="mt-0.5 h-4 w-4 flex-none" strokeWidth={1.75} />
            <span>Only the first 100,000 characters of this file were kept.</span>
          </div>
        ) : null}

        <Field label={copy.title} htmlFor="ki-title" error={errors.title}>
          <Input
            id="ki-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={kind === 'faq' ? 300 : 200}
            readOnly={ro}
            placeholder={copy.titlePh}
            invalid={!!errors.title}
            data-testid="item-title"
          />
        </Field>
        <Field
          label={copy.body}
          htmlFor="ki-body"
          hint={ro ? undefined : copy.bodyHint}
          error={errors.body}
        >
          <Textarea
            id="ki-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={
              kind === 'faq' ? 5000 : kind === 'fact' ? 2000 : kind === 'article' ? 20000 : 200_000
            }
            readOnly={ro}
            placeholder={copy.bodyPh}
            invalid={!!errors.body}
            data-testid="item-body"
            className={cn(
              kind === 'article' || kind === 'document' ? 'min-h-[220px]' : 'min-h-[110px]',
              ro && 'bg-card-2 text-text-2',
            )}
          />
        </Field>
        <div>
          <Label htmlFor="ki-tags">Tags</Label>
          <ChipInput
            id="ki-tags"
            value={tags}
            onChange={setTags}
            disabled={ro}
            placeholder="Financing, Warranty…"
            testId="item-tags"
          />
        </div>

        {item ? <SourceAndUse item={item} base={base} /> : null}

        {ro ? null : item ? (
          <div className="flex flex-wrap items-center gap-2">
            {item.status === 'published' ? (
              <Button
                loading={busy === 'save'}
                disabled={!dirty || !!busy}
                onClick={() => void run('save')}
                data-testid="item-save"
              >
                Save
              </Button>
            ) : (
              <>
                <Button
                  loading={busy === 'publish'}
                  disabled={!!busy}
                  onClick={() => void run('publish')}
                  data-testid="item-publish"
                >
                  {item.status === 'archived' ? 'Publish again' : 'Publish'}
                </Button>
                <Button
                  variant="secondary"
                  loading={busy === 'save'}
                  disabled={!dirty || !!busy}
                  onClick={() => void run('save')}
                  data-testid="item-save"
                >
                  {item.status === 'draft' ? 'Save draft' : 'Save'}
                </Button>
              </>
            )}
            <span className="flex-1" />
            {item.status === 'archived' ? null : (
              <Button
                variant="ghost"
                loading={busy === 'archive'}
                disabled={!!busy}
                onClick={() => void run('archive')}
                data-testid="item-archive"
              >
                Archive
              </Button>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              loading={busy === 'published'}
              disabled={!!busy}
              onClick={() => void create('published')}
              data-testid="item-publish"
            >
              Publish
            </Button>
            <Button
              variant="secondary"
              loading={busy === 'draft'}
              disabled={!!busy}
              onClick={() => void create('draft')}
              data-testid="item-save-draft"
            >
              Save as draft
            </Button>
            <span className="text-xs text-text-3 sm:ml-auto">
              Drafts aren’t used by the AI until you publish them.
            </span>
          </div>
        )}
      </Card>
    </div>
  );
}

function SourceAndUse({ item, base }: { item: KnowledgeItemDetail; base: string }) {
  return (
    <div
      className="flex flex-col gap-2 border-t border-border pt-3 text-[13px]"
      data-testid="item-source"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-text-2">
        <History className="h-4 w-4 flex-none text-text-3" strokeWidth={1.5} />
        <span>
          {SOURCE_LABEL[item.source]}
          {item.createdBy ? ` · added by ${item.createdBy.fullName}` : ''} ·{' '}
          {formatDate(item.createdAt)}
        </span>
        {item.sourceUrl ? (
          <a
            href={item.sourceUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 font-medium text-accent-text hover:underline"
            data-testid="item-source-url"
          >
            {shortUrl(item.sourceUrl)}
            <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.5} />
          </a>
        ) : null}
        {item.file ? (
          <span className="inline-flex items-center gap-1 font-medium text-text">
            <File className="h-3.5 w-3.5 text-text-3" strokeWidth={1.5} />
            {item.file.name}
          </span>
        ) : null}
      </div>
      <div
        className={cn(
          'flex flex-wrap items-center gap-2 rounded-[9px] px-3 py-2 text-[12.5px]',
          AI_TINT,
        )}
        data-testid="item-usage"
      >
        <Sparkles className="h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
        <span className="flex-1">
          {item.useCount
            ? `Used ${item.useCount} ${item.useCount === 1 ? 'time' : 'times'}. Last used ${item.lastUsedAt ? relativeTime(item.lastUsedAt) : 'recently'}.`
            : item.status === 'published'
              ? 'Not used by the AI yet.'
              : 'The AI can’t use it until it’s published.'}
        </span>
        {item.kind === 'faq' && item.status === 'published' ? (
          <Link
            href={`${base}?ask=${encodeURIComponent(item.title)}`}
            className="font-semibold underline"
          >
            Try this question
          </Link>
        ) : null}
      </div>
    </div>
  );
}
