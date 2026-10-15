'use client';
/**
 * What's working (round four): what the coach learned from wins, on the Playbooks tab for owners and admins
 * (`salescoach.manage`). Each suggestion says what the playbook says now, what won, and how often; **Use it** changes
 * the playbook (`salescoach.lesson.decide`), **Not now** puts it away. **Look again now** asks the worker to look over
 * the last 90 days at once (`salescoach.learn.now`) rather than wait for the weekly look.
 */
import { lessonWords } from '@hfos/core/addons/salescoach/learn';
import { SALESCOACH_WORDS as W } from '@hfos/core/addons/salescoach/words';
import { Trophy } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { workerPost } from '@/lib/api/worker';

type Lessons = Awaited<ReturnType<typeof read>>['lessons'];

const read = (workspaceId: string) =>
  apiBrowser().POST('/v1/queries/salescoach.lesson.list', { body: { workspaceId } }).then(unwrap);

export function LessonsView({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const [lessons, setLessons] = useState<Lessons | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    let current = true;
    void read(workspaceId)
      .then((r) => current && setLessons(r.lessons))
      .catch(() => current && setLessons([]));
    return () => {
      current = false;
    };
  }, [workspaceId, round]);

  const lookAgain = async () => {
    setBusy('look');
    try {
      const out = await workerPost<{ kept: number }>(
        '/v1/addons/salescoach/actions/salescoach.learn.now',
        { workspaceId, input: {} },
      );
      toast.message(W.learn.found(out.kept));
      setRound((r) => r + 1);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const decide = async (lessonId: string, use: boolean) => {
    setBusy(lessonId);
    try {
      await apiBrowser()
        .POST('/v1/commands/salescoach.lesson.decide', { body: { workspaceId, lessonId, use } })
        .then(unwrap);
      if (use) toast.success(W.learn.used);
      setRound((r) => r + 1);
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="space-y-3 p-4 md:p-5" data-testid="salescoach-lessons">
      <div className="flex flex-wrap items-center gap-2">
        <Trophy className="h-4 w-4 text-accent-text" strokeWidth={1.75} aria-hidden />
        <h2 className="text-[15px] font-semibold">{W.learn.title}</h2>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          disabled={busy !== null}
          onClick={() => void lookAgain()}
        >
          {busy === 'look' ? W.learn.looking : W.learn.lookAgain}
        </Button>
      </div>
      <p className="text-[13px] text-text-2">{W.learn.about}</p>
      {lessons && lessons.length === 0 ? (
        <p className="text-[13px] text-text-3">{W.learn.none}</p>
      ) : null}
      {(lessons ?? []).map((l) => (
        <div
          key={l.id}
          className="space-y-2 rounded-control border border-border p-3"
          data-testid="salescoach-lesson"
        >
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={l.kind === 'better_answer' ? 'accent' : 'ok'}>
              {l.kind === 'better_answer' ? W.learn.better : W.learn.added}
            </Badge>
            <span className="text-[14px] font-medium">“{l.objection}”</span>
            <span className="text-[12px] text-text-3">{W.learn.inPlaybook(l.playbookName)}</span>
          </div>
          <p className="text-[12.5px] text-text-2">
            {lessonWords({ kind: l.kind, wins: l.wins, of: l.of })}
          </p>
          {l.current ? (
            <p className="text-[13px] text-text-3">
              <span className="font-medium">{W.learn.now}:</span> {l.current}
            </p>
          ) : null}
          <p className="rounded-control bg-accent-soft p-2.5 text-[14px]">
            <span className="font-medium">{W.learn.suggested}:</span> {l.answer}
          </p>
          <div className="flex gap-2">
            <Button size="sm" disabled={busy !== null} onClick={() => void decide(l.id, true)}>
              {W.learn.use}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy !== null}
              onClick={() => void decide(l.id, false)}
            >
              {W.learn.dismiss}
            </Button>
          </div>
        </div>
      ))}
    </Card>
  );
}
