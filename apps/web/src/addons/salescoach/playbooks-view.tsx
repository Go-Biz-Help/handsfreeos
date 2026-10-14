'use client';
/**
 * Sales Coach's playbooks (`?view=playbooks`): the usual one first, then the rest, then archived ones. Owners and
 * admins (`salescoach.manage`) write them: by hand, or from a draft the AI makes from the business or from their own
 * pasted script (`salescoach.playbook.draft`, a worker action), which they edit before saving. Everyone else reads.
 */
import {
  PLAYBOOK_KIND_LABELS,
  PLAYBOOK_KINDS,
  PLAYBOOK_LIMITS,
  blankPlaybook,
  type PlaybookDetails,
  type PlaybookKind,
} from '@hfos/core/addons/salescoach/playbooks';
import type { PlaybookDraftOutput } from '@hfos/core/addons/salescoach/playbooks';
import { SALESCOACH_WORDS as W } from '@hfos/core/addons/salescoach/words';
import { Plus, Sparkles, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Label } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { workerPost } from '@/lib/api/worker';
import type { Playbook } from './types';

interface Draft {
  readonly id: string | null;
  readonly name: string;
  readonly kind: PlaybookKind;
  readonly details: PlaybookDetails;
}

const fresh = (): Draft => ({ id: null, name: '', kind: 'first_call', details: blankPlaybook() });

export function PlaybooksView({
  workspaceId,
  playbooks,
  canManage,
}: {
  workspaceId: string;
  playbooks: readonly Playbook[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<Draft | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [script, setScript] = useState('');
  const [busy, setBusy] = useState(false);

  const askAi = async () => {
    setBusy(true);
    try {
      const out = await workerPost<PlaybookDraftOutput>(
        '/v1/addons/salescoach/actions/salescoach.playbook.draft',
        {
          workspaceId,
          input: { kind: editing?.kind ?? 'first_call', ...(script.trim() ? { script } : {}) },
        },
      );
      setEditing({
        id: null,
        name: out.name,
        kind: editing?.kind ?? 'first_call',
        details: out.details,
      });
      setDrafting(false);
      setScript('');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await fn();
      if (done) toast.success(done);
      setEditing(null);
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const save = (d: Draft, isDefault?: boolean) =>
    act(
      () =>
        apiBrowser()
          .POST('/v1/commands/salescoach.playbook.save', {
            body: {
              workspaceId,
              ...(d.id ? { playbookId: d.id } : {}),
              name: d.name,
              kind: d.kind,
              ...(isDefault ? { isDefault } : {}),
              details: d.details,
            },
          })
          .then(unwrap),
      W.playbooks.saved,
    );
  const archive = (p: Playbook, archived: boolean) =>
    act(() =>
      apiBrowser()
        .POST('/v1/commands/salescoach.playbook.archive', {
          body: { workspaceId, playbookId: p.id, archived },
        })
        .then(unwrap),
    );

  if (editing)
    return (
      <Editor
        draft={editing}
        busy={busy}
        onChange={setEditing}
        onSave={() => void save(editing)}
        onCancel={() => setEditing(null)}
      />
    );

  return (
    <div className="space-y-4" data-testid="salescoach-playbooks">
      <p className="text-[13.5px] text-text-2">
        {W.playbooks.about} {canManage ? null : W.playbooks.readOnly}
      </p>
      {canManage ? (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setEditing(fresh())}>
            <Plus className="mr-1 h-4 w-4" strokeWidth={1.75} aria-hidden />
            {W.playbooks.add}
          </Button>
          <Button variant="secondary" onClick={() => setDrafting((d) => !d)}>
            <Sparkles className="mr-1 h-4 w-4" strokeWidth={1.75} aria-hidden />
            {W.playbooks.draft}
          </Button>
        </div>
      ) : null}
      {drafting ? (
        <Card className="space-y-3 p-4">
          <p className="text-[13px] text-text-2">{W.playbooks.draftAbout}</p>
          <div>
            <Label htmlFor="coach-script">{W.playbooks.draftScript}</Label>
            <Textarea
              id="coach-script"
              rows={6}
              value={script}
              maxLength={PLAYBOOK_LIMITS.pastedScript}
              onChange={(e) => setScript(e.target.value)}
            />
          </div>
          <Button disabled={busy} onClick={() => void askAi()} data-testid="salescoach-draft">
            {busy ? W.playbooks.drafting : W.playbooks.draft}
          </Button>
        </Card>
      ) : null}
      {playbooks.length === 0 ? (
        <EmptyState title={W.tabs.playbooks} dashed>
          {W.playbooks.none}
        </EmptyState>
      ) : (
        <div className="space-y-3">
          {playbooks.map((p) => (
            <Card key={p.id} className="p-4" data-testid="salescoach-playbook">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[15px] font-semibold">{p.name}</span>
                <Badge>{PLAYBOOK_KIND_LABELS[p.kind]}</Badge>
                {p.isDefault ? <Badge variant="accent">{W.playbooks.usual}</Badge> : null}
                {p.archivedAt ? <Badge>{W.playbooks.archived}</Badge> : null}
                {canManage ? (
                  <div className="ml-auto flex flex-wrap gap-1.5">
                    {!p.archivedAt ? (
                      <>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() =>
                            setEditing({ id: p.id, name: p.name, kind: p.kind, details: p.details })
                          }
                        >
                          Edit
                        </Button>
                        {!p.isDefault ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={busy}
                            onClick={() =>
                              void save(
                                { id: p.id, name: p.name, kind: p.kind, details: p.details },
                                true,
                              )
                            }
                          >
                            {W.playbooks.makeUsual}
                          </Button>
                        ) : null}
                      </>
                    ) : null}
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => void archive(p, !p.archivedAt)}
                    >
                      {p.archivedAt ? W.playbooks.restore : W.playbooks.archive}
                    </Button>
                  </div>
                ) : null}
              </div>
              <p className="mt-1.5 text-[12.5px] text-text-3">
                {p.details.steps.length} steps · {p.details.objections.length} objections ·{' '}
                {p.details.points.length} talking points
              </p>
              {!canManage && !p.archivedAt ? <ReadOnly details={p.details} /> : null}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function ReadOnly({ details }: { details: PlaybookDetails }) {
  return (
    <div className="mt-3 space-y-3 text-[13.5px]">
      {details.steps.length ? (
        <ol className="list-decimal space-y-1 pl-5">
          {details.steps.map((s) => (
            <li key={s.id}>
              {s.title}
              {s.say ? <span className="text-text-2"> — “{s.say}”</span> : null}
            </li>
          ))}
        </ol>
      ) : null}
      {details.objections.map((o) => (
        <div key={o.id}>
          <div className="font-medium">“{o.objection}”</div>
          <div className="text-text-2">{o.answer}</div>
        </div>
      ))}
    </div>
  );
}

/** One list of a playbook's parts: each row's fields, a remove button, and a button to add one. */
function PartList<T extends { id: string }>({
  title,
  about,
  items,
  max,
  addLabel,
  blank,
  onChange,
  fields,
}: {
  title: string;
  about: string;
  items: readonly T[];
  max: number;
  addLabel: string;
  blank: () => T;
  onChange: (items: T[]) => void;
  fields: readonly {
    readonly key: keyof T & string;
    readonly label: string;
    readonly max: number;
    readonly long?: boolean;
  }[];
}) {
  const set = (i: number, key: keyof T & string, value: string) =>
    onChange(items.map((it, j) => (j === i ? { ...it, [key]: value } : it)));
  return (
    <section className="space-y-2">
      <h3 className="text-[14px] font-semibold">{title}</h3>
      <p className="-mt-1 text-[12.5px] text-text-3">{about}</p>
      {items.map((it, i) => (
        <div key={i} className="flex items-start gap-2 rounded-control border border-border p-2.5">
          <span className="mt-2 w-5 flex-none text-[12px] tabular-nums text-text-3">{i + 1}</span>
          <div className="grid min-w-0 flex-1 gap-2 md:grid-cols-2">
            {fields.map((f) =>
              f.long ? (
                <Textarea
                  key={f.key}
                  aria-label={f.label}
                  placeholder={f.label}
                  rows={2}
                  maxLength={f.max}
                  value={String(it[f.key] ?? '')}
                  onChange={(e) => set(i, f.key, e.target.value)}
                />
              ) : (
                <Input
                  key={f.key}
                  aria-label={f.label}
                  placeholder={f.label}
                  maxLength={f.max}
                  value={String(it[f.key] ?? '')}
                  onChange={(e) => set(i, f.key, e.target.value)}
                />
              ),
            )}
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label={W.playbooks.remove}
            onClick={() => onChange(items.filter((_, j) => j !== i))}
          >
            <Trash2 className="h-4 w-4" strokeWidth={1.75} aria-hidden />
          </Button>
        </div>
      ))}
      {items.length < max ? (
        <Button variant="ghost" size="sm" onClick={() => onChange([...items, blank()])}>
          <Plus className="mr-1 h-4 w-4" strokeWidth={1.75} aria-hidden />
          {addLabel}
        </Button>
      ) : null}
    </section>
  );
}

function Editor({
  draft,
  busy,
  onChange,
  onSave,
  onCancel,
}: {
  draft: Draft;
  busy: boolean;
  onChange: (d: Draft) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const L = PLAYBOOK_LIMITS;
  const details = (d: Partial<PlaybookDetails>) =>
    onChange({ ...draft, details: { ...draft.details, ...d } });
  return (
    <Card className="space-y-5 p-4 md:p-5" data-testid="salescoach-editor">
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <Label htmlFor="coach-name">{W.playbooks.name}</Label>
          <Input
            id="coach-name"
            value={draft.name}
            maxLength={L.name}
            onChange={(e) => onChange({ ...draft, name: e.target.value })}
          />
        </div>
        <div>
          <Label htmlFor="coach-kind">{W.playbooks.kind}</Label>
          <Select
            id="coach-kind"
            value={draft.kind}
            onChange={(e) => onChange({ ...draft, kind: e.target.value as PlaybookKind })}
          >
            {PLAYBOOK_KINDS.map((k) => (
              <option key={k} value={k}>
                {PLAYBOOK_KIND_LABELS[k]}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <PartList
        title={W.playbooks.steps}
        about={W.playbooks.stepsAbout}
        items={draft.details.steps}
        max={L.steps}
        addLabel={W.playbooks.addStep}
        blank={() => ({ id: 's1', title: '', say: '' })}
        onChange={(steps) => details({ steps })}
        fields={[
          { key: 'title', label: W.playbooks.step, max: L.stepTitle },
          { key: 'say', label: W.playbooks.say, max: L.stepSay, long: true },
        ]}
      />
      <PartList
        title={W.playbooks.objections}
        about={W.playbooks.objectionsAbout}
        items={draft.details.objections}
        max={L.objections}
        addLabel={W.playbooks.addObjection}
        blank={() => ({ id: 'o1', objection: '', answer: '' })}
        onChange={(objections) => details({ objections })}
        fields={[
          { key: 'objection', label: W.playbooks.objection, max: L.objection },
          { key: 'answer', label: W.playbooks.answer, max: L.answer, long: true },
        ]}
      />
      <PartList
        title={W.playbooks.points}
        about={W.playbooks.pointsAbout}
        items={draft.details.points}
        max={L.points}
        addLabel={W.playbooks.addPoint}
        blank={() => ({ id: 'p1', topic: '', fact: '' })}
        onChange={(points) => details({ points })}
        fields={[
          { key: 'topic', label: W.playbooks.topic, max: L.topic },
          { key: 'fact', label: W.playbooks.fact, max: L.fact, long: true },
        ]}
      />
      <div className="flex gap-2">
        <Button
          disabled={busy || !draft.name.trim()}
          onClick={onSave}
          data-testid="salescoach-save"
        >
          {W.playbooks.save}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {W.playbooks.cancel}
        </Button>
      </div>
    </Card>
  );
}
