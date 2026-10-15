'use client';
/**
 * The Instructions tab (HANDSFREEOS_AI_FEEDBACK_IMPLEMENTATION_PLAN.md): the rules the AI teammate reads in full on
 * every reply, call and test, after its own safety rules. People who manage it add, edit and delete them; feedback
 * on its replies adds them too, once someone saves the rule it suggests.
 */
import { instructionSourceWords } from '@hfos/core';
import { Pencil, Trash2 } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Label } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { feedbackActions, type Instruction, type InstructionList } from '@/lib/ai-team/feedback';
import type { TeammateGet } from '@/lib/ai-team/types';
import { errorMessage } from '@/lib/api/client';
import { TeammateTabShell } from './tab-shell';

const MAX_WORDS = 300;

export function TeammateInstructionsTab({
  workspaceId,
  data,
  initial,
}: {
  workspaceId: string;
  data: TeammateGet;
  initial: InstructionList;
}) {
  return (
    <TeammateTabShell
      workspaceId={workspaceId}
      data={data}
      emptyBody="Once it’s set up, tell it how your business does things here."
      testId="teammate-instructions-tab"
    >
      {data.teammate ? (
        <Instructions workspaceId={workspaceId} name={data.teammate.name} initial={initial} />
      ) : null}
    </TeammateTabShell>
  );
}

function Instructions({
  workspaceId,
  name,
  initial,
}: {
  workspaceId: string;
  name: string;
  initial: InstructionList;
}) {
  const id = useId();
  const actions = useMemo(() => feedbackActions(workspaceId), [workspaceId]);
  const [list, setList] = useState<readonly Instruction[]>(initial.instructions);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const can = initial.canManage;
  const full = list.length >= initial.max;

  async function add() {
    const body = draft.trim();
    if (!body) return;
    setBusy(true);
    try {
      const made = await actions.addInstruction(body);
      setList((now) => [...now, made]);
      setDraft('');
      toast.success(`${name} follows it from its next reply.`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3" data-testid="instructions">
      <Card className="p-4">
        <h2 className="text-[15px] font-semibold">Instructions</h2>
        <p className="mt-1 text-[13px] text-text-2">
          {name} reads every one of these on every reply, call and test. Its own safety rules always
          come first. Rules you save from feedback on its replies land here too.
        </p>
        {can ? (
          <form
            className="mt-3"
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
          >
            <Label htmlFor={`${id}-new`}>New instruction</Label>
            <Textarea
              id={`${id}-new`}
              value={draft}
              maxLength={MAX_WORDS}
              disabled={full}
              placeholder="Like “Never offer a Sunday visit. We don’t work Sundays.”"
              onChange={(e) => setDraft(e.target.value)}
              className="min-h-[64px]"
              data-testid="instruction-new"
            />
            <div className="mt-2 flex items-center gap-3">
              <Button
                type="submit"
                size="sm"
                loading={busy}
                disabled={!draft.trim() || full}
                data-testid="instruction-add"
              >
                Add instruction
              </Button>
              <span className="text-[12px] text-text-3">
                {full
                  ? `That’s ${initial.max}, the most it keeps. Delete one it no longer needs to add another.`
                  : `${list.length} of ${initial.max}`}
              </span>
            </div>
          </form>
        ) : (
          <p className="mt-2 text-[12.5px] text-text-3">
            Only people who manage the AI teammate can change these.
          </p>
        )}
      </Card>
      {list.length === 0 ? (
        <Card>
          <EmptyState
            title="No instructions yet"
            actions={
              <ButtonLink
                size="sm"
                variant="secondary"
                href={`/app/w/${workspaceId}/ai-team/review`}
              >
                Review its replies
              </ButtonLink>
            }
          >
            Add one above, or rate {name}’s replies in Review: a thumbs down that says why comes
            back as a rule to save.
          </EmptyState>
        </Card>
      ) : (
        <Card className="divide-y divide-border">
          {list.map((i, n) => (
            <InstructionRow
              key={i.id}
              n={n + 1}
              item={i}
              can={can}
              onSaved={(next) => setList((now) => now.map((x) => (x.id === next.id ? next : x)))}
              onDeleted={() => setList((now) => now.filter((x) => x.id !== i.id))}
              edit={(body) => actions.editInstruction(i.id, body)}
              remove={() => actions.deleteInstruction(i.id)}
            />
          ))}
        </Card>
      )}
    </div>
  );
}

function InstructionRow({
  n,
  item,
  can,
  onSaved,
  onDeleted,
  edit,
  remove,
}: {
  n: number;
  item: Instruction;
  can: boolean;
  onSaved: (i: Instruction) => void;
  onDeleted: () => void;
  edit: (body: string) => Promise<Instruction>;
  remove: () => Promise<void>;
}) {
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(item.body);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      onSaved(await edit(body.trim()));
      setEditing(false);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function del() {
    if (!confirm(`Delete this instruction? It stops following it from its next reply.`)) return;
    setBusy(true);
    try {
      await remove();
      onDeleted();
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <div className="flex items-start gap-3 px-4 py-3" data-testid={`instruction-${item.id}`}>
      <span className="mt-0.5 w-5 flex-none text-right text-[12px] tabular-nums text-text-3">
        {n}
      </span>
      <div className="min-w-0 flex-1">
        {editing ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <label htmlFor={`${id}-body`} className="sr-only">
              Instruction {n}
            </label>
            <Textarea
              id={`${id}-body`}
              value={body}
              maxLength={MAX_WORDS}
              onChange={(e) => setBody(e.target.value)}
              className="min-h-[56px]"
            />
            <div className="mt-2 flex gap-2">
              <Button type="submit" size="sm" loading={busy} disabled={!body.trim()}>
                Save
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setBody(item.body);
                  setEditing(false);
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <>
            <p className="whitespace-pre-wrap text-[14px] leading-[1.45] text-text [overflow-wrap:anywhere]">
              {item.body}
            </p>
            <p className="mt-0.5 text-[12px] text-text-3">{instructionSourceWords(item)}</p>
          </>
        )}
      </div>
      {can && !editing ? (
        <div className="flex flex-none gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Edit instruction ${n}`}
            onClick={() => setEditing(true)}
          >
            <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Delete instruction ${n}`}
            disabled={busy}
            onClick={() => void del()}
          >
            <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
          </Button>
        </div>
      ) : null}
    </div>
  );
}
