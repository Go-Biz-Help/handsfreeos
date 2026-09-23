'use client';
import {
  addOptions,
  groupPairs,
  RELATIONSHIP_WORDS,
  type AddOption,
  type RelatableRecord,
} from '@hfos/core';
import { MoreHorizontal, Pencil, Plus, Unlink } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { Relationship, RelationshipType } from '@/lib/api/types';
import { AddRelationshipDialog } from './add-relationship-dialog';
import { RecordIcon, RelatedMark, relatedHref } from './record-icon';

export interface RelationshipsCardProps {
  workspaceId: string;
  /** The record this page is about. */
  record: RelatableRecord & { readonly id: string; readonly name: string };
  relationships: Relationship[];
  /** The business's live relationship types. */
  types: RelationshipType[];
  archived: boolean;
  /** Owners and admins: an empty card points them at Settings → Relationships. */
  canManage: boolean;
  /** A customer's company (people.company_id), shown first. */
  company?: { id: string; name: string; archived: boolean } | null;
  /** A company's people (the same link, seen from the company). */
  companyPeople?: {
    id: string;
    fullName: string;
    email: string | null;
    phone: string | null;
    archived: boolean;
  }[];
  onAddPerson?: () => void;
}

/**
 * Everything a customer, a company or a record is related to, on its own page: a customer's company and pets, a
 * pet's owners, a company's people and locations. Each pair reads from both pages; Add relates another record,
 * found or made on the spot.
 */
export function RelationshipsCard(props: RelationshipsCardProps) {
  const { workspaceId, record, relationships, types, archived, canManage } = props;
  const [adding, setAdding] = useState<AddOption | 'pick' | null>(null);
  const options = useMemo(
    () => addOptions(types, record, relationships),
    [types, record, relationships],
  );
  const groups = useMemo(() => groupPairs(relationships), [relationships]);
  const people = props.companyPeople;
  const empty = !props.company && !people?.length && relationships.length === 0;
  const canAdd = !archived && options.length > 0;

  return (
    <Card className="p-4 md:p-5" data-testid="relationships-card">
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <h3 className="text-[15px] font-semibold">{RELATIONSHIP_WORDS.cardTitle}</h3>
        {canAdd ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              setAdding(options.length === 1 && !options[0]!.full ? options[0]! : 'pick')
            }
            data-testid="relationship-add"
          >
            <Plus className="h-4 w-4" strokeWidth={1.75} />
            {RELATIONSHIP_WORDS.add}
          </Button>
        ) : null}
      </div>

      <div className="flex flex-col gap-3.5">
        {props.company ? (
          <Group title={RELATIONSHIP_WORDS.company}>
            <li>
              <Link
                href={relatedHref(workspaceId, 'company', props.company.id)}
                className="flex items-center gap-2.5 text-[13px] hover:underline"
              >
                <RecordIcon icon="building" />
                <span className="truncate">
                  {props.company.name}
                  {props.company.archived ? ` (${RELATIONSHIP_WORDS.archived})` : ''}
                </span>
              </Link>
            </li>
          </Group>
        ) : null}

        {people ? (
          <Group
            title={`${RELATIONSHIP_WORDS.people} · ${people.length}`}
            action={
              !archived && props.onAddPerson ? (
                <button
                  type="button"
                  onClick={props.onAddPerson}
                  className="text-[12.5px] font-medium text-accent-text hover:underline"
                  data-testid="company-add-person"
                >
                  Add person
                </button>
              ) : null
            }
          >
            {people.length === 0 ? (
              <li className="text-[13px] text-text-2">Nobody linked yet.</li>
            ) : (
              people.map((p) => (
                <li key={p.id}>
                  <Link
                    href={relatedHref(workspaceId, 'person', p.id)}
                    className="flex items-center gap-2.5 text-[13px] hover:underline"
                  >
                    <Avatar name={p.fullName} seed={p.id} size="sm" />
                    <span className="truncate">
                      {p.fullName}
                      {p.archived ? ` (${RELATIONSHIP_WORDS.archived})` : ''}
                    </span>
                    <span className="truncate text-text-3">{p.phone ?? p.email ?? ''}</span>
                  </Link>
                </li>
              ))
            )}
          </Group>
        ) : null}

        {groups.map((g) => (
          <Group
            key={g.key}
            title={g.items.length > 1 ? `${g.title} · ${g.items.length}` : g.title}
          >
            {g.items.map((r) => (
              <PairRow
                key={r.id}
                workspaceId={workspaceId}
                pair={r}
                recordName={record.name}
                archived={archived}
              />
            ))}
          </Group>
        ))}

        {empty ? (
          <div className="text-[13px] text-text-2" data-testid="relationships-empty">
            {RELATIONSHIP_WORDS.none}{' '}
            {options.length === 0 && canManage ? (
              <Link
                href={`/app/w/${workspaceId}/settings/relationships`}
                className="font-medium text-accent-text hover:underline"
              >
                {RELATIONSHIP_WORDS.setUp}
              </Link>
            ) : (
              <span className="text-text-3">{RELATIONSHIP_WORDS.noneHint}</span>
            )}
          </div>
        ) : null}
      </div>

      {adding ? (
        <AddRelationshipDialog
          workspaceId={workspaceId}
          record={record}
          options={options}
          initial={adding === 'pick' ? null : adding}
          open
          onOpenChange={(o) => !o && setAdding(null)}
        />
      ) : null}
    </Card>
  );
}

function Group({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="mb-1.5 flex items-center justify-between">
        <h4 className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
          {title}
        </h4>
        {action}
      </div>
      <ul className="flex flex-col gap-2">{children}</ul>
    </section>
  );
}

/** One related record: its mark and name (to its own page), a line under it, and the pair's note. */
function PairRow({
  workspaceId,
  pair,
  recordName,
  archived,
}: {
  workspaceId: string;
  pair: Relationship;
  recordName: string;
  archived: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const o = pair.other;

  async function remove() {
    setBusy(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/relationship.delete', {
          body: { workspaceId, relationshipId: pair.id },
        }),
      );
      toast.success('Relationship removed.');
      setRemoving(false);
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="group flex items-start gap-2.5" data-testid={`relationship-${pair.id}`}>
      <span className="mt-0.5">
        <RelatedMark kind={o.kind} id={o.id} name={o.name} icon={o.recordType?.icon} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <Link
          href={relatedHref(workspaceId, o.kind, o.id)}
          className="truncate text-[13px] font-medium hover:underline"
        >
          {o.name}
          {o.archived ? (
            <span className="font-normal text-text-3"> ({RELATIONSHIP_WORDS.archived})</span>
          ) : null}
        </Link>
        {o.detail || pair.note ? (
          <span className="truncate text-xs text-text-3">
            {[pair.note, o.detail].filter(Boolean).join(' · ')}
          </span>
        ) : null}
      </span>
      {archived ? null : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`More for ${o.name}`}
              className="h-7 w-7 opacity-70 group-hover:opacity-100"
              data-testid={`relationship-menu-${pair.id}`}
            >
              <MoreHorizontal className="h-4 w-4" strokeWidth={1.5} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={() => setEditing(true)}>
              <Pencil className="h-4 w-4" strokeWidth={1.5} />
              {RELATIONSHIP_WORDS.editNote}
            </DropdownMenuItem>
            <DropdownMenuItem
              danger
              onSelect={() => setRemoving(true)}
              data-testid={`relationship-remove-${pair.id}`}
            >
              <Unlink className="h-4 w-4" strokeWidth={1.5} />
              {RELATIONSHIP_WORDS.remove}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {editing ? (
        <NoteDialog
          workspaceId={workspaceId}
          pair={pair}
          onClose={() => setEditing(false)}
          title={`${o.name} and ${recordName}`}
        />
      ) : null}
      <Dialog open={removing} onOpenChange={setRemoving}>
        <DialogContent
          title={RELATIONSHIP_WORDS.remove}
          description={RELATIONSHIP_WORDS.removeConfirm(o.name)}
        >
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setRemoving(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={busy}
              onClick={() => void remove()}
              data-testid="relationship-remove-confirm"
            >
              Remove
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </li>
  );
}

function NoteDialog({
  workspaceId,
  pair,
  title,
  onClose,
}: {
  workspaceId: string;
  pair: Relationship;
  title: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [note, setNote] = useState(pair.note ?? '');
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/relationship.update', {
          body: { workspaceId, relationshipId: pair.id, note: note.trim() || null },
        }),
      );
      onClose();
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={RELATIONSHIP_WORDS.editNote} description={title}>
        <form onSubmit={save} className="mt-4 flex flex-col gap-4" noValidate>
          <Field label={RELATIONSHIP_WORDS.note} htmlFor="relationship-note">
            <Input
              id="relationship-note"
              value={note}
              maxLength={200}
              placeholder={RELATIONSHIP_WORDS.notePlaceholder}
              onChange={(e) => setNote(e.target.value)}
              autoFocus
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              Save
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
