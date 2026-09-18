'use client';
import { Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';

interface Reply {
  readonly id: string;
  readonly title: string;
  readonly bodyText: string;
  readonly updatedAt: string;
}

/**
 * The answers the desk gives often enough to be worth writing down once. They are also what the AI reads
 * before it drafts, so a good saved reply improves every draft after it.
 */
export function SavedReplies({
  replies,
  canManage,
}: {
  replies: readonly Reply[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<Reply | 'new' | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const open = (r: Reply | 'new') => {
    setEditing(r);
    setTitle(r === 'new' ? '' : r.title);
    setBody(r === 'new' ? '' : r.bodyText);
    setError(null);
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/support.canned_reply.save', {
          body: {
            ...(editing && editing !== 'new' ? { id: editing.id } : {}),
            title: title.trim(),
            bodyText: body.trim(),
          },
        }),
      );
      setEditing(null);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    try {
      unwrap(await apiBrowser().POST('/v1/commands/support.canned_reply.delete', { body: { id } }));
      setEditing(null);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-3xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold md:text-2xl">Saved replies</h1>
          <p className="mt-1 text-[13px] text-text-3">
            Written once, used often. The AI reads these before it drafts, so a good one here makes
            every draft better.
          </p>
        </div>
        {canManage ? (
          <Button onClick={() => open('new')} data-testid="reply-new">
            <Plus className="h-[18px] w-[18px]" strokeWidth={1.5} />
            New saved reply
          </Button>
        ) : null}
      </div>

      {editing ? (
        <form onSubmit={save} className="mt-5 rounded-card border border-border bg-card p-4">
          <div className="flex flex-col gap-3">
            <Field label="What is it for?" htmlFor="reply-title">
              <Input
                id="reply-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Texts are not arriving"
                data-testid="reply-title"
              />
            </Field>
            <Field label="The reply" htmlFor="reply-body">
              <Textarea
                id="reply-body"
                rows={8}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                data-testid="reply-body"
              />
            </Field>
            {error ? <p className="text-[13px] text-danger-text">{error}</p> : null}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={busy || !title.trim() || !body.trim()}>
                Save
              </Button>
              <Button type="button" variant="ghost" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              {editing !== 'new' ? (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  className="ml-auto text-danger-text"
                  onClick={() => remove(editing.id)}
                >
                  Delete
                </Button>
              ) : null}
            </div>
          </div>
        </form>
      ) : null}

      <ul className="mt-5 divide-y divide-border overflow-hidden rounded-card border border-border bg-card">
        {replies.map((r) => (
          <li key={r.id} className="px-4 py-3.5">
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-sm font-semibold">{r.title}</p>
              {canManage ? (
                <button
                  type="button"
                  onClick={() => open(r)}
                  className="flex-none text-[13px] text-text-3 hover:text-text"
                >
                  Edit
                </button>
              ) : null}
            </div>
            <p className="mt-1 whitespace-pre-wrap text-[13px] text-text-2">{r.bodyText}</p>
          </li>
        ))}
        {replies.length === 0 ? (
          <li className="px-4 py-10 text-center text-[13px] text-text-3">
            Nothing saved yet. The next answer you find yourself writing twice belongs here.
          </li>
        ) : null}
      </ul>
    </div>
  );
}
