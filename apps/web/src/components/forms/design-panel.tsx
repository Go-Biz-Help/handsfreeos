'use client';
import {
  DEFAULT_FORM_DESIGN,
  FORM_DEFAULT_FONT,
  FORM_FONTS,
  formLook,
  type FormDefinition,
  type FormDesign,
  type FormDesignColors,
  type FormDesignInput,
  type FormOp,
} from '@hfos/core';
import { Monitor, Smartphone, Wand2 } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { ColorChoice } from '@/components/settings/chat-look-parts';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogClose, DialogContent } from '@/components/ui/dialog';
import { Hint } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { errorMessage } from '@/lib/api/client';
import { workerPost } from '@/lib/api/worker';
import { Segmented } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import type { FormLogo } from './form-look';
import { FormPreview } from './preview';

/** The business's own look, which a form follows until its design says otherwise. */
export interface FormBrand {
  /** Its colour (Settings → Workspace, under its logo); null for HandsFreeOS's blue. */
  readonly color: string | null;
  readonly logo: FormLogo | null;
  /** Its website (Settings → Workspace), which Match my website reads when no site is listed for the form. */
  readonly website?: string | null;
}

/** What the worker hands back for Match my website (apps/worker/src/http/website-style.ts). */
interface MatchedWebsite {
  readonly site: string;
  readonly design: Partial<FormDesignInput>;
  /** Said when the site's font isn't free and another stands in. */
  readonly fontNote: string | null;
}

/** A site's name for the words: shopyoursolar.com. */
const hostOf = (url: string) => {
  try {
    return new URL(url.includes('://') ? url : `https://${url}`).host.replace(/^www\./, '');
  } catch {
    return url;
  }
};

/** What each colour is called on the tab, and what "Automatic" means for it. */
const COLOURS: readonly {
  key: keyof FormDesignColors;
  title: string;
  auto: string;
  hint?: string;
}[] = [
  {
    key: 'button',
    title: 'Buttons',
    auto: 'Your colour',
    hint: 'Send, Next, and the answer someone picks.',
  },
  { key: 'buttonText', title: 'Words on buttons', auto: 'Automatic' },
  {
    key: 'background',
    title: 'Background',
    auto: 'Automatic',
    hint: 'Automatic is white, and see-through on your website, so the form sits on the site’s own background.',
  },
  { key: 'text', title: 'Words', auto: 'Automatic' },
  { key: 'field', title: 'Inside the boxes', auto: 'Automatic' },
  { key: 'fieldBorder', title: 'Box outlines', auto: 'Automatic' },
  {
    key: 'error',
    title: 'Mistakes',
    auto: 'Automatic',
    hint: '“Answer this one” and the stars on questions that need an answer.',
  },
];

/** The colour each token comes out as now, for the swatch beside "Automatic". */
const TOKEN: Record<keyof FormDesignColors, string> = {
  button: '--accent',
  buttonText: '--form-on-accent',
  background: '--bg',
  text: '--text',
  field: '--card',
  fieldBorder: '--border-strong',
  error: '--danger',
};

/**
 * The form's Design tab: its colours, font, shape and layout, with the form beside it as it'll look on its own page or
 * on a website, on a computer or a phone. Every change is an edit to the draft (`set_design`), so it saves itself, can
 * be undone, and goes live with Publish like the questions do.
 */
export function FormDesignPanel({
  workspaceId,
  definition,
  apply,
  readOnly,
  brand,
  embedOrigins,
  onUseEverywhere,
}: {
  workspaceId: string;
  definition: FormDefinition;
  apply: (ops: FormOp[]) => void;
  readOnly: boolean;
  brand: FormBrand;
  /** The sites allowed to show it (the Share tab): the first is the one Match my website reads. */
  embedOrigins: readonly string[];
  /** Puts this design on every other form (form.use_design_everywhere), after saving the draft it's read from. */
  onUseEverywhere?: () => Promise<void>;
}) {
  const design: FormDesign = definition.design ?? DEFAULT_FORM_DESIGN;
  const [where, setWhere] = useState<'page' | 'website'>('website');
  const [device, setDevice] = useState<'computer' | 'phone'>('computer');
  const set = (patch: Partial<FormDesignInput>) => {
    if (readOnly) return;
    apply([{ op: 'set_design', patch }]);
  };
  const setColour = (key: keyof FormDesignColors, value: string | null) =>
    set({ colors: { [key]: value } });
  // What "Automatic" gives right now, worked out exactly as the page does.
  const shown = formLook(design, { businessColor: brand.color }).vars;
  const fonts =
    FORM_FONTS.some((f) => f.name === design.font) || !design.font
      ? FORM_FONTS
      : [...FORM_FONTS, { name: design.font, weights: '', kind: 'sans' as const }];

  return (
    <div
      className="grid gap-4 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]"
      data-testid="form-design"
    >
      <div className="min-w-0 space-y-3">
        {!readOnly ? (
          <MatchWebsite
            workspaceId={workspaceId}
            suggested={embedOrigins[0] ?? brand.website ?? ''}
            matched={design.matched}
            onMatched={(m) => apply([{ op: 'set_design', patch: m.design }])}
          />
        ) : null}
        <Section title="Colours">
          <Segmented
            ariaLabel="Light or dark"
            value={design.scheme}
            onChange={(scheme) => set({ scheme })}
            options={[
              { value: 'light', label: 'Light', testId: 'design-light' },
              { value: 'dark', label: 'Dark', testId: 'design-dark' },
            ]}
          />
          {COLOURS.map((c) => (
            <ColorChoice
              key={c.key}
              title={c.title}
              autoLabel={c.auto}
              value={design.colors[c.key]}
              shownAuto={shownColour(shown[TOKEN[c.key]])}
              onChange={(next) => setColour(c.key, next)}
              testId={`design-color-${c.key}`}
              hint={c.hint}
            />
          ))}
        </Section>

        <Section title="Font">
          <Labelled title="Font">
            {(id) => (
              <Select
                id={id}
                value={design.font ?? FORM_DEFAULT_FONT}
                disabled={readOnly}
                onChange={(e) =>
                  set({ font: e.target.value === FORM_DEFAULT_FONT ? null : e.target.value })
                }
                data-testid="design-font"
              >
                {fonts.map((f) => (
                  <option key={f.name} value={f.name}>
                    {f.name === FORM_DEFAULT_FONT ? `${f.name} (HandsFreeOS’s)` : f.name}
                  </option>
                ))}
              </Select>
            )}
          </Labelled>
          <Choice
            title="Text size"
            value={design.textSize}
            onChange={(textSize) => set({ textSize })}
            options={[
              ['small', 'Small'],
              ['medium', 'Medium'],
              ['large', 'Large'],
            ]}
            testId="design-size"
          />
        </Section>

        <Section title="Shape">
          <Choice
            title="Corners"
            value={design.corners}
            onChange={(corners) => set({ corners })}
            options={[
              ['square', 'Square'],
              ['slight', 'Slightly round'],
              ['round', 'Round'],
            ]}
            testId="design-corners"
          />
          <Choice
            title="Boxes"
            value={design.fields}
            onChange={(fields) => set({ fields })}
            options={[
              ['boxed', 'Outlined'],
              ['filled', 'Filled in'],
              ['underline', 'Line underneath'],
            ]}
            testId="design-fields"
          />
        </Section>

        <Section title="Button">
          <Choice
            title="Style"
            value={design.button.style}
            onChange={(style) => set({ button: { style } })}
            options={[
              ['filled', 'Filled'],
              ['outline', 'Outlined'],
            ]}
            testId="design-button"
          />
          <SwitchRow
            label="As wide as the form"
            checked={design.button.fullWidth}
            onChange={(fullWidth) => set({ button: { fullWidth } })}
            disabled={readOnly}
            testId="design-button-wide"
          />
          <Hint className="mt-0">Change its words under Settings on the Questions tab.</Hint>
        </Section>

        <Section title="Layout">
          <Choice
            title="Space between questions"
            value={design.spacing}
            onChange={(spacing) => set({ spacing })}
            options={[
              ['compact', 'Less'],
              ['normal', 'Normal'],
              ['roomy', 'More'],
            ]}
            testId="design-spacing"
          />
          <Choice
            title="Question words"
            value={design.labels}
            onChange={(labels) => set({ labels })}
            options={[
              ['above', 'Above the box'],
              ['inside', 'Inside the box'],
            ]}
            testId="design-labels"
            hint="Inside the box works for boxes people type in. The rest keep theirs above."
          />
          <Choice
            title="Widest it gets"
            value={design.width}
            onChange={(width) => set({ width })}
            options={[
              ['narrow', 'Narrow'],
              ['medium', 'Medium'],
              ['wide', 'Wide'],
              ['full', 'Full'],
            ]}
            testId="design-width"
          />
          <SwitchRow
            label="The form’s name at the top"
            checked={design.showTitle}
            onChange={(showTitle) => set({ showTitle })}
            disabled={readOnly}
            testId="design-title"
          />
          <SwitchRow
            label="Your logo at the top"
            checked={design.showLogo}
            onChange={(showLogo) => set({ showLogo })}
            disabled={readOnly || (!brand.logo && !design.showLogo)}
            testId="design-logo"
          />
          {!brand.logo ? (
            <Hint className="mt-0">Add your logo in Settings → Workspace to show it here.</Hint>
          ) : null}
        </Section>

        {!readOnly && onUseEverywhere ? <UseEverywhere onConfirm={onUseEverywhere} /> : null}

        {!readOnly ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => set(DEFAULT_FORM_DESIGN)}
            data-testid="design-reset"
          >
            Start over from your colour
          </Button>
        ) : null}
      </div>

      <div className="min-w-0">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Segmented
            ariaLabel="Where it shows"
            value={where}
            onChange={setWhere}
            options={[
              { value: 'website', label: 'On your website', testId: 'design-on-website' },
              { value: 'page', label: 'On its own page', testId: 'design-on-page' },
            ]}
          />
          <Segmented
            ariaLabel="Computer or phone"
            value={device}
            onChange={setDevice}
            options={[
              {
                value: 'computer',
                label: 'Computer',
                icon: <Monitor className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />,
                testId: 'design-computer',
              },
              {
                value: 'phone',
                label: 'Phone',
                icon: <Smartphone className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />,
                testId: 'design-phone',
              },
            ]}
          />
        </div>
        {/* On a website: a stand-in page in the stripes a see-through form shows through. */}
        <div
          className={cn(
            'rounded-card border border-border p-4',
            where === 'website'
              ? 'bg-[repeating-linear-gradient(45deg,var(--card-2)_0_10px,var(--card)_10px_20px)]'
              : 'bg-bg',
          )}
        >
          <div className={cn('mx-auto', device === 'phone' ? 'max-w-[390px]' : 'w-full')}>
            <FormPreview
              definition={definition}
              businessColor={brand.color}
              logo={brand.logo}
              embedded={where === 'website'}
              className="mx-auto w-full max-w-[var(--form-max-width,672px)]"
            />
          </div>
        </div>
        <p className="mt-3 text-center text-[12.5px] text-text-3">
          Changes go live on your page and website when you publish.
        </p>
      </div>
    </div>
  );
}

/**
 * Match my website: the worker reads the site and hands back its button colour, words, font and corners, which land
 * in the draft as one edit, to check and change before publishing (and Undo takes it back).
 */
function MatchWebsite({
  workspaceId,
  suggested,
  matched,
  onMatched,
}: {
  workspaceId: string;
  /** The first site the form may show on, or the business's website. */
  suggested: string;
  matched: FormDesign['matched'];
  onMatched: (m: MatchedWebsite) => void;
}) {
  const [site, setSite] = useState(matched?.site ? hostOf(matched.site) : hostOf(suggested));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  async function match() {
    setBusy(true);
    setError(null);
    try {
      const out = await workerPost<MatchedWebsite>('/v1/forms/website-style', {
        workspaceId,
        ...(site.trim() ? { site: site.trim() } : {}),
      });
      onMatched(out);
      toast.success(`Matched to ${hostOf(out.site)}. Check it here, then publish.`);
      if (out.fontNote) toast.message(out.fontNote);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="space-y-3 p-4" data-testid="design-match">
      <div>
        <h3 className="text-[14px] font-medium text-text">Match my website</h3>
        <p className="mt-0.5 text-[12.5px] text-text-3">
          Copies its button colour, words, font and corners. You can change anything after.
        </p>
      </div>
      <div className="flex gap-2">
        <label htmlFor={id} className="sr-only">
          Website to match
        </label>
        <Input
          id={id}
          value={site}
          placeholder="yourwebsite.com"
          onChange={(e) => setSite(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void match();
          }}
          data-testid="design-match-site"
        />
        <Button onClick={() => void match()} loading={busy} data-testid="design-match-go">
          <Wand2 className="h-4 w-4" strokeWidth={1.75} aria-hidden />
          Match
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-[12.5px] text-danger-text">
          {error}
        </p>
      ) : matched ? (
        <Hint className="mt-0">
          Matched to {hostOf(matched.site)} on{' '}
          {new Date(matched.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}.
        </Hint>
      ) : null}
    </Card>
  );
}

/** "Use on all my forms", behind a confirmation: live forms show it straight away. */
function UseEverywhere({ onConfirm }: { onConfirm: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <Card className="flex items-center gap-3 p-4" data-testid="design-everywhere">
      <p className="min-w-0 flex-1 text-[13px] text-text-2">
        Set this look up once and use it on every form.
      </p>
      <Dialog open={open} onOpenChange={setOpen}>
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
          Use on all my forms
        </Button>
        <DialogContent
          title="Use this design on all your forms?"
          description="Your other forms take these colours, font, shape and layout, and live ones show them straight away. Nothing else about them changes. This form’s own changes still go live when you publish it."
        >
          <div className="mt-5 flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="secondary">Cancel</Button>
            </DialogClose>
            <Button
              loading={busy}
              data-testid="design-everywhere-confirm"
              onClick={async () => {
                setBusy(true);
                try {
                  await onConfirm();
                  setOpen(false);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Use on all my forms
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/** A colour token's value as a swatch shows it: the hex, or white for one worked out by the browser. */
const shownColour = (value: string | undefined): string =>
  value && /^#[0-9a-f]{6}$/i.test(value) ? value : '#ffffff';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card className="space-y-4 p-4">
      <h3 className="text-[14px] font-medium text-text">{title}</h3>
      {children}
    </Card>
  );
}

function Labelled({ title, children }: { title: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-[13px] font-medium">
        {title}
      </label>
      {children(id)}
    </div>
  );
}

/** A switch with its words beside it, the words pressable too. */
function SwitchRow(props: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  testId: string;
}) {
  return (
    <label className="flex items-center justify-between gap-3">
      <span className="text-[13px] font-medium">{props.label}</span>
      <Switch {...props} />
    </label>
  );
}

function Choice<T extends string>({
  title,
  value,
  onChange,
  options,
  testId,
  hint,
}: {
  title: string;
  value: T;
  onChange: (next: T) => void;
  options: readonly (readonly [T, string])[];
  testId: string;
  hint?: string;
}) {
  return (
    <div data-testid={testId}>
      <p className="mb-1.5 text-[13px] font-medium">{title}</p>
      <Segmented
        ariaLabel={title}
        value={value}
        onChange={onChange}
        options={options.map(([v, label]) => ({ value: v, label, testId: `${testId}-${v}` }))}
      />
      {hint ? <Hint>{hint}</Hint> : null}
    </div>
  );
}
