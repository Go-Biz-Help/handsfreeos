'use client';
/**
 * In your hands (core's messaging/hands.ts): on a customer's Details, whether the AI answers them or someone on the
 * team has them, with Take over or Give back to the AI; and the list of everyone in someone's hands on Contacts, with
 * Give back on each and Give all back.
 */
import { handsLine, HANDS_WORDS, relativeTimeAgo, type InHandsRow } from '@hfos/core';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';

const W = HANDS_WORDS;

async function giveBack(
  workspaceId: string,
  body: { personIds?: string[]; all?: boolean; mine?: boolean },
) {
  return unwrap(
    await apiBrowser().POST('/v1/commands/person.hand_back', {
      body: {
        workspaceId,
        personIds: body.personIds ?? [],
        all: body.all ?? false,
        mine: body.mine ?? false,
      },
    }),
  );
}

/** The AI's row on a customer's Details: "Answers them", or whose hands they're in, with the button that changes it. */
export function HandsDetailsRow({
  workspaceId,
  personId,
  name,
  myUserId,
  hands,
  canEdit,
}: {
  workspaceId: string;
  personId: string;
  name: string;
  myUserId: string;
  hands: InHandsRow | null;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function act() {
    setBusy(true);
    try {
      if (hands) {
        await giveBack(workspaceId, { personIds: [personId] });
        toast.success(W.gaveBackToast(1));
      } else {
        unwrap(
          await apiBrowser().POST('/v1/commands/person.take_over', {
            body: { workspaceId, personId },
          }),
        );
        toast.success(W.tookOverToast(name));
      }
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1" data-testid="hands-row">
      <span data-testid="hands-value">
        {hands
          ? `${W.title} · ${handsLine(hands, myUserId)} ${relativeTimeAgo(hands.lastAt)}`
          : W.aiAnswers}
      </span>
      {canEdit ? (
        <button
          type="button"
          className="text-[12.5px] font-medium text-accent-text hover:underline disabled:opacity-50"
          onClick={() => void act()}
          disabled={busy}
          title={hands ? W.giveBackHint : W.takeOverHint}
          data-testid={hands ? 'hands-give-back' : 'hands-take-over'}
        >
          {hands ? W.giveBack : W.takeOver}
        </button>
      ) : null}
    </span>
  );
}

/** Contacts → In your hands: everyone someone on the team has, newest first. */
export function HandsList({
  workspaceId,
  myUserId,
  people,
  total,
  mine,
  canEdit,
}: {
  workspaceId: string;
  myUserId: string;
  people: readonly InHandsRow[];
  total: number;
  mine: boolean;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  async function back(which: string | 'all') {
    setBusy(which);
    try {
      const got = await giveBack(
        workspaceId,
        which === 'all' ? { all: true, mine } : { personIds: [which] },
      );
      toast.success(W.gaveBackToast(Math.max(1, got.handedBack)));
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const base = `/app/w/${workspaceId}/customers?show=hands`;
  return (
    <div className="flex flex-col gap-3" data-testid="hands-list">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13.5px] text-text-2">{W.about}</p>
        <div className="flex items-center gap-2">
          <Link
            href={mine ? base : `${base}&mine=1`}
            className="text-[12.5px] font-medium text-accent-text hover:underline"
            data-testid="hands-mine-toggle"
          >
            {mine ? W.everyone : W.mine}
          </Link>
          {canEdit && people.length ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void back('all')}
              loading={busy === 'all'}
              disabled={busy !== null}
              data-testid="hands-give-all-back"
            >
              {W.giveAllBack}
            </Button>
          ) : null}
        </div>
      </div>
      {people.length === 0 ? (
        <p className="rounded-lg border border-border px-4 py-6 text-center text-[13.5px] text-text-2">
          {W.empty}
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {people.map((p) => (
            <li
              key={p.personId}
              className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
              data-testid="hands-person"
            >
              <div className="min-w-0">
                <Link
                  href={`/app/w/${workspaceId}/customers/people/${p.personId}`}
                  className="font-medium hover:underline"
                >
                  {p.name}
                </Link>
                <p className="text-[12.5px] text-text-2">
                  {handsLine(p, myUserId)} · {relativeTimeAgo(p.lastAt)}
                  {p.waitingSince ? ` · ${W.waiting}` : ''}
                </p>
              </div>
              {canEdit ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void back(p.personId)}
                  loading={busy === p.personId}
                  disabled={busy !== null}
                  title={W.giveBackHint}
                  data-testid="hands-give-back"
                >
                  {W.giveBack}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {total > people.length ? (
        <p className="text-[12.5px] text-text-2">
          Showing the latest {people.length} of {total}.
        </p>
      ) : null}
    </div>
  );
}
