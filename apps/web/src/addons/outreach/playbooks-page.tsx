'use client';
/**
 * Social Outreach's first page (docs/outreach.md): how to start with the browser extension, and the business's
 * playbooks: what it's after on social media, who it's for, the steps it takes, how it sounds and which of its tags
 * to use. Everyone using the add-on reads them; owners and admins write them, from a template or blank, and archive
 * them rather than delete them.
 */
import {
  blankPlaybook,
  PLAYBOOK_GOAL_KEYS,
  PLAYBOOK_GOALS,
  PLAYBOOK_STEP_KEYS,
  PLAYBOOK_STEPS,
  PLAYBOOK_TEMPLATE_KEYS,
  PLAYBOOK_TEMPLATES,
  type PlaybookDetails,
  type PlaybookGoal,
  type PlaybookStep,
  type PlaybookTemplateKey,
} from '@hfos/core/addons/outreach/playbooks';
import { useState } from 'react';
import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { cn, relativeTime } from '@/lib/utils';
import type { Playbook, PlaybookList } from './types';
import { useAct } from './use-act';

/** What the editor opens on: a playbook to change, or a new one from a template (null: blank). */
type Editing =
  { readonly playbook: Playbook } | { readonly template: PlaybookTemplateKey | null } | null;

export function OutreachHome({
  workspaceId,
  businessName,
  list,
  canManage,
}: {
  workspaceId: string;
  businessName: string;
  list: PlaybookList;
  /** Owners and admins write the playbooks. */
  canManage: boolean;
}) {
  const [choosing, setChoosing] = useState(false);
  const [editing, setEditing] = useState<Editing>(null);
  const inUse = list.playbooks.filter((p) => !p.archivedAt);
  const archived = list.playbooks.filter((p) => p.archivedAt);
  return (
    <div data-testid="outreach-home">
      <PageHeader
        title="Social Outreach"
        description={`${businessName} · finding and following up with people on Facebook`}
        actions={
          canManage ? (
            <Button onClick={() => setChoosing(true)} data-testid="playbook-new">
              New playbook
            </Button>
          ) : null
        }
      />
      <Card className="mb-6 p-5">
        <h2 className="text-[15px] font-semibold">The browser extension</h2>
        <p className="mt-1.5 text-[13.5px] text-text-2">
          HandsFreeOS Social works beside you on Facebook. Sign in to it with your HandsFreeOS
          email, pick {businessName}, and press <strong>Save to HFOS</strong> on a profile or a
          chat. The person goes in Contacts with Facebook as their source, and the chat is kept on
          their page. It’s a test build for now, loaded into Chrome by hand.
        </p>
      </Card>
      <h2 className="mb-3 text-lg font-semibold tracking-tight">Playbooks</h2>
      {inUse.length === 0 ? (
        <Card className="p-6 text-center text-[13.5px] text-text-2">
          No playbooks yet.{' '}
          {canManage
            ? 'Start one from the CRM-demo template, or a blank one.'
            : 'An owner or admin writes them.'}
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {inUse.map((p) => (
            <PlaybookCard
              key={p.id}
              playbook={p}
              workspaceId={workspaceId}
              canManage={canManage}
              onChange={() => setEditing({ playbook: p })}
            />
          ))}
        </div>
      )}
      {archived.length ? (
        <details className="mt-6">
          <summary className="cursor-pointer text-[13.5px] text-text-2">
            Archived ({archived.length})
          </summary>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            {archived.map((p) => (
              <PlaybookCard
                key={p.id}
                playbook={p}
                workspaceId={workspaceId}
                canManage={canManage}
                onChange={() => setEditing({ playbook: p })}
              />
            ))}
          </div>
        </details>
      ) : null}
      <TemplateDialog
        open={choosing}
        onClose={() => setChoosing(false)}
        onPick={(template) => {
          setChoosing(false);
          setEditing({ template });
        }}
      />
      <PlaybookDialog
        editing={editing}
        onClose={() => setEditing(null)}
        workspaceId={workspaceId}
      />
    </div>
  );
}

function PlaybookCard({
  playbook: p,
  workspaceId,
  canManage,
  onChange,
}: {
  playbook: Playbook;
  workspaceId: string;
  canManage: boolean;
  onChange: () => void;
}) {
  const { busy, act } = useAct();
  const d = p.details;
  const archive = (archived: boolean) =>
    act(
      'archive',
      async () =>
        unwrap(
          await apiBrowser().POST('/v1/commands/outreach.playbook.archive', {
            body: { workspaceId, playbookId: p.id, archived },
          }),
        ),
      archived ? `${p.name} is archived.` : `${p.name} is back.`,
    );
  return (
    <Card className="p-5" data-testid={`playbook-${p.name}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-[15px] font-semibold">{p.name}</h3>
          <p className="text-[12.5px] text-text-3">Changed {relativeTime(p.updatedAt)}</p>
        </div>
        <Badge variant="accent">{PLAYBOOK_GOALS[d.goal as PlaybookGoal]}</Badge>
      </div>
      {d.audience ? <p className="mt-2.5 text-[13.5px]">{d.audience}</p> : null}
      {d.steps.length ? (
        <p className="mt-2 text-[13px] text-text-2">
          {d.steps.map((s) => PLAYBOOK_STEPS[s as PlaybookStep].label).join(' → ')}
        </p>
      ) : null}
      {d.tags.length ? (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {d.tags.map((t) => (
            <Badge key={t}>{t}</Badge>
          ))}
        </div>
      ) : null}
      {canManage ? (
        <div className="mt-3 flex gap-3 text-[12.5px]">
          {p.archivedAt ? (
            <button
              type="button"
              className="text-accent-text hover:underline"
              disabled={busy !== null}
              onClick={() => void archive(false)}
            >
              Bring it back
            </button>
          ) : (
            <>
              <button
                type="button"
                className="text-accent-text hover:underline"
                onClick={onChange}
                data-testid="playbook-change"
              >
                Change
              </button>
              <button
                type="button"
                className="text-text-3 hover:text-danger-text hover:underline"
                disabled={busy !== null}
                onClick={() => void archive(true)}
              >
                Archive
              </button>
            </>
          )}
        </div>
      ) : null}
    </Card>
  );
}

/** Where a new playbook starts: one of the templates, or blank. */
function TemplateDialog({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (template: PlaybookTemplateKey | null) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title="New playbook"
        description="Start from a template and make it yours, or start blank."
        className="w-[min(520px,calc(100vw-32px))]"
      >
        <div className="mt-4 space-y-2">
          {PLAYBOOK_TEMPLATE_KEYS.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => onPick(key)}
              className="block w-full rounded-menu border border-border-strong p-3.5 text-left hover:bg-card-2"
              data-testid={`template-${key}`}
            >
              <div className="font-semibold">{PLAYBOOK_TEMPLATES[key].name}</div>
              <div className="text-[13px] text-text-2">{PLAYBOOK_TEMPLATES[key].summary}</div>
            </button>
          ))}
          <button
            type="button"
            onClick={() => onPick(null)}
            className="block w-full rounded-menu border border-dashed border-border-strong p-3.5 text-left hover:bg-card-2"
          >
            <div className="font-semibold">Blank</div>
            <div className="text-[13px] text-text-2">Write every part yourself.</div>
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PlaybookDialog({
  editing,
  onClose,
  workspaceId,
}: {
  editing: Editing;
  onClose: () => void;
  workspaceId: string;
}) {
  const playbook = editing && 'playbook' in editing ? editing.playbook : null;
  const template = editing && 'template' in editing ? editing.template : null;
  return (
    <Dialog open={editing !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={playbook ? `Change ${playbook.name}` : 'New playbook'}
        description="The extension and the AI follow it: who to look for, how to sound, and which of your tags to use."
        className="max-h-[92dvh] w-[min(640px,calc(100vw-32px))] overflow-y-auto"
      >
        {editing ? (
          <PlaybookForm
            key={playbook?.id ?? template ?? 'blank'}
            workspaceId={workspaceId}
            playbook={playbook}
            template={template}
            onClose={onClose}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** A list as the editor shows it: one per line. */
const asLines = (list: readonly string[]) => list.join('\n');
const fromLines = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

function PlaybookForm({
  workspaceId,
  playbook,
  template,
  onClose,
}: {
  workspaceId: string;
  playbook: Playbook | null;
  template: PlaybookTemplateKey | null;
  onClose: () => void;
}) {
  const start: PlaybookDetails = playbook
    ? (playbook.details as PlaybookDetails)
    : template
      ? PLAYBOOK_TEMPLATES[template].details
      : blankPlaybook();
  const [name, setName] = useState(
    playbook?.name ?? (template ? PLAYBOOK_TEMPLATES[template].name : ''),
  );
  const [goal, setGoal] = useState<PlaybookGoal>(start.goal);
  const [steps, setSteps] = useState<PlaybookStep[]>([...start.steps]);
  const [text, setText] = useState({
    offer: start.offer ?? '',
    link: start.link ?? '',
    audience: start.audience ?? '',
    area: start.area ?? '',
    tone: start.tone ?? '',
    disclaimer: start.disclaimer ?? '',
  });
  const [lists, setLists] = useState({
    signs: asLines(start.signs),
    skip: asLines(start.skip),
    groupWords: asLines(start.groupWords),
    samples: start.samples.join('\n\n'),
    questions: asLines(start.questions),
    avoid: asLines(start.avoid),
    tags: asLines(start.tags),
  });
  const { busy, errors, act } = useAct(onClose);
  const setT = (k: keyof typeof text) => (v: string) => setText({ ...text, [k]: v });
  const setL = (k: keyof typeof lists) => (v: string) => setLists({ ...lists, [k]: v });
  const orNull = (v: string) => v.trim() || null;

  return (
    <form
      className="mt-4 space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        const details: PlaybookDetails = {
          goal,
          offer: orNull(text.offer),
          link: orNull(text.link),
          audience: orNull(text.audience),
          signs: fromLines(lists.signs),
          skip: fromLines(lists.skip),
          area: orNull(text.area),
          platforms: ['facebook'],
          groupWords: fromLines(lists.groupWords),
          // In the order the playbook takes them.
          steps: PLAYBOOK_STEP_KEYS.filter((s) => steps.includes(s)),
          tone: orNull(text.tone),
          samples: lists.samples
            .split(/\n\s*\n/)
            .map((s) => s.trim())
            .filter(Boolean),
          questions: fromLines(lists.questions),
          avoid: fromLines(lists.avoid),
          disclaimer: orNull(text.disclaimer),
          tags: fromLines(lists.tags),
        };
        void act(
          'save',
          async () =>
            unwrap(
              await apiBrowser().POST('/v1/commands/outreach.playbook.save', {
                body: {
                  workspaceId,
                  ...(playbook ? { playbookId: playbook.id } : { template }),
                  name: name.trim(),
                  details,
                },
              }),
            ),
          playbook ? 'Saved.' : `${name.trim()} is ready.`,
        );
      }}
    >
      <Field label="Name" htmlFor="pb-name" error={errors.name}>
        <Input
          id="pb-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          data-testid="playbook-name"
        />
      </Field>

      <Part title="What it’s after">
        <Chips
          options={PLAYBOOK_GOAL_KEYS.map((k) => [k, PLAYBOOK_GOALS[k]] as const)}
          on={(k) => goal === k}
          onToggle={(k) => setGoal(k)}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="The offer"
            htmlFor="pb-offer"
            hint="In your words: “A 20-minute demo”."
            error={errors.offer}
          >
            <Input
              id="pb-offer"
              value={text.offer}
              onChange={(e) => setT('offer')(e.target.value)}
            />
          </Field>
          <Field
            label="Booking link"
            htmlFor="pb-link"
            hint="Where people book or buy."
            error={errors.link}
          >
            <Input
              id="pb-link"
              value={text.link}
              onChange={(e) => setT('link')(e.target.value)}
              placeholder="https://"
            />
          </Field>
        </div>
      </Part>

      <Part title="Who it’s for">
        <Field label="Who" htmlFor="pb-audience" hint="In plain words." error={errors.audience}>
          <Textarea
            id="pb-audience"
            rows={2}
            value={text.audience}
            onChange={(e) => setT('audience')(e.target.value)}
          />
        </Field>
        <Field
          label="Signs someone fits"
          htmlFor="pb-signs"
          hint="One per line."
          error={errors.signs}
        >
          <Textarea
            id="pb-signs"
            rows={3}
            value={lists.signs}
            onChange={(e) => setL('signs')(e.target.value)}
          />
        </Field>
        <Field
          label="Who to leave alone"
          htmlFor="pb-skip"
          hint="One per line."
          error={errors.skip}
        >
          <Textarea
            id="pb-skip"
            rows={3}
            value={lists.skip}
            onChange={(e) => setL('skip')(e.target.value)}
          />
        </Field>
        <Field
          label="Where they are (optional)"
          htmlFor="pb-area"
          hint="Towns or a region, when it matters."
          error={errors.area}
        >
          <Input id="pb-area" value={text.area} onChange={(e) => setT('area')(e.target.value)} />
        </Field>
      </Part>

      <Part title="Where to look and what to do">
        <Field
          label="Group search words"
          htmlFor="pb-groups"
          hint="What to search for when looking for groups. One per line."
          error={errors.groupWords}
        >
          <Textarea
            id="pb-groups"
            rows={2}
            value={lists.groupWords}
            onChange={(e) => setL('groupWords')(e.target.value)}
          />
        </Field>
        <div>
          <div className="mb-1.5 text-[13px] font-medium">Steps, in this order</div>
          <Chips
            options={PLAYBOOK_STEP_KEYS.map((k) => [k, PLAYBOOK_STEPS[k].label] as const)}
            on={(k) => steps.includes(k)}
            onToggle={(k) =>
              setSteps(steps.includes(k) ? steps.filter((s) => s !== k) : [...steps, k])
            }
          />
        </div>
      </Part>

      <Part title="How it sounds">
        <Field label="Tone" htmlFor="pb-tone" error={errors.tone}>
          <Textarea
            id="pb-tone"
            rows={2}
            value={text.tone}
            onChange={(e) => setT('tone')(e.target.value)}
          />
        </Field>
        <Field
          label="Your own messages"
          htmlFor="pb-samples"
          hint="A few you’ve sent, with a blank line between them, so drafts sound like you."
          error={errors.samples}
        >
          <Textarea
            id="pb-samples"
            rows={4}
            value={lists.samples}
            onChange={(e) => setL('samples')(e.target.value)}
          />
        </Field>
        <Field
          label="Questions to work in"
          htmlFor="pb-questions"
          hint="One per line."
          error={errors.questions}
        >
          <Textarea
            id="pb-questions"
            rows={3}
            value={lists.questions}
            onChange={(e) => setL('questions')(e.target.value)}
          />
        </Field>
        <Field label="Words to avoid" htmlFor="pb-avoid" hint="One per line." error={errors.avoid}>
          <Textarea
            id="pb-avoid"
            rows={2}
            value={lists.avoid}
            onChange={(e) => setL('avoid')(e.target.value)}
          />
        </Field>
        <Field
          label="Must say (optional)"
          htmlFor="pb-disclaimer"
          hint="Anything every message has to include."
          error={errors.disclaimer}
        >
          <Input
            id="pb-disclaimer"
            value={text.disclaimer}
            onChange={(e) => setT('disclaimer')(e.target.value)}
          />
        </Field>
      </Part>

      <Part title="Tags">
        <Field
          label="Your tags it may use"
          htmlFor="pb-tags"
          hint="One per line. People are only ever tagged with these."
          error={errors.tags}
        >
          <Textarea
            id="pb-tags"
            rows={4}
            value={lists.tags}
            onChange={(e) => setL('tags')(e.target.value)}
          />
        </Field>
      </Part>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" loading={busy === 'save'} data-testid="playbook-save">
          {playbook ? 'Save' : 'Make the playbook'}
        </Button>
      </div>
    </form>
  );
}

function Part({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="space-y-3">
      <legend className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-text-3">
        {title}
      </legend>
      {children}
    </fieldset>
  );
}

function Chips<K extends string>({
  options,
  on,
  onToggle,
}: {
  options: readonly (readonly [K, string])[];
  on: (key: K) => boolean;
  onToggle: (key: K) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map(([key, label]) => (
        <button
          key={key}
          type="button"
          aria-pressed={on(key)}
          onClick={() => onToggle(key)}
          className={cn(
            'h-8 rounded-full border px-3 text-[13px]',
            on(key)
              ? 'border-accent-soft bg-accent-soft text-accent-text'
              : 'border-border-strong text-text-2',
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
