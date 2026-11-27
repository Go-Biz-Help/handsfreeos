'use client';
/**
 * The rest of the brand kit (HANDSFREEOS_DESIGN_TOOLS_IMPLEMENTATION_PLAN.md, part 1), under the logo and colour in
 * Settings → Workspace: its font and corners, and Match my website, which fills the colour, font and corners from the
 * business's site at once. Forms, booking pages and the rest that haven't picked their own follow these. Each change
 * is kept at once by `look.set`.
 */
import {
  FORM_DEFAULT_FONT,
  FORM_FONTS,
  LOOK_CORNERS,
  siteNameOf,
  type BusinessLook,
} from '@hfos/core';
import { Wand2 } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { FieldError, Hint } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { errorMessage } from '@/lib/api/client';
import { lookActions } from '@/lib/look-actions';

const CORNER_WORDS: Record<(typeof LOOK_CORNERS)[number], string> = {
  square: 'Square',
  slight: 'Slightly round',
  round: 'Round',
};

export function BrandKitExtras({
  workspaceId,
  look,
  website,
  canChange,
  onChanged,
}: {
  workspaceId: string;
  look: BusinessLook;
  website: string | null;
  canChange: boolean;
  onChanged: () => void;
}) {
  const actions = useMemo(() => lookActions(workspaceId), [workspaceId]);
  const [given, setGiven] = useState<{ from: BusinessLook; look: BusinessLook } | null>(null);
  const shown = given && given.from === look ? given.look : look;
  const [site, setSite] = useState(
    shown.matched?.site ? siteNameOf(shown.matched.site) : website ? siteNameOf(website) : '',
  );
  const [busy, setBusy] = useState<'match' | 'kit' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fontId = useId();
  const siteId = useId();
  const font = shown.font?.name ?? null;
  const fonts =
    !font || FORM_FONTS.some((f) => f.name === font)
      ? FORM_FONTS
      : [...FORM_FONTS, { name: font, weights: '', kind: 'sans' as const }];

  async function keep(kit: Parameters<typeof actions.setKit>[0], done: string) {
    setBusy('kit');
    setError(null);
    try {
      setGiven({ from: look, look: await actions.setKit(kit) });
      toast.success(done, { id: 'brand-kit' });
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function match() {
    setBusy('match');
    setError(null);
    try {
      const found = await actions.readWebsite(site.trim() || null);
      const next = await actions.setKit({
        ...(found.color ? { color: found.color } : {}),
        font: found.font,
        ...(found.corners ? { corners: found.corners } : {}),
        matchedSite: found.site,
      });
      setGiven({ from: look, look: next });
      toast.success(`Matched to ${siteNameOf(found.site)}.`, { id: 'brand-kit' });
      if (found.fontNote) toast.message(found.fontNote);
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-5 space-y-4 border-t border-border pt-5" data-testid="brand-kit">
      {canChange ? (
        <div>
          <label htmlFor={siteId} className="block text-[13px] font-medium">
            Match my website
          </label>
          <p className="mb-2 mt-0.5 text-[12.5px] text-text-3">
            Copies its button colour, font and corners into your brand kit. You can change anything
            after.
          </p>
          <div className="flex gap-2">
            <Input
              id={siteId}
              value={site}
              placeholder="yourwebsite.com"
              onChange={(e) => setSite(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void match();
              }}
              data-testid="brand-kit-match-site"
            />
            <Button
              variant="secondary"
              onClick={() => void match()}
              loading={busy === 'match'}
              data-testid="brand-kit-match"
            >
              <Wand2 className="h-4 w-4" strokeWidth={1.75} aria-hidden />
              Match
            </Button>
          </div>
          {shown.matched ? (
            <Hint>
              Matched to {siteNameOf(shown.matched.site)} on{' '}
              {new Date(shown.matched.at).toLocaleDateString(undefined, {
                month: 'short',
                day: 'numeric',
              })}
              .
            </Hint>
          ) : null}
        </div>
      ) : null}

      <div>
        <label htmlFor={fontId} className="block text-[13px] font-medium">
          Font
        </label>
        <Select
          id={fontId}
          className="mt-1.5"
          value={font ?? FORM_DEFAULT_FONT}
          disabled={!canChange || busy !== null}
          onChange={(e) =>
            void keep(
              { font: e.target.value === FORM_DEFAULT_FONT ? null : e.target.value },
              'Font saved',
            )
          }
          data-testid="brand-kit-font"
        >
          {fonts.map((f) => (
            <option key={f.name} value={f.name}>
              {f.name === FORM_DEFAULT_FONT ? `${f.name} (HandsFreeOS’s)` : f.name}
            </option>
          ))}
        </Select>
      </div>

      <div data-testid="brand-kit-corners">
        <p className="mb-1.5 text-[13px] font-medium">Corners</p>
        <Segmented
          ariaLabel="Corners"
          value={shown.corners?.value ?? 'slight'}
          onChange={(corners) => {
            if (!canChange || busy) return;
            void keep({ corners: corners === 'slight' ? null : corners }, 'Corners saved');
          }}
          options={LOOK_CORNERS.map((c) => ({
            value: c,
            label: CORNER_WORDS[c],
            testId: `brand-kit-corners-${c}`,
          }))}
        />
      </div>
      <Hint className="mt-0">
        Forms and booking pages that haven’t picked their own font and corners use these.
      </Hint>
      <FieldError>{error}</FieldError>
    </div>
  );
}
