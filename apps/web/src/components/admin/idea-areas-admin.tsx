'use client';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { IdeaArea } from '@/lib/api/types';

/** An area's id from its name: "Service plans" is service_plans. */
const idFrom = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^[^a-z]+/, '')
    .slice(0, 40);

/**
 * The parts of HandsFreeOS an idea can be about. A new part of the product is a row here, not a deploy; an
 * archived one takes no new ideas, and the ideas already in it keep it.
 */
export function IdeaAreasAdmin({ areas }: { areas: readonly IdeaArea[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  const save = async (area: {
    id: string;
    name: string;
    description: string;
    sort: number;
    archived: boolean;
  }) => {
    setBusy(area.id);
    try {
      unwrap(await apiBrowser().POST('/v1/commands/idea_area.save', { body: area }));
      toast.success('Saved.');
      router.refresh();
      return true;
    } catch (e) {
      toast.error(errorMessage(e));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const add = async (e: FormEvent) => {
    e.preventDefault();
    const id = idFrom(name);
    if (id.length < 2) return toast.error('Name it with a word or two.');
    const last = areas.filter((a) => a.id !== 'other').at(-1)?.sort ?? 0;
    if (
      await save({
        id,
        name: name.trim(),
        description: description.trim(),
        sort: last + 10,
        archived: false,
      })
    ) {
      setName('');
      setDescription('');
    }
  };

  return (
    <div className="mx-auto w-full max-w-3xl">
      <Link
        href="/admin/ideas"
        className="mb-3 inline-flex items-center gap-1.5 text-[13px] font-medium text-text-2 hover:text-text"
      >
        <ArrowLeft className="h-4 w-4" strokeWidth={1.5} aria-hidden />
        Ideas
      </Link>
      <h1 className="text-xl font-semibold md:text-2xl">Areas</h1>
      <p className="mt-1 text-[13px] text-text-3">
        What people pick when they share an idea, in this order.
      </p>
      <ul className="mt-4 divide-y divide-border overflow-hidden rounded-card border border-border bg-card">
        {areas.map((a) => (
          <li key={a.id} className="flex items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">
                {a.name}
                {a.archived ? <span className="ml-2 text-xs text-text-3">Archived</span> : null}
              </p>
              <p className="truncate text-xs text-text-3">
                {a.description || 'No description'} · {a.openCount} open
              </p>
            </div>
            {a.id === 'other' ? null : (
              <Button
                size="sm"
                variant="ghost"
                loading={busy === a.id}
                onClick={() =>
                  void save({
                    id: a.id,
                    name: a.name,
                    description: a.description,
                    sort: a.sort,
                    archived: !a.archived,
                  })
                }
              >
                {a.archived ? 'Bring back' : 'Archive'}
              </Button>
            )}
          </li>
        ))}
      </ul>
      <form
        onSubmit={add}
        className="mt-4 flex flex-col gap-2 rounded-card border border-border bg-card p-4"
      >
        <p className="text-sm font-medium">Add an area</p>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Service plans"
          maxLength={60}
          aria-label="Name"
        />
        <Input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What belongs in it (optional)"
          maxLength={300}
          aria-label="Description"
        />
        <div>
          <Button type="submit" size="sm" disabled={!name.trim()}>
            Add it
          </Button>
        </div>
      </form>
    </div>
  );
}
