'use client';
/**
 * The rest of the brand kit (HANDSFREEOS_DESIGN_TOOLS_IMPLEMENTATION_PLAN.md, part 1), under the logo and colour in
 * Settings → Workspace: its font and corners, and Match my website, which fills the colour, font and corners from the
 * business's site at once, its social links (part 5), which email footers show, and its license number (part 7), at
 * the bottom of its customers' pages with the social links. Forms, booking pages and the rest that haven't picked
 * their own follow these. Each change is kept at once by `look.set`.
 */
import {
  FORM_DEFAULT_FONT,
  FORM_FONTS,
  LOOK_CORNERS,
  LOOK_LICENSE_MOST,
  LOOK_SOCIAL_NAMES,
  LOOK_SOCIALS_MAX,
  siteNameOf,
  socialKindOf,
  socialUrlOf,
  type BusinessLook,
  type LookSocialLink,
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

  async function keep(kit: Parameters<typeof actions.setKit>[0], done: string): Promise<boolean> {
    setBusy('kit');
    setError(null);
    try {
      setGiven({ from: look, look: await actions.setKit(kit) });
      toast.success(done, { id: 'brand-kit' });
      onChanged();
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
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
        Forms, booking pages and your website chat use these until they pick their own font and
        corners.
      </Hint>
      <FieldError>{error}</FieldError>
      <SocialLinks
        links={shown.socials?.links ?? []}
        canChange={canChange}
        busy={busy !== null}
        onSave={(list, done) => keep({ socials: list }, done)}
      />
      <LicenseNumber
        license={shown.license?.text ?? null}
        canChange={canChange}
        busy={busy !== null}
        onSave={(license, done) => keep({ license }, done)}
      />
    </div>
  );
}

/**
 * The business's license number (design tools, part 7): at the bottom of its customers' invoices, estimates, documents
 * to sign and appointment pages, with its address and social links. Contractors often need it on paperwork.
 */
function LicenseNumber({
  license,
  canChange,
  busy,
  onSave,
}: {
  license: string | null;
  canChange: boolean;
  busy: boolean;
  onSave: (license: string | null, done: string) => Promise<boolean>;
}) {
  const inputId = useId();
  const [typed, setTyped] = useState(license ?? '');
  const changed = typed.trim() !== (license ?? '');
  return (
    <div className="border-t border-border pt-4" data-testid="brand-kit-license">
      <label htmlFor={inputId} className="block text-[13px] font-medium">
        License number
      </label>
      <p className="mb-2 mt-0.5 text-[12.5px] text-text-3">
        Shown at the bottom of your invoices, estimates, documents to sign and appointment pages,
        with your address and social links. Leave it empty if you don’t have one.
      </p>
      <div className="flex gap-2">
        <Input
          id={inputId}
          value={typed}
          maxLength={LOOK_LICENSE_MOST}
          placeholder="TX HVAC Lic. TACLA12345C"
          disabled={!canChange}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && changed)
              void onSave(
                typed.trim() || null,
                typed.trim() ? 'License number saved' : 'License number removed',
              );
          }}
          data-testid="brand-kit-license-input"
        />
        {canChange ? (
          <Button
            variant="secondary"
            disabled={!changed || busy}
            onClick={() =>
              void onSave(
                typed.trim() || null,
                typed.trim() ? 'License number saved' : 'License number removed',
              )
            }
            data-testid="brand-kit-license-save"
          >
            Save
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The business's social links (design tools, part 5): Facebook, Instagram and the rest, each named for its site. Email
 * footers show them, and later its customers' pages. Each change saves the whole list.
 */
function SocialLinks({
  links,
  canChange,
  busy,
  onSave,
}: {
  links: readonly LookSocialLink[];
  canChange: boolean;
  busy: boolean;
  onSave: (list: string[], done: string) => Promise<boolean>;
}) {
  const inputId = useId();
  const [typed, setTyped] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const urls = links.map((l) => l.url);

  async function add() {
    const url = socialUrlOf(typed);
    if (!url) {
      setProblem('Type a web address, like facebook.com/yourbusiness.');
      return;
    }
    if (urls.includes(url)) {
      setProblem('That link is already here.');
      return;
    }
    setProblem(null);
    if (await onSave([...urls, url], `${LOOK_SOCIAL_NAMES[socialKindOf(url)]} link saved`))
      setTyped('');
  }

  return (
    <div className="border-t border-border pt-4" data-testid="brand-kit-socials">
      <label htmlFor={inputId} className="block text-[13px] font-medium">
        Social links
      </label>
      <p className="mb-2 mt-0.5 text-[12.5px] text-text-3">
        Your Facebook page, Instagram and the rest. Your email footers and your customers’ pages
        show them.
      </p>
      {links.length ? (
        <ul className="mb-2 divide-y divide-border rounded-control border border-border">
          {links.map((l) => (
            <li
              key={l.url}
              className="flex items-center gap-3 px-3 py-2"
              data-testid="brand-kit-social"
            >
              <span className="w-[86px] flex-none text-[13px] font-medium">
                {LOOK_SOCIAL_NAMES[l.kind]}
              </span>
              <a
                href={l.url}
                target="_blank"
                rel="noreferrer"
                className="min-w-0 flex-1 truncate text-[13px] text-text-2 hover:underline"
              >
                {l.url.replace(/^https:\/\/(www\.)?/, '').replace(/\/$/, '')}
              </a>
              {canChange ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void onSave(
                      urls.filter((u) => u !== l.url),
                      `${LOOK_SOCIAL_NAMES[l.kind]} link removed`,
                    )
                  }
                  data-testid="brand-kit-social-remove"
                >
                  Remove
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {canChange && links.length < LOOK_SOCIALS_MAX ? (
        <div className="flex gap-2">
          <Input
            id={inputId}
            value={typed}
            placeholder="facebook.com/yourbusiness"
            onChange={(e) => {
              setTyped(e.target.value);
              setProblem(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && typed.trim()) void add();
            }}
            invalid={!!problem}
            data-testid="brand-kit-social-input"
          />
          <Button
            variant="secondary"
            onClick={() => void add()}
            disabled={!typed.trim() || busy}
            data-testid="brand-kit-social-add"
          >
            Add a link
          </Button>
        </div>
      ) : null}
      <FieldError>{problem}</FieldError>
    </div>
  );
}
