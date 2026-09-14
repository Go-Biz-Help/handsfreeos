'use client';
import { Archive, ArchiveRestore, Copy, Package, Plus, Send, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/shell/page-header';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { KnowledgeItem, KnowledgePack, KnowledgePackItem } from '@/lib/api/types';
import { cn } from '@/lib/utils';

type Business = { readonly id: string; readonly name: string };
type Kind = KnowledgePackItem['kind'];

const KIND: Record<Kind, { one: string; many: string; title: string; body: string }> = {
  faq: { one: 'FAQ', many: 'FAQs', title: 'Question', body: 'Answer' },
  article: { one: 'article', many: 'articles', title: 'Title', body: 'Article' },
  fact: { one: 'fact', many: 'facts', title: 'Fact', body: 'Details' },
};

/** "12 FAQs and 4 facts". */
function itemsLine(items: readonly KnowledgePackItem[]): string {
  const parts = (Object.keys(KIND) as Kind[])
    .map((k) => ({ k, n: items.filter((i) => i.kind === k).length }))
    .filter((x) => x.n)
    .map(({ k, n }) => `${n} ${n === 1 ? KIND[k].one : KIND[k].many}`);
  if (!parts.length) return 'No items yet';
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

/**
 * The agency's knowledge packs: build one from scratch or from a business's items, save (each change is a
 * new version), and push it to client businesses, where the items wait as suggestions from Go Biz Help.
 */
export function PackBoard({
  organizationId,
  agencyName,
  packs,
  businesses,
}: {
  organizationId: string;
  agencyName: string;
  packs: readonly KnowledgePack[];
  businesses: readonly Business[];
}) {
  const [editing, setEditing] = useState<KnowledgePack | 'new' | null>(null);
  const [pushing, setPushing] = useState<KnowledgePack | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const live = packs.filter((p) => !p.archivedAt);
  const archived = packs.filter((p) => p.archivedAt);
  const shown = showArchived ? archived : live;

  return (
    <>
      <PageHeader
        title="Knowledge packs"
        description="Starter FAQs, articles and facts. A push arrives as suggestions each business accepts, edits or rejects."
        actions={
          <Button onClick={() => setEditing('new')} data-testid="pack-new">
            <Plus className="h-4 w-4" strokeWidth={1.75} />
            New pack
          </Button>
        }
      />
      {shown.length ? (
        <Card className="overflow-hidden" data-testid="packs-list">
          {shown.map((p) => (
            <div
              key={p.id}
              className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3.5 last:border-b-0 md:px-[18px]"
              data-testid={`pack-row-${p.id}`}
            >
              <span className="inline-flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[8px] bg-accent-soft text-accent-text">
                <Package className="h-[15px] w-[15px]" strokeWidth={1.75} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-semibold">{p.name}</span>
                <span className="truncate text-xs text-text-3">
                  {itemsLine(p.items)} · version {p.version}
                  {p.description ? ` · ${p.description}` : ''}
                </span>
              </span>
              <span className="flex flex-none gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setEditing(p)}
                  data-testid={`pack-edit-${p.id}`}
                >
                  Edit
                </Button>
                {p.archivedAt ? null : (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!p.items.length}
                    onClick={() => setPushing(p)}
                    data-testid={`pack-push-${p.id}`}
                  >
                    <Send className="h-3.5 w-3.5" strokeWidth={1.75} />
                    Push
                  </Button>
                )}
              </span>
            </div>
          ))}
        </Card>
      ) : (
        <Card data-testid="packs-empty">
          <EmptyState
            title={showArchived ? 'Nothing archived' : 'No packs yet'}
            actions={
              showArchived ? null : (
                <Button size="sm" onClick={() => setEditing('new')}>
                  New pack
                </Button>
              )
            }
          >
            {showArchived
              ? 'Archived packs show here.'
              : 'Write a few FAQs once, or copy them from one of your businesses, and push them to the rest.'}
          </EmptyState>
        </Card>
      )}
      {archived.length ? (
        <button
          type="button"
          onClick={() => setShowArchived((v) => !v)}
          className="mt-3 text-xs font-medium text-accent-text hover:underline"
        >
          {showArchived ? 'Back to your packs' : `Archived (${archived.length})`}
        </button>
      ) : null}
      {editing ? (
        <PackEditor
          organizationId={organizationId}
          pack={editing === 'new' ? null : editing}
          businesses={businesses}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {pushing ? (
        <PackPush
          organizationId={organizationId}
          agencyName={agencyName}
          pack={pushing}
          businesses={businesses}
          onClose={() => setPushing(null)}
        />
      ) : null}
    </>
  );
}

/** Copies published items from one of the agency's businesses into the pack being built. */
function CopyFromBusiness({
  businesses,
  onAdd,
  onClose,
}: {
  businesses: readonly Business[];
  onAdd: (items: KnowledgePackItem[]) => void;
  onClose: () => void;
}) {
  const [businessId, setBusinessId] = useState(businesses[0]?.id ?? '');
  const [loaded, setLoaded] = useState<{ businessId: string; items: KnowledgeItem[] } | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!businessId) return;
    let cancelled = false;
    apiBrowser()
      .POST('/v1/queries/knowledge_item.list', {
        body: { workspaceId: businessId, status: ['published'], limit: 100 },
      })
      .then((r) => {
        if (!cancelled)
          setLoaded({
            businessId,
            items: unwrap(r).items.filter((i) => i.kind !== 'document'),
          });
      })
      .catch((e: unknown) => !cancelled && setError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [businessId]);

  const items = loaded?.businessId === businessId ? loaded.items : null;
  return (
    <div className="rounded-card border border-border bg-card-2 p-3" data-testid="pack-copy">
      <div className="mb-2 flex items-center gap-2">
        <Select
          selectSize="sm"
          aria-label="Business to copy from"
          className="min-w-0 flex-1"
          value={businessId}
          onChange={(e) => {
            setBusinessId(e.target.value);
            setPicked([]);
          }}
        >
          {businesses.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </Select>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
      </div>
      {error ? <p className="text-xs text-danger-text">{error}</p> : null}
      {!items ? (
        <p className="text-xs text-text-3">Loading its published items…</p>
      ) : !items.length ? (
        <p className="text-xs text-text-3">It has no published FAQs, articles or facts yet.</p>
      ) : (
        <div className="flex max-h-[260px] flex-col gap-1 overflow-y-auto">
          {items.map((i) => (
            <Checkbox
              key={i.id}
              className="min-h-10 rounded-control px-1 hover:bg-card"
              checked={picked.includes(i.id)}
              onChange={(e) =>
                setPicked((p) => (e.target.checked ? [...p, i.id] : p.filter((x) => x !== i.id)))
              }
              label={
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-[13px]">{i.title}</span>
                  <span className="text-xs text-text-3">{KIND[i.kind as Kind]?.one ?? i.kind}</span>
                </span>
              }
            />
          ))}
        </div>
      )}
      <Button
        size="sm"
        className="mt-2"
        disabled={!picked.length}
        onClick={() =>
          onAdd(
            (items ?? [])
              .filter((i) => picked.includes(i.id))
              .map((i) => ({ kind: i.kind as Kind, title: i.title, body: i.body, tags: i.tags })),
          )
        }
      >
        Add {picked.length || ''} {picked.length === 1 ? 'item' : 'items'}
      </Button>
    </div>
  );
}

/** Builds or changes a pack: its name, what it's for, and its items. Every saved change is a new version. */
function PackEditor({
  organizationId,
  pack,
  businesses,
  onClose,
}: {
  organizationId: string;
  pack: KnowledgePack | null;
  businesses: readonly Business[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState(pack?.name ?? '');
  const [description, setDescription] = useState(pack?.description ?? '');
  const [items, setItems] = useState<KnowledgePackItem[]>(() =>
    pack?.items.length
      ? pack.items.map((i) => ({ ...i, tags: [...i.tags] }))
      : [{ kind: 'faq', title: '', body: '', tags: [] }],
  );
  const [copying, setCopying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const change = (n: number, patch: Partial<KnowledgePackItem>) =>
    setItems((list) => list.map((x, i) => (i === n ? { ...x, ...patch } : x)));

  async function save(archived?: boolean) {
    const clean = items
      .map((i) => ({ ...i, title: i.title.trim(), body: i.body.trim() }))
      .filter((i) => i.title || i.body);
    if (!name.trim()) return setError('Give the pack a name.');
    const half = clean.findIndex((i) => !i.title || !i.body);
    if (half >= 0)
      return setError(
        `Item ${half + 1} needs its ${KIND[clean[half]!.kind].title.toLowerCase()} and ${KIND[clean[half]!.kind].body.toLowerCase()}.`,
      );
    setBusy(true);
    setError(null);
    try {
      const body = { name: name.trim(), description: description.trim() || null, items: clean };
      if (pack) {
        const out = unwrap(
          await apiBrowser().POST('/v1/commands/knowledge_pack.update', {
            body: {
              organizationId,
              packId: pack.id,
              ...body,
              ...(archived !== undefined ? { archived } : {}),
            },
          }),
        );
        toast.success(
          archived === true
            ? 'Pack archived.'
            : archived === false
              ? 'Pack restored.'
              : out.updated.length
                ? `Saved as version ${out.version}.`
                : 'Nothing changed.',
        );
      } else {
        unwrap(
          await apiBrowser().POST('/v1/commands/knowledge_pack.create', {
            body: { organizationId, ...body },
          }),
        );
        toast.success('Pack saved. Push it when it’s ready.');
      }
      onClose();
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        title={pack ? `Edit “${pack.name}”` : 'New knowledge pack'}
        description={
          pack
            ? `Version ${pack.version}. Saving a change makes version ${pack.version + 1}; businesses get it when you push it.`
            : 'A set of FAQs, articles and facts to push to client businesses as suggestions.'
        }
        className="sm:w-[560px]"
      >
        <div className="flex flex-col gap-4" data-testid="pack-editor">
          <Field label="Name" htmlFor="pack-name">
            <Input
              id="pack-name"
              value={name}
              maxLength={120}
              placeholder="HVAC FAQs starter"
              onChange={(e) => setName(e.target.value)}
              data-testid="pack-name"
            />
          </Field>
          <Field label="What it’s for (optional)" htmlFor="pack-description">
            <Input
              id="pack-description"
              value={description}
              maxLength={2000}
              placeholder="The questions every HVAC customer asks"
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>

          <div className="flex items-center justify-between gap-2">
            <h3 className="text-[15px] font-semibold">Items · {items.length}</h3>
            {businesses.length && !copying ? (
              <Button variant="ghost" size="sm" onClick={() => setCopying(true)}>
                <Copy className="h-3.5 w-3.5" strokeWidth={1.75} />
                Copy from a business
              </Button>
            ) : null}
          </div>
          {copying ? (
            <CopyFromBusiness
              businesses={businesses}
              onClose={() => setCopying(false)}
              onAdd={(added) => {
                setItems((list) => [...list.filter((i) => i.title || i.body), ...added]);
                setCopying(false);
                toast.success(`Added ${added.length} ${added.length === 1 ? 'item' : 'items'}.`);
              }}
            />
          ) : null}
          <ol className="flex flex-col gap-3">
            {items.map((item, n) => (
              <li
                key={n}
                className="flex flex-col gap-2 rounded-card border border-border p-3"
                data-testid={`pack-item-${n}`}
              >
                <div className="flex items-center gap-2">
                  <Select
                    selectSize="sm"
                    aria-label={`Item ${n + 1} kind`}
                    className="w-[128px]"
                    value={item.kind}
                    onChange={(e) => change(n, { kind: e.target.value as Kind })}
                    data-testid={`pack-item-kind-${n}`}
                  >
                    <option value="faq">FAQ</option>
                    <option value="article">Article</option>
                    <option value="fact">Fact</option>
                  </Select>
                  <span className="flex-1" />
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove item ${n + 1}`}
                    onClick={() => setItems((list) => list.filter((_, i) => i !== n))}
                  >
                    <Trash2 className="h-4 w-4" strokeWidth={1.5} />
                  </Button>
                </div>
                <Input
                  inputSize="sm"
                  aria-label={`Item ${n + 1} ${KIND[item.kind].title.toLowerCase()}`}
                  placeholder={KIND[item.kind].title}
                  value={item.title}
                  maxLength={300}
                  onChange={(e) => change(n, { title: e.target.value })}
                  data-testid={`pack-item-title-${n}`}
                />
                <Textarea
                  aria-label={`Item ${n + 1} ${KIND[item.kind].body.toLowerCase()}`}
                  placeholder={KIND[item.kind].body}
                  rows={3}
                  className="min-h-[72px] text-sm"
                  value={item.body}
                  maxLength={20000}
                  onChange={(e) => change(n, { body: e.target.value })}
                  data-testid={`pack-item-body-${n}`}
                />
              </li>
            ))}
          </ol>
          <Button
            variant="secondary"
            onClick={() =>
              setItems((list) => [...list, { kind: 'faq', title: '', body: '', tags: [] }])
            }
            data-testid="pack-item-add"
          >
            <Plus className="h-4 w-4" strokeWidth={1.75} />
            Add an item
          </Button>

          {error ? <p className="text-[13px] text-danger-text">{error}</p> : null}
          <div className="sticky bottom-0 -mx-5 mt-1 flex flex-wrap items-center gap-2 border-t border-border bg-card px-5 py-3 sm:-mx-6 sm:px-6">
            {pack ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void save(!pack.archivedAt)}
                disabled={busy}
              >
                {pack.archivedAt ? (
                  <ArchiveRestore className="h-4 w-4" strokeWidth={1.5} />
                ) : (
                  <Archive className="h-4 w-4" strokeWidth={1.5} />
                )}
                {pack.archivedAt ? 'Restore' : 'Archive'}
              </Button>
            ) : null}
            <span className="flex-1" />
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button loading={busy} onClick={() => void save()} data-testid="pack-save">
              Save pack
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** Pushes a pack's current version to the chosen businesses, where each item waits as a suggestion. */
function PackPush({
  organizationId,
  agencyName,
  pack,
  businesses,
  onClose,
}: {
  organizationId: string;
  agencyName: string;
  pack: KnowledgePack;
  businesses: readonly Business[];
  onClose: () => void;
}) {
  const [chosen, setChosen] = useState<string[]>(() => businesses.map((b) => b.id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function push() {
    setBusy(true);
    setError(null);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/knowledge_pack.push', {
          body: { organizationId, packId: pack.id, workspaceIds: chosen },
        }),
      );
      const n = out.workspaceIds.length;
      toast.success(
        `Sent version ${out.version} to ${n} ${n === 1 ? 'business' : 'businesses'}. Their items wait in Knowledge, under Suggestions from ${agencyName}.`,
      );
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={`Push “${pack.name}”`}
        description={`Version ${pack.version} · ${itemsLine(pack.items)}. Each business gets the items as suggestions; anything it already has is skipped.`}
      >
        <div className="mt-4 flex flex-col gap-1" data-testid="pack-push">
          {businesses.map((b) => (
            <Checkbox
              key={b.id}
              className={cn('min-h-11 rounded-control px-1 hover:bg-card-2')}
              checked={chosen.includes(b.id)}
              onChange={(e) =>
                setChosen((c) => (e.target.checked ? [...c, b.id] : c.filter((x) => x !== b.id)))
              }
              data-testid={`pack-push-business-${b.id}`}
              label={
                <span className="flex items-center gap-2">
                  <Avatar
                    name={b.name}
                    seed={b.id}
                    size="sm"
                    square
                    className="bg-card-3 text-text"
                  />
                  <span className="truncate">{b.name}</span>
                </span>
              }
            />
          ))}
          {error ? <p className="mt-2 text-[13px] text-danger-text">{error}</p> : null}
          <div className="mt-4 flex items-center justify-end gap-2">
            <Badge className="mr-auto">
              {chosen.length} of {businesses.length}
            </Badge>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              loading={busy}
              disabled={!chosen.length}
              onClick={() => void push()}
              data-testid="pack-push-submit"
            >
              Push
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
