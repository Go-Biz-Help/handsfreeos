'use client';
import { ChevronRight, Loader2, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { FormResponseGetOut, FormResponseRow } from '@/lib/api/types';

/** Who answered, and what one person said, with the questions worded as they read at the time. */
export function FormResponses({
  workspaceId,
  formId,
  opened = null,
}: {
  workspaceId: string;
  formId: string;
  /** A response to open straight away: a search result's `forms/<form>/answers/<response>`. */
  opened?: string | null;
}) {
  const [items, setItems] = useState<FormResponseRow[] | null>(null);
  const [open, setOpen] = useState<FormResponseGetOut | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/queries/form.response_list', {
          body: { workspaceId, formId, limit: 50 },
        }),
      );
      setItems(out.items);
    } catch (e) {
      toast.error(errorMessage(e));
      setItems([]);
    }
  }, [workspaceId, formId]);

  useEffect(() => {
    void load();
  }, [load]);

  const show = useCallback(
    async (responseId: string) => {
      setBusy(true);
      try {
        setOpen(
          unwrap(
            await apiBrowser().POST('/v1/queries/form.response_get', {
              body: { workspaceId, responseId },
            }),
          ),
        );
      } catch (e) {
        toast.error(errorMessage(e));
      } finally {
        setBusy(false);
      }
    },
    [workspaceId],
  );

  const shown = useRef<string | null>(null);
  useEffect(() => {
    if (!opened || shown.current === opened) return;
    shown.current = opened;
    void show(opened);
  }, [opened, show]);

  async function forget(responseId: string) {
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/form_response.delete', {
          body: { workspaceId, responseId },
        }),
      );
      setOpen(null);
      toast.success('Deleted.');
      await load();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  if (items === null)
    return (
      <Card className="flex items-center justify-center p-10 text-text-3">
        <Loader2 className="h-5 w-5 animate-spin" strokeWidth={1.75} />
      </Card>
    );

  return (
    <>
      <Card className="divide-y divide-border">
        {items.map((response) => (
          <button
            key={response.responseId}
            type="button"
            onClick={() => show(response.responseId)}
            className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-card-2"
            data-testid="response-row"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13.5px] text-text">
                {response.personName ?? 'Someone (anonymous)'}
              </span>
              <span className="block text-[12.5px] text-text-3">
                {response.completedAt
                  ? new Date(response.completedAt).toLocaleString()
                  : 'Not finished'}
                {response.scorePercent !== null ? ` · ${response.scorePercent}%` : ''}
                {response.passed === null ? '' : response.passed ? ' · passed' : ' · not passed'}
              </span>
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-text-3" strokeWidth={1.75} />
          </button>
        ))}
        {!items.length ? (
          <p className="px-4 py-8 text-center text-[13px] text-text-3">Nobody has answered yet.</p>
        ) : null}
      </Card>

      <Sheet open={open !== null} onOpenChange={(next) => !next && setOpen(null)}>
        <SheetContent title="The answers">
          {busy || !open ? (
            <div className="flex justify-center py-10 text-text-3">
              <Loader2 className="h-5 w-5 animate-spin" strokeWidth={1.75} />
            </div>
          ) : (
            <div className="space-y-4">
              <div className="text-[13px] text-text-2">
                {open.response.personId ? (
                  <Link
                    href={`/app/w/${workspaceId}/customers/${open.response.personId}`}
                    className="font-medium text-accent hover:underline"
                  >
                    {open.response.personName ?? 'The customer'}
                  </Link>
                ) : (
                  <span>Anonymous</span>
                )}
                {open.response.completedAt ? (
                  <span className="text-text-3">
                    {' '}
                    · {new Date(open.response.completedAt).toLocaleString()}
                  </span>
                ) : null}
              </div>

              <dl className="space-y-3">
                {open.answers.map((answer) => (
                  <div key={answer.questionId}>
                    <dt className="text-[12.5px] text-text-3">{answer.questionTitle}</dt>
                    <dd className="text-[14px] text-text">
                      {answer.labels.length
                        ? answer.labels.join(', ')
                        : (answer.text ?? JSON.stringify(answer.value))}
                    </dd>
                  </div>
                ))}
              </dl>

              {Object.keys(open.calculations).length ? (
                <div className="rounded-card bg-card-2 p-3 text-[13px] text-text-2">
                  {Object.entries(open.calculations).map(([id, value]) => (
                    <p key={id} className="flex justify-between">
                      <span>Worked out</span>
                      <span className="font-medium text-text">{value}</span>
                    </p>
                  ))}
                </div>
              ) : null}

              <Button
                variant="ghost"
                size="sm"
                onClick={() => forget(open.response.responseId)}
                className="text-danger-text"
              >
                <Trash2 className="h-4 w-4" strokeWidth={1.75} />
                Delete this response
              </Button>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
