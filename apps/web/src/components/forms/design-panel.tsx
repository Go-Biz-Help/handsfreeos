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
import { Monitor, Smartphone } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { ColorChoice } from '@/components/settings/chat-look-parts';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Hint } from '@/components/ui/field';
import { Select } from '@/components/ui/input';
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
}

/** What each colour is called on the tab, and what "Automatic" means for it. */
const COLOURS: readonly {
  key: keyof FormDesignColors;
  title: string;
  auto: string;
  hint?: string;
}[] = [
  { key: 'button', title: 'Buttons', auto: 'Your colour', hint: 'Send, Next, and the answer someone picks.' },
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
  { key: 'error', title: 'Mistakes', auto: 'Automatic', hint: '“Answer this one” and the stars on questions that need an answer.' },
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
  definition,
  apply,
  readOnly,
  brand,
}: {
  definition: FormDefinition;
  apply: (ops: FormOp[]) => void;
  readOnly: boolean;
  brand: FormBrand;
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
  const fonts = FORM_FONTS.some((f) => f.name === design.font) || !design.font
    ? FORM_FONTS
    : [...FORM_FONTS, { name: design.font, weights: '', kind: 'sans' as const }];

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]" data-testid="form-design">
      <div className="min-w-0 space-y-3">
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
          <Switch
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
          <Switch
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
