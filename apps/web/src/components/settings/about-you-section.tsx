'use client';
import { ABOUT_YOU_MOST, ABOUT_YOU_WORDS as W } from '@hfos/core';
import { Lock } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';

/**
 * About you (docs/outreach.md, decision 165): one box, in the person's own words, for every AI that writes as them,
 * with what's worth saying beside it. Theirs alone: nobody else on the team sees it. Empty and saved, it's cleared.
 */
export function AboutYouSection({ initial }: { initial: string }) {
  const [about, setAbout] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [busy, setBusy] = useState(false);
  const dirty = about.trim() !== saved;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!dirty) return;
    setBusy(true);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/user_about.set', { body: { about: about.trim() } }),
      );
      setSaved(about.trim());
      toast.success(out.filled ? W.saved : W.cleared);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate data-testid="about-you-form">
      <h2 className="text-lg font-semibold tracking-tight">{W.title}</h2>
      <p className="mt-1 max-w-[70ch] text-[13px] text-text-2">{W.lead}</p>
      <div className="mt-[18px] grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div>
          <Label htmlFor="about-you-text" className="sr-only">
            {W.label}
          </Label>
          <Textarea
            id="about-you-text"
            value={about}
            rows={7}
            maxLength={ABOUT_YOU_MOST}
            placeholder={W.placeholder}
            onChange={(e) => setAbout(e.target.value)}
            aria-describedby="about-you-how"
            data-testid="about-you-box"
          />
          <p id="about-you-how" className="mt-1.5 text-[12.5px] text-text-3">
            {W.how}
          </p>
        </div>
        <div>
          <p className="text-[13px] font-medium text-text">{W.ideasTitle}</p>
          <ul className="mt-1.5 list-disc space-y-1 pl-[18px] text-[13px] text-text-2">
            {W.ideas.map((idea) => (
              <li key={idea}>{idea}</li>
            ))}
          </ul>
        </div>
      </div>
      <div className="mt-[18px] flex flex-wrap items-center justify-between gap-3">
        <p className="flex items-center gap-1.5 text-[12.5px] text-text-3">
          <Lock className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
          {W.private}
        </p>
        <Button type="submit" disabled={!dirty} loading={busy} data-testid="about-you-save">
          {W.save}
        </Button>
      </div>
    </form>
  );
}
