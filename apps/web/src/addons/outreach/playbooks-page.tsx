'use client';
/**
 * Social Outreach's playbooks tab (docs/outreach.md): what the business is after on social media, who it's for, the
 * steps it takes, the conversation, how it sounds and which of its tags to use. Everyone using the add-on reads them;
 * owners and admins write them in the builder (playbook-builder.tsx), from a template or blank, and archive them
 * rather than delete them.
 */
import {
  PLAYBOOK_GOALS,
  PLAYBOOK_STEPS,
  PLAYBOOK_TEMPLATE_KEYS,
  PLAYBOOK_TEMPLATES,
  type PlaybookGoal,
  type PlaybookStep,
} from '@hfos/core/addons/outreach/playbooks';
import Link from 'next/link';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { relativeTime } from '@/lib/utils';
import type { Playbook, PlaybookList } from './types';
import { useAct } from './use-act';

export function PlaybooksView({
  workspaceId,
  list,
  canManage,
}: {
  workspaceId: string;
  list: PlaybookList;
  /** Owners and admins write the playbooks. */
  canManage: boolean;
}) {
  const [choosing, setChoosing] = useState(false);
  const inUse = list.playbooks.filter((p) => !p.archivedAt);
  const archived = list.playbooks.filter((p) => p.archivedAt);
  return (
    <div data-testid="outreach-playbooks">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold tracking-tight">Playbooks</h2>
        {canManage ? (
          <Button onClick={() => setChoosing(true)} data-testid="playbook-new">
            New playbook
          </Button>
        ) : null}
      </div>
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
            <PlaybookCard key={p.id} playbook={p} workspaceId={workspaceId} canManage={canManage} />
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
              />
            ))}
          </div>
        </details>
      ) : null}
      <TemplateDialog
        open={choosing}
        onClose={() => setChoosing(false)}
        workspaceId={workspaceId}
      />
    </div>
  );
}

function PlaybookCard({
  playbook: p,
  workspaceId,
  canManage,
}: {
  playbook: Playbook;
  workspaceId: string;
  canManage: boolean;
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
      {d.questions.length ? (
        <p className="mt-1 text-[13px] text-text-2" data-testid="playbook-questions">
          {d.questions.length === 1
            ? `Asks “${d.questions[0]!.text}”`
            : `Asks ${d.questions.length} questions, starting with “${d.questions[0]!.text}”`}
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
              <Link
                href={`/app/w/${workspaceId}/a/outreach/playbooks/${p.id}`}
                className="text-accent-text hover:underline"
                data-testid="playbook-change"
              >
                Change
              </Link>
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

/** Where a new playbook starts: one of the templates, or blank. Either opens the builder. */
function TemplateDialog({
  open,
  onClose,
  workspaceId,
}: {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
}) {
  const builder = `/app/w/${workspaceId}/a/outreach/playbooks/new`;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title="New playbook"
        description="Start from a template and make it yours, or start blank. It asks you a step at a time."
        className="w-[min(520px,calc(100vw-32px))]"
      >
        <div className="mt-4 space-y-2">
          {PLAYBOOK_TEMPLATE_KEYS.map((key) => (
            <Link
              key={key}
              href={`${builder}?template=${key}`}
              onClick={onClose}
              className="block w-full rounded-menu border border-border-strong p-3.5 text-left hover:bg-card-2"
              data-testid={`template-${key}`}
            >
              <div className="font-semibold">{PLAYBOOK_TEMPLATES[key].name}</div>
              <div className="text-[13px] text-text-2">{PLAYBOOK_TEMPLATES[key].summary}</div>
            </Link>
          ))}
          <Link
            href={builder}
            onClick={onClose}
            className="block w-full rounded-menu border border-dashed border-border-strong p-3.5 text-left hover:bg-card-2"
            data-testid="template-blank"
          >
            <div className="font-semibold">Blank</div>
            <div className="text-[13px] text-text-2">Answer a few questions in your own words.</div>
          </Link>
        </div>
      </DialogContent>
    </Dialog>
  );
}
