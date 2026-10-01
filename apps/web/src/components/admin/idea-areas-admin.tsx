'use client';
import { IDEA_AREAS_WORDS, IDEAS_WORDS, ideaAreaIdFrom, nextIdeaAreaSort } from '@hfos/core';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { IdeaArea } from '@/lib/api/types';

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
      toast.success(IDEA_AREAS_WORDS.saved);
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
    const id = ideaAreaIdFrom(name);
    if (id.length < 2) return toast.error(IDEA_AREAS_WORDS.needsName);
    if (
      await save({
        id,
        name: name.trim(),
        description: description.trim(),
        sort: nextIdeaAreaSort(areas),
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
        {IDEAS_WORDS.title}
      </Link>
      <h1 className="text-xl font-semibold md:text-2xl">{IDEA_AREAS_WORDS.title}</h1>
      <p className="mt-1 text-[13px] text-text-3">{IDEA_AREAS_WORDS.intro}</p>
      <ul className="mt-4 divide-y divide-border overflow-hidden rounded-card border border-border bg-card">
        {areas.map((a) => (
          <li key={a.id} className="flex items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">
                {a.name}
                {a.archived ? (
                  <span className="ml-2 text-xs text-text-3">{IDEA_AREAS_WORDS.archived}</span>
                ) : null}
              </p>
              <p className="truncate text-xs text-text-3">
                {IDEA_AREAS_WORDS.line(a.description, a.openCount)}
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
                {a.archived ? IDEA_AREAS_WORDS.bringBack : IDEA_AREAS_WORDS.archive}
              </Button>
            )}
          </li>
        ))}
      </ul>
      <form
        onSubmit={add}
        className="mt-4 flex flex-col gap-2 rounded-card border border-border bg-card p-4"
      >
        <p className="text-sm font-medium">{IDEA_AREAS_WORDS.add}</p>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={IDEA_AREAS_WORDS.namePlaceholder}
          maxLength={60}
          aria-label={IDEA_AREAS_WORDS.nameLabel}
        />
        <Input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={IDEA_AREAS_WORDS.descriptionPlaceholder}
          maxLength={300}
          aria-label={IDEA_AREAS_WORDS.descriptionLabel}
        />
        <div>
          <Button type="submit" size="sm" disabled={!name.trim()}>
            {IDEA_AREAS_WORDS.addButton}
          </Button>
        </div>
      </form>
    </div>
  );
}
