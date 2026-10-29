'use client';
/**
 * Settings → Instagram's **Accounts like yours** (docs/outreach.md, decision 110): up to 5 Instagram accounts whose
 * followers are the business's kind of customer, each with who added it, why, and when the person's computer last
 * read it. Owners and admins add one by its username or address, and remove one; everyone else sees the list.
 */
import {
  LIKE_YOURS_WORDS as L,
  type LikeYoursAccount,
  likeYoursLine,
  type LikeYoursListOutput,
  usernameOf,
} from '@hfos/core/addons/outreach/like-yours';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { relativeTime } from '@/lib/utils';
import { Part } from './settings-view';
import { useAct } from './use-act';

export function LikeYoursPart({ workspaceId }: { workspaceId: string }) {
  const [got, setGot] = useState<LikeYoursListOutput | null>(null);
  const [typed, setTyped] = useState('');
  const load = useCallback(async () => {
    try {
      setGot(
        unwrap(
          await apiBrowser().POST('/v1/queries/outreach.like_yours.list', {
            body: { workspaceId },
          }),
        ),
      );
    } catch {
      setGot(null);
    }
  }, [workspaceId]);
  useEffect(() => {
    void load();
  }, [load]);
  const { busy, act } = useAct();
  if (!got) return null;
  const full = got.accounts.length >= got.most;

  const changed = (accounts: readonly LikeYoursAccount[]) =>
    setGot((was) => (was ? { ...was, accounts: [...accounts] } : was));
  const add = () => {
    const account = typed.trim();
    return act(
      'add',
      async () => {
        const answer = unwrap(
          await apiBrowser().POST('/v1/commands/outreach.like_yours.add', {
            body: { workspaceId, account },
          }),
        );
        changed(answer.accounts);
        setTyped('');
        return answer;
      },
      L.added(usernameOf(account) ?? account.replace(/^@/, '')),
    );
  };
  const remove = (a: LikeYoursAccount) =>
    act(
      `remove:${a.id}`,
      async () => {
        const answer = unwrap(
          await apiBrowser().POST('/v1/commands/outreach.like_yours.remove', {
            body: { workspaceId, id: a.id },
          }),
        );
        changed(answer.accounts);
        return answer;
      },
      L.removed(a.username),
    );

  return (
    <Part card title={L.title} about={L.about} testId="outreach-like-yours">
      {got.accounts.length ? (
        <ul className="divide-y divide-border rounded-[10px] border border-border">
          {got.accounts.map((a) => (
            <li
              key={a.id}
              className="flex flex-wrap items-start justify-between gap-3 px-3.5 py-2.5"
              data-testid="outreach-like-yours-account"
            >
              <div className="min-w-0 text-[13.5px]">
                <a
                  href={a.url}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-accent-text hover:underline"
                >
                  @{a.username}
                </a>
                {a.name ? <span className="ml-1.5 text-text-2">{a.name}</span> : null}
                <div className="text-[12.5px] text-text-3">{likeYoursLine(a, relativeTime)}</div>
                {a.why ? <p className="mt-0.5 text-[12.5px] text-text-2">{a.why}</p> : null}
              </div>
              {got.canManage ? (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy !== null}
                  onClick={() => void remove(a)}
                  data-testid="outreach-like-yours-remove"
                >
                  {L.remove}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-text-2" data-testid="outreach-like-yours-none">
          {L.none}
        </p>
      )}
      {!got.canManage ? (
        <p className="text-[12.5px] text-text-3">{L.manageOnly}</p>
      ) : full ? (
        <p className="text-[12.5px] text-text-3" data-testid="outreach-like-yours-full">
          {L.full}
        </p>
      ) : (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <div className="min-w-[200px] flex-1 space-y-1">
            <Label htmlFor="outreach-like-yours-input">{L.addLabel}</Label>
            <Input
              id="outreach-like-yours-input"
              value={typed}
              placeholder={L.addPlaceholder}
              onChange={(e) => setTyped(e.target.value)}
              data-testid="outreach-like-yours-input"
            />
          </div>
          <Button
            type="submit"
            size="sm"
            disabled={busy !== null || !typed.trim()}
            data-testid="outreach-like-yours-add"
          >
            {L.add}
          </Button>
        </form>
      )}
    </Part>
  );
}
