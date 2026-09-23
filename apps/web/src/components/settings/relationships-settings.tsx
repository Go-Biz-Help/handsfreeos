'use client';
import {
  cardinalityOf,
  cardinalitySentences,
  endKindWords,
  endPlural,
  lowerLabel,
  manyFor,
  pluralOf,
  recordIconOf,
  RECORD_ICONS,
  RECORD_ICON_LABELS,
  RECORD_KIND_STARTERS,
  RELATIONSHIP_STARTERS,
  RELATIONSHIP_WORDS,
  relationshipTypeName,
  type RecordKindStarter,
  type RelationshipCardinality,
  type RelationshipStarter,
} from '@hfos/core';
import { Archive, ArchiveRestore, ArrowLeft, ListPlus, Pencil, Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import type { paths } from '@hfos/api-client';
import { toast } from 'sonner';
import { RecordIcon, RECORD_ICON_COMPONENTS } from '@/components/relationships/record-icon';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Hint } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { fieldErrors } from '@/lib/api/field-errors';
import type { CustomRecordType, RelationshipType } from '@/lib/api/types';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { cn } from '@/lib/utils';

/** What the kind-of-record command takes, less the workspace. */
type KindBody = Omit<
  paths['/v1/commands/custom_record_type.create']['post'] extends {
    requestBody?: { content: { 'application/json': infer B } };
  }
    ? B
    : never,
  'workspaceId'
>;

/** An end as the editor picks it: a customer, a company, or one of the business's kinds (by id). */
type EndChoice = 'person' | 'company' | `kind:${string}`;

const endOf = (choice: EndChoice) =>
  choice.startsWith('kind:')
    ? { end: 'custom_record' as const, recordTypeId: choice.slice('kind:'.length) }
    : { end: choice as 'person' | 'company', recordTypeId: null };

/**
 * Settings → Relationships: the kinds of records the business keeps (pets, vehicles, properties) and how records
 * relate (owner and pet, parent and child, spouses). Starters make the common ones in one press; anything else is
 * a short form. Nothing is one-to-one unless somebody says so.
 */
export function RelationshipsSettings({
  workspaceId,
  kinds,
  types,
}: {
  workspaceId: string;
  kinds: CustomRecordType[];
  types: RelationshipType[];
}) {
  const router = useRouter();
  const [newKind, setNewKind] = useState(false);
  const [editKind, setEditKind] = useState<CustomRecordType | null>(null);
  const [newType, setNewType] = useState(false);
  const [editType, setEditType] = useState<RelationshipType | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useLiveRefresh(['custom_record_type', 'relationship_type', 'custom_field']);

  const liveKinds = kinds.filter((k) => !k.archived);
  const liveTypes = types.filter((t) => !t.archivedAt);
  const archivedKinds = kinds.filter((k) => k.archived);
  const archivedTypes = types.filter((t) => t.archivedAt);

  async function call(key: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(key);
    try {
      await fn();
      toast.success(ok);
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const archiveKind = (k: CustomRecordType, restore: boolean) => {
    if (
      !restore &&
      !confirm(
        `Archive ${k.plural}? Its tab, its records and its relationships are hidden. Nothing is deleted, and restoring brings them back.`,
      )
    )
      return;
    void call(
      `kind-${k.id}`,
      async () =>
        unwrap(
          await apiBrowser().POST(
            restore
              ? '/v1/commands/custom_record_type.restore'
              : '/v1/commands/custom_record_type.archive',
            { body: { workspaceId, customRecordTypeId: k.id } },
          ),
        ),
      restore ? `${k.plural} restored.` : `${k.plural} archived.`,
    );
  };

  const archiveType = (t: RelationshipType, restore: boolean) => {
    if (
      !restore &&
      !confirm(
        `Archive “${relationshipTypeName(t)}”? Its relationships are hidden from every record. Nothing is deleted, and restoring brings them back.`,
      )
    )
      return;
    void call(
      `type-${t.id}`,
      async () =>
        unwrap(
          await apiBrowser().POST(
            restore
              ? '/v1/commands/relationship_type.restore'
              : '/v1/commands/relationship_type.archive',
            { body: { workspaceId, relationshipTypeId: t.id } },
          ),
        ),
      restore ? 'Relationship restored.' : 'Relationship archived.',
    );
  };

  return (
    <div className="flex flex-col gap-6">
      <section>
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">
              {RELATIONSHIP_WORDS.recordKinds}
            </h2>
            <p className="max-w-[640px] text-[13px] text-text-2">
              The things your customers have that you keep track of: pets, vehicles, properties.
              Each gets a tab under Customers, its own fields, and its own timeline, tasks, files
              and visits.
            </p>
          </div>
          <Button onClick={() => setNewKind(true)} data-testid="kind-new">
            <Plus className="h-[18px] w-[18px]" strokeWidth={1.5} />
            {RELATIONSHIP_WORDS.newKind}
          </Button>
        </div>
        <Card className="overflow-hidden">
          {liveKinds.length === 0 ? (
            <p className="px-5 py-4 text-[13px] text-text-2">
              None yet. Start with pets, vehicles or properties, or make your own.
            </p>
          ) : (
            <ul className="divide-y divide-border" data-testid="kinds-list">
              {liveKinds.map((k) => (
                <li
                  key={k.id}
                  className="flex items-center gap-3 px-5 py-3"
                  data-testid={`kind-${k.key}`}
                >
                  <RecordIcon icon={k.icon} size="md" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="font-medium">{k.plural}</span>
                    <span className="text-xs text-text-3">
                      {k.recordCount} {k.recordCount === 1 ? 'record' : 'records'} · {k.fieldCount}{' '}
                      {k.fieldCount === 1 ? 'field' : 'fields'} · named by “{k.nameLabel}”
                    </span>
                  </span>
                  <Link
                    href={`/app/w/${workspaceId}/settings/fields?for=${k.id}`}
                    className="hidden text-[13px] text-accent-text hover:underline sm:inline"
                  >
                    Fields
                  </Link>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setEditKind(k)}
                    aria-label={`Edit ${k.plural}`}
                  >
                    <Pencil className="h-4 w-4" strokeWidth={1.5} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={busy === `kind-${k.id}`}
                    onClick={() => archiveKind(k, false)}
                    aria-label={`Archive ${k.plural}`}
                  >
                    <Archive className="h-4 w-4" strokeWidth={1.5} />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
        {archivedKinds.length ? (
          <ArchivedList
            items={archivedKinds.map((k) => ({
              id: k.id,
              label: k.plural,
              onRestore: () => archiveKind(k, true),
              busy: busy === `kind-${k.id}`,
            }))}
          />
        ) : null}
      </section>

      <section>
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">
              {RELATIONSHIP_WORDS.relationshipTypes}
            </h2>
            <p className="max-w-[640px] text-[13px] text-text-2">
              How records connect, read from both sides: a customer’s page lists their pets, and a
              pet’s page its owners. {RELATIONSHIP_WORDS.manyHint}
            </p>
          </div>
          <Button onClick={() => setNewType(true)} data-testid="type-new">
            <Plus className="h-[18px] w-[18px]" strokeWidth={1.5} />
            {RELATIONSHIP_WORDS.newType}
          </Button>
        </div>
        <Card className="overflow-hidden">
          {liveTypes.length === 0 ? (
            <p className="px-5 py-4 text-[13px] text-text-2">
              None yet. Spouses, parents and children, or who works where: start from one of ours.
            </p>
          ) : (
            <ul className="divide-y divide-border" data-testid="types-list">
              {liveTypes.map((t) => (
                <li key={t.id} className="flex items-start gap-3 px-5 py-3">
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="font-medium">{relationshipTypeName(t)}</span>
                    <span className="text-xs text-text-3">
                      {endKindWords({ end: t.a.end, kind: t.a.recordType })}
                      {t.mutual
                        ? ''
                        : ` and ${lowerLabel(endKindWords({ end: t.b.end, kind: t.b.recordType }))}`}{' '}
                      · {t.pairCount} {t.pairCount === 1 ? 'relationship' : 'relationships'}
                    </span>
                    <span className="mt-0.5 text-[13px] text-text-2">
                      {cardinalitySentences({
                        a: { end: t.a.end, label: t.a.label, kind: t.a.recordType },
                        b: { end: t.b.end, label: t.b.label, kind: t.b.recordType },
                        cardinality: t.cardinality,
                        mutual: t.mutual,
                      }).join(' ')}
                    </span>
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setEditType(t)}
                    aria-label="Edit"
                  >
                    <Pencil className="h-4 w-4" strokeWidth={1.5} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={busy === `type-${t.id}`}
                    onClick={() => archiveType(t, false)}
                    aria-label="Archive"
                  >
                    <Archive className="h-4 w-4" strokeWidth={1.5} />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
        {archivedTypes.length ? (
          <ArchivedList
            items={archivedTypes.map((t) => ({
              id: t.id,
              label: relationshipTypeName(t),
              onRestore: () => archiveType(t, true),
              busy: busy === `type-${t.id}`,
            }))}
          />
        ) : null}
      </section>

      {newKind ? (
        <NewKindDialog
          workspaceId={workspaceId}
          kinds={liveKinds}
          onClose={() => setNewKind(false)}
        />
      ) : null}
      {editKind ? (
        <EditKindDialog
          workspaceId={workspaceId}
          kind={editKind}
          onClose={() => setEditKind(null)}
        />
      ) : null}
      {newType ? (
        <TypeDialog
          workspaceId={workspaceId}
          kinds={liveKinds}
          types={liveTypes}
          onClose={() => setNewType(false)}
        />
      ) : null}
      {editType ? (
        <TypeDialog
          workspaceId={workspaceId}
          kinds={liveKinds}
          types={liveTypes}
          editing={editType}
          onClose={() => setEditType(null)}
        />
      ) : null}
    </div>
  );
}

function ArchivedList({
  items,
}: {
  items: { id: string; label: string; onRestore: () => void; busy: boolean }[];
}) {
  return (
    <details className="mt-2 text-[13px] text-text-2">
      <summary className="cursor-pointer select-none">Archived · {items.length}</summary>
      <ul className="mt-2 flex flex-col gap-1.5">
        {items.map((i) => (
          <li key={i.id} className="flex items-center gap-2">
            <span className="flex-1">{i.label}</span>
            <Button variant="ghost" size="sm" loading={i.busy} onClick={i.onRestore}>
              <ArchiveRestore className="h-4 w-4" strokeWidth={1.5} />
              Restore
            </Button>
          </li>
        ))}
      </ul>
    </details>
  );
}

function IconPicker({ value, onChange }: { value: string; onChange: (icon: string) => void }) {
  return (
    <div role="radiogroup" aria-label="Picture" className="flex flex-wrap gap-1.5">
      {RECORD_ICONS.map((icon) => {
        const Icon = RECORD_ICON_COMPONENTS[icon];
        return (
          <button
            key={icon}
            type="button"
            role="radio"
            aria-checked={value === icon}
            aria-label={RECORD_ICON_LABELS[icon]}
            title={RECORD_ICON_LABELS[icon]}
            onClick={() => onChange(icon)}
            className={cn(
              'inline-flex h-9 w-9 items-center justify-center rounded-control border',
              value === icon
                ? 'border-accent bg-accent-soft text-accent-text'
                : 'border-border hover:bg-card-2',
            )}
          >
            <Icon className="h-4 w-4" strokeWidth={1.5} />
          </button>
        );
      })}
    </div>
  );
}

/** A kind of record: one of the starters in one press, or a short form for anything else. */
function NewKindDialog({
  workspaceId,
  kinds,
  onClose,
}: {
  workspaceId: string;
  kinds: CustomRecordType[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [custom, setCustom] = useState(false);
  const [singular, setSingular] = useState('');
  const [plural, setPlural] = useState('');
  const [pluralTouched, setPluralTouched] = useState(false);
  const [nameLabel, setNameLabel] = useState('Name');
  const [icon, setIcon] = useState('box');
  const [link, setLink] = useState(true);
  const [linkLabel, setLinkLabel] = useState('Owner');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const taken = new Set(kinds.map((k) => k.singular.trim().toLowerCase()));

  useEffect(() => {
    if (!pluralTouched) setPlural(singular.trim() ? pluralOf(singular.trim()) : '');
  }, [singular, pluralTouched]);

  async function create(key: string, body: KindBody, done: string) {
    setBusy(key);
    setErrors({});
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/custom_record_type.create', {
          body: { workspaceId, ...body },
        }),
      );
      toast.success(done);
      onClose();
      router.refresh();
    } catch (e) {
      const fe = fieldErrors(e);
      if (Object.keys(fe).length) setErrors(fe);
      else toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const fromStarter = (s: RecordKindStarter) =>
    create(
      s.key,
      {
        singular: s.singular,
        plural: s.plural,
        nameLabel: s.nameLabel,
        icon: s.icon,
        fields: s.fields.map((f) => ({
          label: f.label,
          type: f.type,
          options: f.options ? [...f.options] : undefined,
        })),
        link: { ...s.link },
      },
      `${s.plural} added, with their fields and owners.`,
    );

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!singular.trim()) return setErrors({ singular: 'Name it.' });
    void create(
      'custom',
      {
        singular: singular.trim(),
        plural: plural.trim() || undefined,
        nameLabel: nameLabel.trim() || undefined,
        icon: recordIconOf(icon),
        ...(link && linkLabel.trim()
          ? {
              link: {
                end: 'person' as const,
                label: linkLabel.trim(),
                cardinality: 'many_to_many' as const,
              },
            }
          : {}),
      },
      `${plural.trim() || pluralOf(singular.trim())} added.`,
    );
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={RELATIONSHIP_WORDS.newKind}
        description={
          custom ? 'Name it, and say what one of them is called.' : RELATIONSHIP_WORDS.starterHint
        }
        className="w-[min(600px,calc(100vw-32px))]"
      >
        {!custom ? (
          <div className="mt-4 flex flex-col gap-3">
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2" data-testid="kind-starters">
              {RECORD_KIND_STARTERS.map((s) => {
                const have = taken.has(s.singular.toLowerCase());
                return (
                  <li key={s.key}>
                    <button
                      type="button"
                      disabled={have || !!busy}
                      onClick={() => void fromStarter(s)}
                      data-testid={`kind-starter-${s.key}`}
                      className="flex w-full items-start gap-3 rounded-menu border border-border p-3 text-left hover:bg-card-2 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <RecordIcon icon={s.icon} size="md" />
                      <span className="flex min-w-0 flex-col">
                        <span className="text-sm font-medium">
                          {s.plural}
                          {have ? <span className="font-normal text-text-3"> · added</span> : null}
                        </span>
                        <span className="text-xs text-text-3">{s.hint}</span>
                        <span className="mt-1 text-xs text-text-2">
                          {s.fields.map((f) => f.label).join(', ')}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <Button variant="secondary" onClick={() => setCustom(true)} data-testid="kind-custom">
              <ListPlus className="h-4 w-4" strokeWidth={1.5} />
              Something else
            </Button>
          </div>
        ) : (
          <form
            onSubmit={submit}
            className="mt-4 flex flex-col gap-3.5"
            noValidate
            data-testid="kind-form"
          >
            <button
              type="button"
              onClick={() => setCustom(false)}
              className="inline-flex items-center gap-1.5 self-start text-[13px] text-accent-text hover:underline"
            >
              <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.75} />
              Starters
            </button>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field
                label="One is called"
                htmlFor="kind-singular"
                error={errors.singular}
                hint="Like Boat, Horse or Unit"
              >
                <Input
                  id="kind-singular"
                  value={singular}
                  maxLength={40}
                  autoFocus
                  onChange={(e) => setSingular(e.target.value)}
                />
              </Field>
              <Field label="More than one" htmlFor="kind-plural" error={errors.plural}>
                <Input
                  id="kind-plural"
                  value={plural}
                  maxLength={40}
                  onChange={(e) => {
                    setPluralTouched(true);
                    setPlural(e.target.value);
                  }}
                />
              </Field>
            </div>
            <Field
              label="What each one’s name is called"
              htmlFor="kind-name-label"
              error={errors.nameLabel}
              hint="Name, Address, Year and model…"
            >
              <Input
                id="kind-name-label"
                value={nameLabel}
                maxLength={40}
                onChange={(e) => setNameLabel(e.target.value)}
              />
            </Field>
            <div>
              <div className="mb-1.5 text-[13px] font-medium">Picture</div>
              <IconPicker value={icon} onChange={setIcon} />
            </div>
            <div className="rounded-menu border border-border p-3">
              <Checkbox
                label="Connect them to customers"
                checked={link}
                onChange={(e) => setLink(e.target.checked)}
              />
              {link ? (
                <div className="mt-3">
                  <Field
                    label={`A customer is their…`}
                    htmlFor="kind-link-label"
                    hint={`A customer can have many ${lowerLabel(plural || 'of them')}, and each can have many ${lowerLabel(pluralOf(linkLabel || 'owner'))}. Change it later in the list below.`}
                  >
                    <Input
                      id="kind-link-label"
                      value={linkLabel}
                      maxLength={40}
                      onChange={(e) => setLinkLabel(e.target.value)}
                    />
                  </Field>
                </div>
              ) : null}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" loading={busy === 'custom'} data-testid="kind-save">
                Add
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function EditKindDialog({
  workspaceId,
  kind,
  onClose,
}: {
  workspaceId: string;
  kind: CustomRecordType;
  onClose: () => void;
}) {
  const router = useRouter();
  const [singular, setSingular] = useState(kind.singular);
  const [plural, setPlural] = useState(kind.plural);
  const [nameLabel, setNameLabel] = useState(kind.nameLabel);
  const [icon, setIcon] = useState(kind.icon);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/custom_record_type.update', {
          body: {
            workspaceId,
            customRecordTypeId: kind.id,
            singular: singular.trim(),
            plural: plural.trim(),
            nameLabel: nameLabel.trim(),
            icon: recordIconOf(icon),
          },
        }),
      );
      toast.success('Saved.');
      onClose();
      router.refresh();
    } catch (err) {
      const fe = fieldErrors(err);
      if (Object.keys(fe).length) setErrors(fe);
      else toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`Edit ${kind.plural}`} className="w-[min(560px,calc(100vw-32px))]">
        <form onSubmit={save} className="mt-4 flex flex-col gap-3.5" noValidate>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="One is called" htmlFor="edit-kind-singular" error={errors.singular}>
              <Input
                id="edit-kind-singular"
                value={singular}
                maxLength={40}
                onChange={(e) => setSingular(e.target.value)}
              />
            </Field>
            <Field label="More than one" htmlFor="edit-kind-plural" error={errors.plural}>
              <Input
                id="edit-kind-plural"
                value={plural}
                maxLength={40}
                onChange={(e) => setPlural(e.target.value)}
              />
            </Field>
          </div>
          <Field
            label="What each one’s name is called"
            htmlFor="edit-kind-name"
            error={errors.nameLabel}
          >
            <Input
              id="edit-kind-name"
              value={nameLabel}
              maxLength={40}
              onChange={(e) => setNameLabel(e.target.value)}
            />
          </Field>
          <div>
            <div className="mb-1.5 text-[13px] font-medium">Picture</div>
            <IconPicker value={icon} onChange={setIcon} />
          </div>
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

/** A relationship type: from a starter, or two ends, their names, and how many on each. */
function TypeDialog({
  workspaceId,
  kinds,
  types,
  editing,
  onClose,
}: {
  workspaceId: string;
  kinds: CustomRecordType[];
  types: RelationshipType[];
  editing?: RelationshipType;
  onClose: () => void;
}) {
  const router = useRouter();
  const choiceOf = (e: RelationshipType['a']): EndChoice =>
    e.end === 'custom_record' && e.recordType ? `kind:${e.recordType.id}` : (e.end as EndChoice);
  const [custom, setCustom] = useState(!!editing);
  const [mutual, setMutual] = useState(editing?.mutual ?? false);
  const [aEnd, setAEnd] = useState<EndChoice>(editing ? choiceOf(editing.a) : 'person');
  const [bEnd, setBEnd] = useState<EndChoice>(editing ? choiceOf(editing.b) : 'person');
  const [aLabel, setALabel] = useState(editing?.a.label ?? '');
  const [bLabel, setBLabel] = useState(editing?.b.label ?? '');
  const [aMany, setAMany] = useState(editing ? manyFor(editing.cardinality, 'a') : true);
  const [bMany, setBMany] = useState(editing ? manyFor(editing.cardinality, 'b') : true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const kindOf = (c: EndChoice) =>
    c.startsWith('kind:') ? (kinds.find((k) => `kind:${k.id}` === c) ?? null) : null;
  const words = (c: EndChoice, label: string) => ({
    end: endOf(c).end,
    label:
      label.trim() ||
      (c === 'person'
        ? 'Customer'
        : c === 'company'
          ? 'Company'
          : (kindOf(c)?.singular ?? 'Record')),
    kind: kindOf(c),
  });
  const cardinality: RelationshipCardinality = mutual
    ? aMany
      ? 'many_to_many'
      : 'one_to_one'
    : cardinalityOf(aMany, bMany);
  const a = words(aEnd, aLabel);
  const b = mutual ? a : words(bEnd, bLabel);
  const sentences = cardinalitySentences({ a, b, cardinality, mutual });
  const have = new Set(types.map((t) => relationshipTypeName(t).toLowerCase()));

  async function send(key: string, fn: () => Promise<unknown>, done: string) {
    setBusy(key);
    setErrors({});
    try {
      await fn();
      toast.success(done);
      onClose();
      router.refresh();
    } catch (e) {
      const fe = fieldErrors(e);
      if (Object.keys(fe).length) setErrors(fe);
      else toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const fromStarter = (s: RelationshipStarter) =>
    send(
      s.key,
      async () =>
        unwrap(
          await apiBrowser().POST('/v1/commands/relationship_type.create', {
            body: { workspaceId, a: s.a, b: s.b, cardinality: s.cardinality, mutual: s.mutual },
          }),
        ),
      `${s.name} added.`,
    );

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!aLabel.trim()) return setErrors({ aLabel: 'Say what this side is called.' });
    if (!mutual && !bLabel.trim()) return setErrors({ bLabel: 'Say what this side is called.' });
    if (editing) {
      void send(
        'edit',
        async () =>
          unwrap(
            await apiBrowser().POST('/v1/commands/relationship_type.update', {
              body: {
                workspaceId,
                relationshipTypeId: editing.id,
                aLabel: aLabel.trim(),
                ...(mutual ? {} : { bLabel: bLabel.trim() }),
                cardinality,
              },
            }),
          ),
        'Saved.',
      );
      return;
    }
    void send(
      'custom',
      async () =>
        unwrap(
          await apiBrowser().POST('/v1/commands/relationship_type.create', {
            body: {
              workspaceId,
              a: { ...endOf(aEnd), label: aLabel.trim() },
              b: mutual
                ? { ...endOf(aEnd), label: aLabel.trim() }
                : { ...endOf(bEnd), label: bLabel.trim() },
              cardinality,
              mutual,
            },
          }),
        ),
      'Relationship added.',
    );
  }

  const endSelect = (id: string, value: EndChoice, onChange: (c: EndChoice) => void) => (
    <Select
      id={id}
      value={value}
      disabled={!!editing}
      onChange={(e) => onChange(e.target.value as EndChoice)}
    >
      <option value="person">A customer</option>
      <option value="company">A company</option>
      {kinds.map((k) => (
        <option key={k.id} value={`kind:${k.id}`}>
          A {lowerLabel(k.singular)}
        </option>
      ))}
    </Select>
  );

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={editing ? `Edit ${relationshipTypeName(editing)}` : RELATIONSHIP_WORDS.newType}
        description={
          editing
            ? 'What each side is called, and how many each can have. The sides themselves stay.'
            : custom
              ? 'Pick the two sides, name them, and say how many each can have.'
              : RELATIONSHIP_WORDS.starterHint
        }
        className="w-[min(600px,calc(100vw-32px))]"
      >
        {!custom ? (
          <div className="mt-4 flex flex-col gap-3">
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2" data-testid="type-starters">
              {RELATIONSHIP_STARTERS.map((s) => {
                const added = have.has(relationshipTypeName(s).toLowerCase());
                return (
                  <li key={s.key}>
                    <button
                      type="button"
                      disabled={added || !!busy}
                      onClick={() => void fromStarter(s)}
                      data-testid={`type-starter-${s.key}`}
                      className="flex w-full flex-col rounded-menu border border-border p-3 text-left hover:bg-card-2 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <span className="text-sm font-medium">
                        {s.name}
                        {added ? <span className="font-normal text-text-3"> · added</span> : null}
                      </span>
                      <span className="text-xs text-text-3">{s.hint}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <Button variant="secondary" onClick={() => setCustom(true)} data-testid="type-custom">
              <ListPlus className="h-4 w-4" strokeWidth={1.5} />
              Something else
            </Button>
          </div>
        ) : (
          <form
            onSubmit={submit}
            className="mt-4 flex flex-col gap-3.5"
            noValidate
            data-testid="type-form"
          >
            {editing ? null : (
              <>
                <button
                  type="button"
                  onClick={() => setCustom(false)}
                  className="inline-flex items-center gap-1.5 self-start text-[13px] text-accent-text hover:underline"
                >
                  <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.75} />
                  Starters
                </button>
                <Checkbox
                  label={`The same on both sides, like spouses or siblings`}
                  checked={mutual}
                  onChange={(e) => {
                    setMutual(e.target.checked);
                    if (e.target.checked) setBEnd(aEnd);
                  }}
                />
              </>
            )}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={mutual ? 'Between' : 'One side'} htmlFor="type-a-end">
                {endSelect('type-a-end', aEnd, (c) => {
                  setAEnd(c);
                  if (mutual) setBEnd(c);
                })}
              </Field>
              <Field
                label={mutual ? 'Each is the other’s' : 'Called'}
                htmlFor="type-a-label"
                error={errors.aLabel ?? errors.label}
                hint={mutual ? 'Spouse, Sibling, Partner…' : 'Owner, Parent, Tenant…'}
              >
                <Input
                  id="type-a-label"
                  value={aLabel}
                  maxLength={40}
                  onChange={(e) => setALabel(e.target.value)}
                />
              </Field>
            </div>
            {mutual ? null : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Other side" htmlFor="type-b-end">
                  {endSelect('type-b-end', bEnd, setBEnd)}
                </Field>
                <Field
                  label="Called"
                  htmlFor="type-b-label"
                  error={errors.bLabel}
                  hint="Pet, Child, Unit…"
                >
                  <Input
                    id="type-b-label"
                    value={bLabel}
                    maxLength={40}
                    onChange={(e) => setBLabel(e.target.value)}
                  />
                </Field>
              </div>
            )}
            <div className="flex flex-col gap-2 rounded-menu border border-border p-3">
              <div className="text-[13px] font-medium">How many</div>
              <label className="flex flex-wrap items-center gap-2 text-[13px]">
                <span>
                  {mutual
                    ? `Each ${lowerLabel(endKindWords({ end: a.end, kind: a.kind }))} can have`
                    : `Each ${lowerLabel(a.label)} can have`}
                </span>
                <Select
                  selectSize="sm"
                  className="w-auto"
                  value={aMany ? 'many' : 'one'}
                  onChange={(e) => setAMany(e.target.value === 'many')}
                  data-testid="type-a-many"
                >
                  <option value="many">many {lowerLabel(endPlural(b))}</option>
                  <option value="one">one {lowerLabel(b.label)}</option>
                </Select>
              </label>
              {mutual ? null : (
                <label className="flex flex-wrap items-center gap-2 text-[13px]">
                  <span>Each {lowerLabel(b.label)} can have</span>
                  <Select
                    selectSize="sm"
                    className="w-auto"
                    value={bMany ? 'many' : 'one'}
                    onChange={(e) => setBMany(e.target.value === 'many')}
                    data-testid="type-b-many"
                  >
                    <option value="many">many {lowerLabel(endPlural(a))}</option>
                    <option value="one">one {lowerLabel(a.label)}</option>
                  </Select>
                </label>
              )}
              <Hint className="mt-0">{RELATIONSHIP_WORDS.manyHint}</Hint>
            </div>
            <p className="text-[13px] text-text-2" data-testid="type-preview">
              {sentences.join(' ')}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="submit"
                loading={busy === 'custom' || busy === 'edit'}
                data-testid="type-save"
              >
                {editing ? 'Save' : 'Add'}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
