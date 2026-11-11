'use client';
import {
  cleanListLines,
  firstPicked,
  leftAfterAdding,
  listsFilled,
  listsOf,
  MAIN_OFFER_LISTS_WORDS as W,
  OFFER_LIST_INFO,
  OFFER_LIST_LIMITS,
  OFFER_LISTS,
  type MainOfferLists,
  type OfferList,
  type OfferListGap,
  roomIn,
  togglePicked,
} from '@hfos/core';
import { ChevronDown, ListChecks, Pencil, Sparkles, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { errorMessage } from '@/lib/api/errors';
import { assistOfferLists, offerAiError, saveOfferList } from '@/lib/main-offer/actions';
import { cn } from '@/lib/utils';

/** What the AI gave for the open list, to tick several of and add together: its own lines, or examples to model. */
type Help = { kind: 'write' | 'examples'; options: string[]; picked: string[] };

/**
 * The lists for content on Settings → Main offer (docs/main-offer.md, "For your content"): what makes the business
 * different, its features and benefits, and the rest the AI Social Media Content Creator writes its posts and ideas
 * from. Each list opens to its lines, with the AI's help: Write it for me, Improve a line, Examples, and What's missing
 * across them all. Every change saves at once; they aren't scored and never hold the offer back. Owners and admins
 * change them; everyone sees them.
 */
export function ContentLists({
  workspaceId,
  lists: saved,
  canManage,
}: {
  workspaceId: string;
  lists: Record<string, string[]>;
  canManage: boolean;
}) {
  const router = useRouter();
  const [lists, setLists] = useState<MainOfferLists>(() => listsOf(saved));
  const [open, setOpen] = useState<OfferList | null>(null);
  const [gaps, setGaps] = useState<OfferListGap[] | null>(null);
  const [checking, setChecking] = useState(false);

  /** Saves one list whole; one that can't be saved goes back, saying why. */
  async function save(list: OfferList, next: string[]): Promise<boolean> {
    const before = lists;
    const lines = cleanListLines(next);
    setLists({ ...lists, [list]: lines });
    try {
      const out = await saveOfferList(workspaceId, list, lines);
      setLists((now) => ({ ...now, [list]: out.lines }));
      toast.success(W.saved);
      router.refresh();
      return true;
    } catch (e) {
      setLists(before);
      toast.error(errorMessage(e));
      return false;
    }
  }

  async function checkGaps() {
    setChecking(true);
    try {
      const out = await assistOfferLists(workspaceId, { mode: 'gaps' });
      setGaps(out.gaps);
    } catch (e) {
      toast.error(offerAiError(e));
    } finally {
      setChecking(false);
    }
  }

  return (
    <Card className="flex flex-col gap-3 p-4" data-testid="main-offer-lists">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex max-w-[620px] flex-col gap-1">
          <span className="flex items-center gap-2 font-semibold">
            <ListChecks className="h-4 w-4 text-accent-text" strokeWidth={1.75} />
            {W.title}
          </span>
          <p className="text-[13px] text-text-2">{W.hint}</p>
          <p className="text-xs text-text-3" data-testid="main-offer-lists-filled">
            {W.filled(listsFilled(lists), OFFER_LISTS.length)}
          </p>
        </div>
        {canManage ? (
          <Button
            variant="secondary"
            size="sm"
            loading={checking}
            onClick={() => void checkGaps()}
            data-testid="main-offer-lists-gaps"
          >
            <Sparkles className="h-3.5 w-3.5" strokeWidth={1.75} />
            {checking ? W.gapsChecking : W.gaps}
          </Button>
        ) : null}
      </div>

      {gaps ? (
        <div
          className="flex flex-col gap-1.5 rounded-control border border-border bg-card-2 p-3"
          data-testid="main-offer-lists-gaps-found"
        >
          {gaps.length ? (
            gaps.map((g) => (
              <button
                key={g.list}
                type="button"
                onClick={() => setOpen(g.list)}
                className="flex flex-col items-start gap-0.5 rounded-control px-2 py-1.5 text-left hover:bg-card"
              >
                <span className="text-[13px] font-medium">{OFFER_LIST_INFO[g.list].label}</span>
                <span className="text-[13px] text-text-2">{g.note}</span>
              </button>
            ))
          ) : (
            <p className="text-[13px] text-text-2">{W.gapsNone}</p>
          )}
          <button
            type="button"
            onClick={() => setGaps(null)}
            className="self-end text-xs text-text-3 hover:text-text"
          >
            {W.dismiss}
          </button>
        </div>
      ) : null}

      <ul className="flex flex-col divide-y divide-border rounded-control border border-border">
        {OFFER_LISTS.map((list) => (
          <li key={list}>
            <ListRow
              workspaceId={workspaceId}
              list={list}
              lines={lists[list] ?? []}
              open={open === list}
              onOpen={() => setOpen(open === list ? null : list)}
              canManage={canManage}
              save={(next) => save(list, next)}
            />
          </li>
        ))}
      </ul>
    </Card>
  );
}

function ListRow({
  workspaceId,
  list,
  lines,
  open,
  onOpen,
  canManage,
  save,
}: {
  workspaceId: string;
  list: OfferList;
  lines: string[];
  open: boolean;
  onOpen: () => void;
  canManage: boolean;
  save: (next: string[]) => Promise<boolean>;
}) {
  const info = OFFER_LIST_INFO[list];
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState<'write' | 'examples' | 'save' | null>(null);
  const [help, setHelp] = useState<Help | null>(null);
  const full = lines.length >= OFFER_LIST_LIMITS.lines;
  const room = roomIn(lines);

  async function ask(kind: 'write' | 'examples') {
    setBusy(kind);
    try {
      const { options } = await assistOfferLists(workspaceId, { mode: kind, list });
      if (!options.length) {
        toast.message(W.nothingNew);
        setHelp(null);
      } else setHelp({ kind, options, picked: firstPicked(kind, options, lines) });
    } catch (e) {
      toast.error(offerAiError(e));
    } finally {
      setBusy(null);
    }
  }

  async function add() {
    setBusy('save');
    if (await save([...lines, typed])) setTyped('');
    setBusy(null);
  }

  /** Adds the ticked lines together; the rest stay on show, to add too, while the list has room. */
  async function addPicked(open: Help) {
    setBusy('save');
    if (await save([...lines, ...open.picked])) {
      const left = leftAfterAdding(open.options, open.picked);
      setHelp(
        left.length && open.picked.length < room ? { ...open, options: left, picked: [] } : null,
      );
    }
    setBusy(null);
  }

  return (
    <div data-testid={`main-offer-list-${list}`}>
      <button
        type="button"
        onClick={onOpen}
        aria-expanded={open}
        aria-label={W.open(info.label)}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-card-2"
        data-testid={`main-offer-list-${list}-open`}
      >
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{info.label}</span>
          <span className="block truncate text-xs text-text-3">
            {lines.length ? lines[0] : W.empty}
          </span>
        </span>
        <span className="flex-none text-xs text-text-3">
          {lines.length ? W.lines(lines.length) : null}
        </span>
        <ChevronDown
          className={cn('h-4 w-4 flex-none text-text-3 transition-transform', open && 'rotate-180')}
          strokeWidth={1.75}
        />
      </button>

      {open ? (
        <div className="flex flex-col gap-3 px-3 pb-3.5 pt-1">
          <p className="text-[13px] text-text-2">{info.hint}</p>

          {lines.length ? (
            <ul className="flex flex-col gap-1.5" aria-label={info.label}>
              {lines.map((l, i) => (
                <LineItem
                  key={`${i}-${l}`}
                  workspaceId={workspaceId}
                  list={list}
                  line={l}
                  canManage={canManage}
                  onChange={(next) =>
                    save(
                      next === null
                        ? lines.filter((_, j) => j !== i)
                        : lines.map((x, j) => (j === i ? next : x)),
                    )
                  }
                />
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-text-3">{W.empty}</p>
          )}

          {help ? (
            <div
              className="flex flex-col gap-2 rounded-control border border-border bg-card-2 p-3"
              data-testid={`main-offer-list-${list}-${help.kind === 'write' ? 'suggestions' : 'examples'}`}
            >
              <p className="text-[13px] text-text-2">
                {help.kind === 'write' ? W.suggestions : W.examplesHint}
              </p>
              {help.options.map((o, i) => {
                const on = help.picked.includes(o);
                const shut = !canManage || (!on && help.picked.length >= room);
                return (
                  <Checkbox
                    key={o}
                    label={o}
                    checked={on}
                    disabled={shut}
                    onChange={() =>
                      setHelp({ ...help, picked: togglePicked(help.picked, o, lines) })
                    }
                    className={cn('items-start text-[13px]', shut && 'cursor-default opacity-50')}
                    data-testid={`main-offer-list-${list}-${help.kind === 'write' ? 'suggestion' : 'example'}-${i}`}
                  />
                );
              })}
              {help.options.length > room ? (
                <p className="text-xs text-text-3">{W.room(room)}</p>
              ) : null}
              <div className="flex gap-2">
                {canManage ? (
                  <Button
                    size="sm"
                    loading={busy === 'save'}
                    disabled={!help.picked.length}
                    onClick={() => void addPicked(help)}
                    data-testid={`main-offer-list-${list}-keep`}
                  >
                    {W.addPicked(help.picked.length)}
                  </Button>
                ) : null}
                <Button size="sm" variant="ghost" onClick={() => setHelp(null)}>
                  {W.dismiss}
                </Button>
              </div>
            </div>
          ) : null}

          {canManage ? (
            <>
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (typed.trim() && !full) void add();
                }}
              >
                <Input
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  maxLength={OFFER_LIST_LIMITS.line}
                  placeholder={W.addPlaceholder(info.example)}
                  aria-label={W.addLabel(info.label)}
                  disabled={full}
                  className="min-w-0 flex-1"
                  data-testid={`main-offer-list-${list}-input`}
                />
                <Button
                  type="submit"
                  variant="secondary"
                  loading={busy === 'save' && !help}
                  disabled={!typed.trim() || full}
                  data-testid={`main-offer-list-${list}-add`}
                >
                  {W.add}
                </Button>
              </form>
              {full ? (
                <p className="text-xs text-text-3">{W.full(OFFER_LIST_LIMITS.lines)}</p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  loading={busy === 'write'}
                  disabled={full || busy !== null}
                  onClick={() => void ask('write')}
                  data-testid={`main-offer-list-${list}-write`}
                >
                  <Sparkles className="h-3.5 w-3.5" strokeWidth={1.75} />
                  {busy === 'write' ? W.writing : W.writeForMe}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  loading={busy === 'examples'}
                  disabled={busy !== null}
                  onClick={() => void ask('examples')}
                  data-testid={`main-offer-list-${list}-examples-ask`}
                >
                  {W.examples}
                </Button>
              </div>
            </>
          ) : (
            <p className="text-xs text-text-3">{W.managersOnly}</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** One line: change it, have the AI rewrite it three ways (Improve), or remove it. */
function LineItem({
  workspaceId,
  list,
  line,
  canManage,
  onChange,
}: {
  workspaceId: string;
  list: OfferList;
  line: string;
  canManage: boolean;
  /** The line's new words, or null to remove it. */
  onChange: (next: string | null) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [rewrites, setRewrites] = useState<string[] | null>(null);
  const [busy, setBusy] = useState<'improve' | 'save' | null>(null);

  async function improve() {
    setBusy('improve');
    try {
      const { options } = await assistOfferLists(workspaceId, { mode: 'improve', list, line });
      if (options.length) setRewrites(options);
      else toast.message(W.nothingNew);
    } catch (e) {
      toast.error(offerAiError(e));
    } finally {
      setBusy(null);
    }
  }

  async function change(next: string | null) {
    setBusy('save');
    const ok = await onChange(next);
    setBusy(null);
    if (ok) {
      setEditing(null);
      setRewrites(null);
    }
  }

  if (editing !== null)
    return (
      <li>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (editing.trim()) void change(editing);
          }}
        >
          <Input
            value={editing}
            onChange={(e) => setEditing(e.target.value)}
            maxLength={OFFER_LIST_LIMITS.line}
            aria-label={W.edit}
            autoFocus
            className="min-w-0 flex-1"
          />
          <Button type="submit" size="sm" loading={busy === 'save'} disabled={!editing.trim()}>
            {W.save}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>
            {W.cancel}
          </Button>
        </form>
      </li>
    );

  return (
    <li className="flex flex-col gap-1.5 rounded-control border border-border bg-card px-3 py-2">
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 text-[13px] leading-[1.45]">{line}</span>
        {canManage ? (
          <span className="flex flex-none items-center gap-0.5">
            <Button
              size="sm"
              variant="ghost"
              loading={busy === 'improve'}
              disabled={busy !== null}
              onClick={() => void improve()}
              className="h-7 px-2 text-xs"
              data-testid="main-offer-list-line-improve"
            >
              {busy === 'improve' ? W.improving : W.improve}
            </Button>
            <button
              type="button"
              aria-label={W.edit}
              onClick={() => setEditing(line)}
              className="flex h-7 w-7 items-center justify-center rounded-full text-text-3 hover:bg-card-2 hover:text-text"
            >
              <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} />
            </button>
            <button
              type="button"
              aria-label={W.remove}
              disabled={busy !== null}
              onClick={() => void change(null)}
              className="flex h-7 w-7 items-center justify-center rounded-full text-text-3 hover:bg-card-2 hover:text-text"
            >
              <X className="h-3.5 w-3.5" strokeWidth={2} />
            </button>
          </span>
        ) : null}
      </div>
      {rewrites ? (
        <div
          className="flex flex-col gap-1 border-t border-border pt-2"
          data-testid="main-offer-list-line-rewrites"
        >
          <p className="text-xs text-text-3">{W.pickRewrite}</p>
          {rewrites.map((r) => (
            <button
              key={r}
              type="button"
              disabled={busy !== null}
              onClick={() => void change(r)}
              className="rounded-control px-2 py-1.5 text-left text-[13px] hover:bg-card-2"
            >
              {r}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setRewrites(null)}
            className="self-start px-2 text-xs text-text-3 hover:text-text"
          >
            {W.keepMine}
          </button>
        </div>
      ) : null}
    </li>
  );
}
