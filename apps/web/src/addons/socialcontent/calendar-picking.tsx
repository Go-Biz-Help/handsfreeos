'use client';
/**
 * Picking many posts on the Calendar, and what a post that didn't post can do (docs/socialcontent.md, "Picking many
 * posts"; the owner, 15 Nov; the design they OK'd). The Pick menu adds posts by day, week, month, kind or any date;
 * the bar under the picked posts OKs, redoes (past ones go up again; waiting ones are written again by the AI, after
 * asking), checks, marks, hides or deletes them, each button on only those it can
 * act on, sent 500 at a time so any number can be picked. Delete asks first and offers Hide instead; Mark as posted
 * asks first, with an optional link for one. Which posts each button takes is core's (`summaryOf`), so the phone
 * decides alike.
 */
import { addDays, fmtDateShort, localDateOf } from '@hfos/core';
import { canLook, canRedo, type PostingNetwork } from '@hfos/core/addons/socialcontent/calendar';
import {
  inTurns,
  monthMoved,
  monthName,
  monthOf,
  picks,
  summaryOf,
  weekShownShort,
  weekStartOf,
  type CalendarLook,
  type PickWhich,
  type PickedLike,
} from '@hfos/core/addons/socialcontent/calendar-looks';
import { networkName } from '@hfos/core/addons/socialcontent/networks';
import {
  listShown,
  timeShown as timeIn,
  SOCIALCONTENT_WORDS as W,
} from '@hfos/core/addons/socialcontent/words';
import {
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Eye,
  EyeOff,
  RotateCcw,
  Search,
  Trash2,
} from 'lucide-react';
import { useCallback, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Label } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { workerPost } from '@/lib/api/worker';
import type { Content } from './types';
import { useAct } from './use-act';

/** A picked post: enough to say what the buttons do with it. */
export interface PickItem extends PickedLike {
  readonly title: string;
}

export const itemOf = (
  p: Pick<Content, 'id' | 'title' | 'state' | 'network' | 'hidden'>,
): PickItem => ({
  id: p.id,
  title: p.title,
  state: p.state,
  network: p.network,
  hidden: p.hidden,
});

/** The picked posts, kept across weeks and months as the person moves around. */
export function usePicked() {
  const [picked, setPicked] = useState<ReadonlyMap<string, PickItem>>(new Map());
  const pick = useCallback(
    (list: readonly PickItem[], on: boolean) =>
      setPicked((was) => {
        const next = new Map(was);
        for (const p of list) {
          if (on) next.set(p.id, p);
          else next.delete(p.id);
        }
        return next;
      }),
    [],
  );
  const clear = useCallback(() => setPicked(new Map()), []);
  return { picked, pick, clear };
}

const REWRITE_MANY = '/v1/addons/socialcontent/actions/socialcontent.content.rewrite_many';

const networksOf = (items: readonly PickedLike[]) =>
  listShown([...new Set(items.map((p) => networkName(p.network as PostingNetwork)))]);

/** Sends picked posts a turn at a time and adds up what each turn did. */
async function inTurnsSent(
  ids: readonly string[],
  send: (postIds: string[]) => Promise<{ done: number; left: number }>,
) {
  let done = 0;
  let left = 0;
  for (const part of inTurns(ids)) {
    const out = await send(part);
    done += out.done;
    left += out.left;
  }
  return { done, left };
}

/** The commands the bar and a post that didn't post send, a turn at a time. */
function useSends(workspaceId: string) {
  const api = apiBrowser();
  return {
    ok: (ids: readonly string[]) =>
      inTurnsSent(ids, (postIds) =>
        api
          .POST('/v1/commands/socialcontent.content.approve_many', {
            body: { workspaceId, postIds },
          })
          .then(unwrap)
          .then((o) => ({ done: o.approved, left: o.notApproved.length })),
      ),
    redo: (ids: readonly string[]) =>
      inTurnsSent(ids, (postIds) =>
        api
          .POST('/v1/commands/socialcontent.content.redo', { body: { workspaceId, postIds } })
          .then(unwrap)
          .then((o) => ({ done: o.redone, left: o.notRedone.length })),
      ),
    rewrite: (ids: readonly string[]) =>
      inTurnsSent(ids, (postIds) =>
        workerPost<{ asked: number; notAsked: unknown[] }>(REWRITE_MANY, {
          workspaceId,
          input: { postIds },
        }).then((o) => ({ done: o.asked, left: o.notAsked.length })),
      ),
    look: (ids: readonly string[]) =>
      inTurnsSent(ids, (postIds) =>
        api
          .POST('/v1/commands/socialcontent.content.look', { body: { workspaceId, postIds } })
          .then(unwrap)
          .then((o) => ({ done: o.asked, left: o.notAsked.length })),
      ),
    mark: (ids: readonly string[], link: string | null) =>
      inTurnsSent(ids, (postIds) =>
        api
          .POST('/v1/commands/socialcontent.content.mark_posted', {
            body: { workspaceId, postIds, link: ids.length === 1 ? link : null },
          })
          .then(unwrap)
          .then((o) => ({ done: o.marked, left: o.notMarked.length })),
      ),
    hide: (ids: readonly string[], hide: boolean) =>
      inTurnsSent(ids, (postIds) =>
        api
          .POST('/v1/commands/socialcontent.content.hide', {
            body: { workspaceId, postIds, hide },
          })
          .then(unwrap)
          .then((o) => ({ done: o.changed, left: o.notChanged.length })),
      ),
    remove: (ids: readonly string[]) =>
      inTurnsSent(ids, (postIds) =>
        api
          .POST('/v1/commands/socialcontent.content.remove_many', {
            body: { workspaceId, postIds },
          })
          .then(unwrap)
          .then((o) => ({ done: o.removed, left: o.notRemoved.length })),
      ),
  };
}

/** A button with how many picked posts it acts on. */
function CountButton({
  icon,
  label,
  n,
  busy,
  disabled,
  onClick,
  variant = 'secondary',
  testId,
  title,
}: {
  icon: ReactNode;
  label: string;
  n: number;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
  variant?: 'secondary' | 'danger-outline';
  testId: string;
  title?: string;
}) {
  return (
    <Button
      size="sm"
      variant="secondary"
      loading={busy}
      disabled={disabled || n === 0}
      onClick={onClick}
      title={title}
      className={variant === 'danger-outline' ? 'border-danger/50 text-danger-text' : undefined}
      data-testid={testId}
    >
      {icon}
      {label}
      <span className="rounded-full bg-card-2 px-1.5 text-[11.5px] tabular-nums text-text-2">
        {n.toLocaleString('en-US')}
      </span>
    </Button>
  );
}

/**
 * The bar under the picked posts: how many, what they are, and a button for each thing they can do with how many it
 * takes. After each, what's picked is cleared and the Calendar drawn again.
 */
export function PickBar({
  workspaceId,
  items,
  canRemove,
  onDone,
  onCancel,
}: {
  workspaceId: string;
  items: readonly PickItem[];
  canRemove: boolean;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { busy, act } = useAct();
  const send = useSends(workspaceId);
  const s = summaryOf(items);
  const [removing, setRemoving] = useState(false);
  const [marking, setMarking] = useState(false);
  const [redoing, setRedoing] = useState(false);
  const byId = new Map(items.map((p) => [p.id, p]));
  const of = (ids: readonly string[]) => ids.map((id) => byId.get(id)!).filter(Boolean);
  const redoPosted = of(s.redo).filter((p) => p.state === 'posted');
  const run = (
    key: string,
    go: () => Promise<{ done: number; left: number }>,
    words: (done: number, left: number) => string,
  ) =>
    act(key, go, (o) => words(o.done, o.left)).then((o) => {
      if (o) onDone();
      return o;
    });
  const other = (key: string) => busy !== null && busy !== key;
  // Redo: past posts go up again; waiting ones are written again by the AI (the owner, 15 Nov), after asking.
  const redo = () =>
    act(
      'redo',
      async () => ({
        past: s.redo.length ? await send.redo(s.redo) : null,
        rewrite: s.rewrite.length ? await send.rewrite(s.rewrite) : null,
      }),
      (o) =>
        [
          o.past ? W.calendar.redone(o.past.done, o.past.left) : null,
          o.rewrite ? W.picking.rewritten(o.rewrite.done, o.rewrite.left) : null,
        ]
          .filter(Boolean)
          .join(' '),
    ).then((o) => {
      if (o) {
        setRedoing(false);
        onDone();
      }
    });

  return (
    <Card
      className="sticky bottom-2 z-10 flex flex-wrap items-start gap-x-4 gap-y-3 border-accent p-4 shadow-2"
      data-testid="socialcontent-pick-bar"
    >
      <div className="min-w-[200px] flex-1">
        <p className="text-[14px] font-semibold text-text" data-testid="socialcontent-pick-count">
          {W.picking.picked(s.picked)}
        </p>
        <p className="mt-0.5 text-[12.5px] text-text-2">
          {s.picked ? W.picking.summary(s) : W.picking.menu.adds}
        </p>
        {redoPosted.length ? (
          <p
            className="mt-1 text-[12.5px] text-warning-text"
            data-testid="socialcontent-pick-redo-posted"
          >
            {W.calendar.redoPosted([
              ...new Set(redoPosted.map((p) => networkName(p.network as PostingNetwork))),
            ])}
          </p>
        ) : null}
      </div>
      <div
        role="group"
        aria-label={W.picking.actionsLabel}
        className="flex flex-wrap items-center justify-end gap-2"
      >
        <CountButton
          icon={<Check className="h-3.5 w-3.5" aria-hidden />}
          label={W.picking.ok}
          n={s.ok.length}
          busy={busy === 'ok'}
          disabled={other('ok')}
          onClick={() => void run('ok', () => send.ok(s.ok), W.picking.approved)}
          testId="socialcontent-pick-ok"
        />
        <CountButton
          icon={<RotateCcw className="h-3.5 w-3.5" aria-hidden />}
          label={W.picking.redo}
          n={s.redo.length + s.rewrite.length}
          busy={busy === 'redo'}
          disabled={other('redo')}
          title={W.picking.redoHint}
          onClick={() => (s.rewrite.length ? setRedoing(true) : void redo())}
          testId="socialcontent-pick-redo"
        />
        <CountButton
          icon={<Search className="h-3.5 w-3.5" aria-hidden />}
          label={W.picking.look}
          n={s.look.length}
          busy={busy === 'look'}
          disabled={other('look')}
          title={W.picking.lookHint}
          onClick={() => void run('look', () => send.look(s.look), W.picking.lookAsked)}
          testId="socialcontent-pick-look"
        />
        <CountButton
          icon={<CircleCheck className="h-3.5 w-3.5" aria-hidden />}
          label={W.picking.mark}
          n={s.look.length}
          busy={false}
          disabled={busy !== null}
          title={W.picking.markHint}
          onClick={() => setMarking(true)}
          testId="socialcontent-pick-mark"
        />
        {s.show.length ? (
          <CountButton
            icon={<Eye className="h-3.5 w-3.5" aria-hidden />}
            label={W.picking.show}
            n={s.show.length}
            busy={busy === 'show'}
            disabled={other('show')}
            onClick={() =>
              void run(
                'show',
                () => send.hide(s.show, false),
                (n) => W.picking.shown(n),
              )
            }
            testId="socialcontent-pick-show"
          />
        ) : null}
        {s.hide.length || !s.show.length ? (
          <CountButton
            icon={<EyeOff className="h-3.5 w-3.5" aria-hidden />}
            label={W.picking.hide}
            n={s.hide.length}
            busy={busy === 'hide'}
            disabled={other('hide')}
            onClick={() =>
              void run(
                'hide',
                () => send.hide(s.hide, true),
                (n) => W.picking.hidden(n),
              )
            }
            testId="socialcontent-pick-hide"
          />
        ) : null}
        {canRemove ? (
          <CountButton
            icon={<Trash2 className="h-3.5 w-3.5" aria-hidden />}
            label={W.picking.remove}
            n={s.remove.length}
            busy={busy === 'remove'}
            disabled={other('remove')}
            variant="danger-outline"
            onClick={() => setRemoving(true)}
            testId="socialcontent-pick-remove"
          />
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          disabled={busy !== null}
          onClick={onCancel}
          data-testid="socialcontent-pick-cancel"
        >
          {W.picking.cancel}
        </Button>
      </div>
      <DeletePostsDialog
        open={removing}
        items={of(s.remove)}
        busy={busy}
        onClose={() => setRemoving(false)}
        onHide={() =>
          void run(
            'hide',
            () =>
              send.hide(
                of(s.remove)
                  .filter((p) => !p.hidden)
                  .map((p) => p.id),
                true,
              ),
            (n) => W.picking.hidden(n),
          ).then((o) => o && setRemoving(false))
        }
        onDelete={() =>
          void run('remove', () => send.remove(s.remove), W.picking.removed).then(
            (o) => o && setRemoving(false),
          )
        }
      />
      <RedoPostsDialog
        open={redoing}
        rewrite={s.rewrite.length}
        past={s.redo.length}
        busy={busy}
        onClose={() => setRedoing(false)}
        onRedo={() => void redo()}
      />
      <MarkPostedDialog
        workspaceId={workspaceId}
        items={marking ? of(s.look) : null}
        onClose={() => setMarking(false)}
        onDone={onDone}
      />
    </Card>
  );
}

/**
 * Redo asks first when it writes posts again (the owner, 15 Nov): the AI writes the waiting ones over in new words, and
 * they wait for an OK again; past ones picked too go up again.
 */
function RedoPostsDialog({
  open,
  rewrite,
  past,
  busy,
  onClose,
  onRedo,
}: {
  open: boolean;
  rewrite: number;
  past: number;
  busy: string | null;
  onClose: () => void;
  onRedo: () => void;
}) {
  const n = rewrite + past;
  return (
    <Dialog open={open && rewrite > 0} onOpenChange={(o) => (o || busy ? null : onClose())}>
      {open && rewrite ? (
        <DialogContent title={W.picking.redoTitle(n)} description={W.picking.redoRewrite(rewrite)}>
          <div data-testid="socialcontent-pick-redo-dialog">
            {past ? (
              <p className="mt-3 text-[13px] text-text-2">{W.picking.redoPast(past)}</p>
            ) : null}
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <Button variant="ghost" disabled={busy !== null} onClick={onClose}>
                {W.picking.redoCancel}
              </Button>
              <Button
                loading={busy === 'redo'}
                disabled={busy !== null && busy !== 'redo'}
                onClick={onRedo}
                data-testid="socialcontent-pick-redo-go"
              >
                {W.picking.redoGo(n)}
              </Button>
            </div>
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

/** Delete asks first: what comes off, that posts already up stay up there, and Hide instead. */
function DeletePostsDialog({
  open,
  items,
  busy,
  onClose,
  onHide,
  onDelete,
}: {
  open: boolean;
  items: readonly PickItem[];
  busy: string | null;
  onClose: () => void;
  onHide: () => void;
  onDelete: () => void;
}) {
  const up = items.filter((p) => p.state === 'posted');
  const upcoming = items.filter((p) => p.state === 'draft' || p.state === 'ready').length;
  const hideable = items.filter((p) => !p.hidden).length;
  return (
    <Dialog open={open && items.length > 0} onOpenChange={(o) => (o || busy ? null : onClose())}>
      {open && items.length ? (
        <DialogContent
          title={W.picking.removeTitle(items.length)}
          description={W.picking.removeSays(upcoming)}
        >
          <div data-testid="socialcontent-pick-remove-dialog">
            {up.length ? (
              <p className="mt-3 flex gap-2 rounded-card bg-warning-soft p-3 text-[13px] text-warning-text">
                <CircleAlert className="mt-0.5 h-4 w-4 flex-none" aria-hidden />
                {W.picking.removeUp(up.length, networksOf(up))}
              </p>
            ) : null}
            {hideable ? (
              <p className="mt-3 text-[12.5px] text-text-3">{W.picking.removeHideInstead}</p>
            ) : null}
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <Button variant="ghost" disabled={busy !== null} onClick={onClose}>
                {W.picking.removeKeep}
              </Button>
              {hideable ? (
                <Button
                  variant="secondary"
                  loading={busy === 'hide'}
                  disabled={busy !== null && busy !== 'hide'}
                  onClick={onHide}
                  data-testid="socialcontent-pick-remove-hide"
                >
                  {W.picking.removeHide}
                </Button>
              ) : null}
              <Button
                variant="danger"
                loading={busy === 'remove'}
                disabled={busy !== null && busy !== 'remove'}
                onClick={onDelete}
                data-testid="socialcontent-pick-remove-go"
              >
                {W.picking.removeGo(items.length)}
              </Button>
            </div>
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

/**
 * Mark as posted asks first: do it when you can see it on the network. One post can carry its link, so its likes and
 * views are read; several skip the links. Check if it posted is beside it, for when the link isn't to hand.
 */
export function MarkPostedDialog({
  workspaceId,
  items,
  onClose,
  onDone,
}: {
  workspaceId: string;
  /** The posts to mark; null when it's closed. */
  items: readonly PickItem[] | null;
  onClose: () => void;
  onDone?: () => void;
}) {
  const { busy, act } = useAct();
  const send = useSends(workspaceId);
  const [link, setLink] = useState('');
  const list = items ?? [];
  const one = list.length === 1 ? list[0]! : null;
  const close = () => {
    setLink('');
    onClose();
  };
  const ids = list.map((p) => p.id);
  const done = (o: unknown) => {
    if (!o) return;
    close();
    onDone?.();
  };
  return (
    <Dialog open={list.length > 0} onOpenChange={(o) => (o || busy ? null : close())}>
      {list.length ? (
        <DialogContent
          title={W.picking.markTitle(one?.title ?? null, list.length)}
          description={W.picking.markSays(networksOf(list))}
        >
          <div data-testid="socialcontent-mark-dialog">
            {one ? (
              <div className="mt-4">
                <Label htmlFor="socialcontent-mark-link">
                  {W.picking.markLink}{' '}
                  <span className="font-normal text-text-3">{W.picking.markLinkOptional}</span>
                </Label>
                <Input
                  id="socialcontent-mark-link"
                  type="url"
                  inputMode="url"
                  value={link}
                  maxLength={500}
                  placeholder="https://…"
                  disabled={busy !== null}
                  onChange={(e) => setLink(e.target.value)}
                  data-testid="socialcontent-mark-link"
                />
              </div>
            ) : null}
            {one ? (
              <p className="mt-2 text-[12.5px] text-text-3">{W.picking.markLinkHint}</p>
            ) : (
              <p className="mt-3 text-[12.5px] text-text-3">{W.picking.markMany}</p>
            )}
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <Button variant="ghost" disabled={busy !== null} onClick={close}>
                {W.picking.markCancel}
              </Button>
              <Button
                variant="secondary"
                loading={busy === 'look'}
                disabled={busy !== null && busy !== 'look'}
                onClick={() =>
                  void act(
                    'look',
                    () => send.look(ids),
                    (o) => W.picking.lookAsked(o.done, o.left),
                  ).then(done)
                }
                data-testid="socialcontent-mark-look"
              >
                {W.picking.lookOne}
              </Button>
              <Button
                loading={busy === 'mark'}
                disabled={busy !== null && busy !== 'mark'}
                onClick={() =>
                  void act(
                    'mark',
                    () => send.mark(ids, link.trim() || null),
                    (o) => W.picking.marked(o.done, o.left),
                  ).then(done)
                }
                data-testid="socialcontent-mark-go"
              >
                {W.picking.markGo}
              </Button>
            </div>
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

/**
 * A post that didn't post (the owner, 15 Nov): Try again, Check if it posted (Chrome looks on the network and marks it
 * posted if it's there) or Mark as posted, with where the looking stands. It looks once on its own, 10 minutes after.
 */
export function DidntPost({
  workspaceId,
  post: p,
  timeZone,
  className,
}: {
  workspaceId: string;
  post: Content;
  timeZone: string;
  className?: string;
}) {
  const { busy, act } = useAct();
  const send = useSends(workspaceId);
  const [marking, setMarking] = useState(false);
  if (p.state !== 'failed' || p.hidden) return null;
  const network = networkName(p.network as PostingNetwork);
  const lookAt = p.lookAt ? Date.parse(p.lookAt) : null;
  // Asked for, or due: the computer that posts is looking now (or as soon as Chrome opens).
  const looking = lookAt !== null && lookAt <= Date.now() + 60_000;
  const line = looking
    ? { text: W.picking.looking(network), tone: 'text-text-2' }
    : p.lookFailure
      ? { text: W.picking.lookCouldnt(p.lookFailure), tone: 'text-danger-text' }
      : p.lookedAt
        ? { text: W.picking.notFound(network, timeIn(p.lookedAt, timeZone)), tone: 'text-text-2' }
        : lookAt !== null
          ? {
              text: W.picking.lookSoon(timeIn(new Date(lookAt).toISOString(), timeZone)),
              tone: 'text-text-3',
            }
          : null;
  const tryAgain = () =>
    act(
      'again',
      () =>
        apiBrowser()
          .POST('/v1/commands/socialcontent.content.post_now', {
            body: { workspaceId, postId: p.id },
          })
          .then(unwrap),
      W.post.postNowAsked,
    );
  const other = (key: string) => busy !== null && busy !== key;
  return (
    <div className={className} data-testid={`socialcontent-post-${p.id}-didnt`}>
      {line ? (
        <p
          className={`text-[12.5px] ${line.tone}`}
          data-testid={`socialcontent-post-${p.id}-look-line`}
        >
          {line.text}
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {canRedo(p) && !looking ? (
          <Button
            size="sm"
            variant="secondary"
            loading={busy === 'again'}
            disabled={other('again')}
            onClick={() => void tryAgain()}
            data-testid={`socialcontent-post-${p.id}-again`}
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden />
            {W.picking.tryAgain}
          </Button>
        ) : null}
        {canLook(p) && !looking ? (
          <Button
            size="sm"
            variant="secondary"
            loading={busy === 'look'}
            disabled={other('look')}
            onClick={() =>
              void act(
                'look',
                () => send.look([p.id]),
                (o) => W.picking.lookAsked(o.done, o.left),
              )
            }
            data-testid={`socialcontent-post-${p.id}-look`}
          >
            <Search className="h-3.5 w-3.5" aria-hidden />
            {p.lookedAt ? W.picking.lookAgain : W.picking.lookOne}
          </Button>
        ) : null}
        {canLook(p) ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy !== null}
            onClick={() => setMarking(true)}
            data-testid={`socialcontent-post-${p.id}-mark`}
          >
            <CircleCheck className="h-3.5 w-3.5" aria-hidden />
            {p.lookedAt ? W.picking.markAnyway : W.picking.markOne}
          </Button>
        ) : null}
      </div>
      <MarkPostedDialog
        workspaceId={workspaceId}
        items={marking ? [itemOf(p)] : null}
        onClose={() => setMarking(false)}
      />
    </div>
  );
}

/** How many a pick in the menu adds, when it's known. */
function Count({ n }: { n: number | null }) {
  return n === null ? null : (
    <span className="ml-auto pl-4 text-[12.5px] tabular-nums text-text-3">
      {n.toLocaleString('en-US')}
    </span>
  );
}

/** A post on the page, as the Pick menu reads it: its day in the business's time zone. */
export interface Placed extends PickItem {
  readonly day: string | null;
}

export const placedOf = (p: Content, timeZone: string): Placed => ({
  ...itemOf(p),
  day: p.postAt ? localDateOf(Date.parse(p.postAt), timeZone) : null,
});

/** How many days a month has, from its first. */
const monthDays = (month: string) => {
  const next = monthMoved(month, 1);
  let n = 28;
  while (addDays(month, n) < next) n++;
  return n;
};

/**
 * The Pick menu: quick picks (today, this week or this month), every kind in the days shown, and every kind across
 * any date. Each pick adds to what's already picked. Picks inside the days on the page are made from what's shown
 * (with how many); the rest ask for them.
 */
export function PickMenu({
  workspaceId,
  look,
  today,
  from,
  days,
  month,
  rangeLabel,
  inRange,
  onPick,
  onClear,
  anyPicked,
}: {
  workspaceId: string;
  look: CalendarLook;
  today: string;
  /** The days the page holds. */
  from: string;
  days: number;
  /** The month shown, on Month. */
  month: string;
  rangeLabel: string;
  /** The posts in the days shown (every kind, hidden ones too). */
  inRange: readonly Placed[];
  onPick: (items: readonly PickItem[]) => void;
  onClear: () => void;
  anyPicked: boolean;
}) {
  const [finding, setFinding] = useState(false);
  const end = addDays(from, days);
  const held = (a: string, n: number) => a >= from && addDays(a, n) <= end;
  const local = (a: string, n: number, which: PickWhich = 'all') =>
    inRange.filter((p) => p.day !== null && p.day >= a && p.day < addDays(a, n) && picks(p, which));
  const ask = async (which: PickWhich, range?: { from: string; days: number }) => {
    setFinding(true);
    try {
      const out = await apiBrowser()
        .POST('/v1/queries/socialcontent.content.pick', {
          body: { workspaceId, which, ...range },
        })
        .then(unwrap);
      onPick(out.posts.map(itemOf));
      if (out.more) toast.info(W.picking.menu.more(out.posts.length));
      else if (!out.posts.length) toast.info(W.picking.nothingShown);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setFinding(false);
    }
  };
  /** A pick of some days: from the page when it holds them, else asked for. */
  const span = (a: string, n: number) =>
    held(a, n)
      ? { count: local(a, n).length, go: () => onPick(local(a, n)) }
      : { count: null, go: () => void ask('all', { from: a, days: n }) };
  const week = weekStartOf(today);
  const thisMonth = monthOf(today);
  const quick = [
    { key: 'today', label: W.picking.menu.today(fmtDateShort(today)), ...span(today, 1) },
    look === 'week'
      ? {
          key: 'month',
          label: W.picking.menu.thisMonth(monthName(thisMonth)),
          ...span(thisMonth, monthDays(thisMonth)),
        }
      : { key: 'week', label: W.picking.menu.thisWeek(weekShownShort(week)), ...span(week, 7) },
  ];
  const kinds: readonly { which: PickWhich; label: string }[] = [
    { which: 'all', label: W.picking.menu.everythingIn(rangeLabel) },
    { which: 'waiting', label: W.picking.menu.waiting },
    { which: 'okd', label: W.picking.menu.okd },
    { which: 'past', label: W.picking.menu.past },
    { which: 'failed', label: W.picking.menu.failed },
    { which: 'hidden', label: W.picking.menu.hidden },
  ];
  const anyDate: readonly { which: PickWhich; label: string }[] = [
    { which: 'all', label: W.picking.menu.everything },
    { which: 'waiting', label: W.picking.menu.allWaiting },
    { which: 'past', label: W.picking.menu.allPast },
    { which: 'failed', label: W.picking.menu.allFailed },
    { which: 'hidden', label: W.picking.menu.allHidden },
  ];
  const ofKind = (which: PickWhich) =>
    inRange.filter(
      (p) => (look === 'month' ? p.day?.startsWith(month.slice(0, 7)) : true) && picks(p, which),
    );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="secondary"
          loading={finding}
          data-testid="socialcontent-pick-menu"
        >
          {finding ? W.picking.menu.finding : W.picking.pick}
          <ChevronDown className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="bottom"
        avoidCollisions={false}
        collisionPadding={12}
        className="max-h-[var(--radix-dropdown-menu-content-available-height)] w-[290px] overflow-y-auto"
      >
        <DropdownMenuLabel>{W.picking.menu.quick}</DropdownMenuLabel>
        {quick.map((q) => (
          <DropdownMenuItem key={q.key} onSelect={q.go} data-testid={`socialcontent-pick-${q.key}`}>
            {q.label}
            <Count n={q.count} />
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{W.picking.menu.inRange(rangeLabel)}</DropdownMenuLabel>
        {kinds.map((k) => (
          <DropdownMenuItem
            key={k.which}
            onSelect={() => onPick(ofKind(k.which))}
            data-testid={`socialcontent-pick-shown-${k.which}`}
          >
            {k.label}
            <Count n={ofKind(k.which).length} />
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{W.picking.menu.anyDate}</DropdownMenuLabel>
        {anyDate.map((k) => (
          <DropdownMenuItem
            key={k.which}
            onSelect={() => void ask(k.which)}
            data-testid={`socialcontent-pick-any-${k.which}`}
          >
            {k.label}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        {anyPicked ? (
          <DropdownMenuItem
            onSelect={onClear}
            className="text-text-2"
            data-testid="socialcontent-pick-clear"
          >
            {W.picking.menu.clear}
          </DropdownMenuItem>
        ) : null}
        <p className="px-2.5 pb-1 pt-1.5 text-[12px] text-text-3">{W.picking.menu.adds}</p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
