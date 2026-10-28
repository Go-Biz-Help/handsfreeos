'use client';
/**
 * Social Outreach's playbooks tab (docs/outreach.md): what the business is after on social media, who it's for, the
 * steps it takes, the conversation, how it sounds and which of its tags to use. Everyone using the add-on reads them;
 * owners and admins write them in the builder (playbook-builder.tsx), from a template or blank, and archive them
 * rather than delete them. Under them, how each playbook's openers did: the first messages sent with each, who wrote
 * back and who booked a demo (`outreach.openers`), everyone's for owners and admins.
 */
import {
  PLAYBOOK_GOALS,
  PLAYBOOK_STEPS,
  PLAYBOOK_TEMPLATE_KEYS,
  PLAYBOOK_TEMPLATES,
  type PlaybookGoal,
  type PlaybookStep,
} from '@hfos/core/addons/outreach/playbooks';
import {
  OPENER_KINDS,
  openerShort,
  rateWords,
  type OpenerResult,
} from '@hfos/core/addons/outreach/openers';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import Link from 'next/link';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { relativeTime } from '@/lib/utils';
import type { Openers, Playbook, PlaybookList } from './types';
import { useAct } from './use-act';

export function PlaybooksView({
  workspaceId,
  list,
  openers,
  canManage,
}: {
  workspaceId: string;
  list: PlaybookList;
  /** How each playbook's openers did. */
  openers: Openers;
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
            {W.newPlaybook}
          </Button>
        ) : null}
      </div>
      {inUse.length === 0 ? (
        <Card className="p-6 text-center text-[13.5px] text-text-2">
          {W.playbooksEmpty}{' '}
          {canManage ? 'Start one from a ready-made playbook, or a blank one.' : W.readOnly}
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {inUse.map((p) => (
            <PlaybookCard key={p.id} playbook={p} workspaceId={workspaceId} canManage={canManage} />
          ))}
        </div>
      )}
      <OpenerResults openers={openers} />
      {archived.length ? (
        <details className="mt-6">
          <summary className="cursor-pointer text-[13.5px] text-text-2">
            {W.archived} ({archived.length})
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
      archived ? W.archivedDone : W.backDone,
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
              {W.bringBack}
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
                {W.archive}
              </button>
            </>
          )}
        </div>
      ) : null}
    </Card>
  );
}

/** A sent count needs to be this big before one opener's reply rate is called the best. */
const FAIR_TRY = 5;

/** Which openers work: for each playbook, its openers with what came of the first messages sent with them. */
function OpenerResults({ openers }: { openers: Openers }) {
  const shown = openers.playbooks.filter((p) => p.openers.length);
  if (!shown.length) return null;
  return (
    <Card className="mt-6 p-5" data-testid="opener-results">
      <h3 className="text-[15px] font-semibold">Which openers work</h3>
      <p className="mt-0.5 text-[13px] text-text-2">
        {openers.everyone ? 'Everyone’s first messages' : 'Your first messages'} from Today’s
        drafts, by how they opened. Drafts take turns with each.
      </p>
      <div className="mt-4 space-y-5">
        {shown.map((p) => {
          const best = bestOf(p.openers);
          return (
            <section key={p.playbookId}>
              <h4 className="text-[12.5px] font-semibold uppercase tracking-wide text-text-3">
                {p.name}
              </h4>
              <ul className="mt-1.5 divide-y divide-border">
                {p.openers.map((o) => (
                  <OpenerRow key={`${o.kind}:${o.text}`} opener={o} best={o === best} />
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </Card>
  );
}

/** The opener with the most replies for what was sent, once each has had a fair try; null before then. */
function bestOf(list: readonly OpenerResult[]): OpenerResult | null {
  const tried = list.filter((o) => o.current && o.sent >= FAIR_TRY);
  if (tried.length < 2) return null;
  const rate = (o: OpenerResult) => o.replies / o.sent;
  const best = tried.reduce((a, b) => (rate(b) > rate(a) ? b : a));
  return rate(best) > 0 ? best : null;
}

function OpenerRow({ opener: o, best }: { opener: OpenerResult; best: boolean }) {
  return (
    <li className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px]">{openerShort(o.text)}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[12px] text-text-3">
          <span>{OPENER_KINDS[o.kind]}</span>
          {o.current ? null : <span>· Not in the playbook now</span>}
          {best ? <Badge variant="accent">Works best so far</Badge> : null}
        </div>
      </div>
      <div className="text-right text-[12.5px] text-text-2">
        <div>{o.sent ? rateWords(o.replies, o.sent, 'wrote back') : 'None sent yet'}</div>
        {o.sent ? (
          <div className="text-text-3">
            {o.demos === 1 ? '1 demo booked' : `${o.demos.toLocaleString()} demos booked`}
          </div>
        ) : null}
      </div>
    </li>
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
        title={W.newPlaybook}
        description="Start from a ready-made playbook and make it yours, or start blank. It asks you a step at a time."
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
