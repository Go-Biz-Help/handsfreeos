'use client';
/**
 * A calendar's Design section: how its booking page looks, on its own page and on the business's website, with the
 * same choices as a form's Design tab (core's forms/design.ts) and a preview beside them. It's part of the calendar's
 * settings, so a new look goes live with Save, like any other change, and shows in its history. Nothing set (null)
 * is the business's own colour and HandsFreeOS's look, as every calendar had before.
 */
import {
  DEFAULT_FORM_DESIGN,
  FORM_DEFAULT_FONT,
  FORM_FONTS,
  formLook,
  type CalendarConfig,
  type ConfigPatch,
  type FormDesign,
  type FormDesignColors,
  type FormDesignInput,
} from '@hfos/core';
import { Clock, Monitor, Smartphone } from 'lucide-react';
import { useState } from 'react';
import {
  Choice,
  DESIGN_TOKEN,
  Labelled,
  MatchWebsite,
  Section,
  shownColour,
  SwitchRow,
  type FormBrand,
} from '@/components/forms/design-panel';
import { FormLogoMark, FormLookFrame, useFormLook } from '@/components/forms/form-look';
import { Byline } from '@/components/booking/public-shell';
import { ColorChoice } from '@/components/settings/chat-look-parts';
import { Button } from '@/components/ui/button';
import { Hint } from '@/components/ui/field';
import { Segmented } from '@/components/ui/segmented';
import { Select } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/** What each colour is called here, and what "Automatic" means for it. */
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
    hint: 'Continue, Book, and the day and time someone picks.',
  },
  { key: 'buttonText', title: 'Words on buttons', auto: 'Automatic' },
  {
    key: 'background',
    title: 'Background',
    auto: 'Automatic',
    hint: 'Automatic is white, and see-through on your website, so the calendar sits on the site’s own background.',
  },
  { key: 'text', title: 'Words', auto: 'Automatic' },
  {
    key: 'field',
    title: 'Inside the boxes',
    auto: 'Automatic',
    hint: 'The open times and the boxes people type in.',
  },
  { key: 'fieldBorder', title: 'Box outlines', auto: 'Automatic' },
  {
    key: 'error',
    title: 'Mistakes',
    auto: 'Automatic',
    hint: 'What a customer needs to fix, like a missing phone number.',
  },
];

export function CalendarDesignModule({
  workspaceId,
  draft,
  patch,
  brand,
  calendarName,
}: {
  workspaceId: string;
  draft: CalendarConfig;
  patch: (p: ConfigPatch) => void;
  brand: FormBrand;
  calendarName: string;
}) {
  const design: FormDesign = draft.design ?? DEFAULT_FORM_DESIGN;
  const [where, setWhere] = useState<'page' | 'website'>('website');
  const [device, setDevice] = useState<'computer' | 'phone'>('computer');
  const set = (p: Partial<FormDesignInput>) => patch({ design: p });
  // What "Automatic" gives right now, worked out exactly as the page does.
  const shown = formLook(design, { businessColor: brand.color }).vars;
  const fonts =
    FORM_FONTS.some((f) => f.name === design.font) || !design.font
      ? FORM_FONTS
      : [...FORM_FONTS, { name: design.font, weights: '', kind: 'sans' as const }];

  return (
    <div data-testid="calendar-design">
      <div className="mb-3">
        <h2 className="text-lg font-semibold tracking-tight">Design</h2>
        <p className="mt-1 text-[13px] text-text-2">
          How your booking page looks, on its own and on your website.
        </p>
      </div>
      <div className="grid gap-4 @2xl:grid-cols-[minmax(0,300px)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-3">
          <MatchWebsite
            workspaceId={workspaceId}
            suggested={brand.website ?? ''}
            matched={design.matched}
            onMatched={(m) => set(m.design)}
            route="/v1/calendars/website-style"
            then="Check it here, then save."
          />
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
                shownAuto={shownColour(shown[DESIGN_TOKEN[c.key]])}
                onChange={(next) => set({ colors: { [c.key]: next } })}
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
              title="Boxes people type in"
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

          <Section title="Buttons">
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
              label="As wide as the page"
              checked={design.button.fullWidth}
              onChange={(fullWidth) => set({ button: { fullWidth } })}
              testId="design-button-wide"
            />
          </Section>

          <Section title="At the top">
            <SwitchRow
              label="The calendar’s name"
              checked={design.showTitle}
              onChange={(showTitle) => set({ showTitle })}
              testId="design-title"
            />
            <SwitchRow
              label="Your logo, on your website"
              checked={design.showLogo}
              onChange={(showLogo) => set({ showLogo })}
              disabled={!brand.logo && !design.showLogo}
              testId="design-logo"
            />
            <Hint className="mt-0">
              {brand.logo
                ? 'Its own page shows your logo in the header already.'
                : 'Add your logo in Settings → Workspace to show it here.'}
            </Hint>
          </Section>

          {draft.design ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => patch({ design: null })}
              data-testid="design-reset"
            >
              Start over from your colour
            </Button>
          ) : null}
        </div>

        {/* First when there's no room beside the choices, and it stays in view while they're scrolled. */}
        <div className="order-first min-w-0 @2xl:sticky @2xl:top-4 @2xl:order-none @2xl:self-start">
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
          {/* On a website: a stand-in page in the stripes a see-through calendar shows through. */}
          <div
            className={cn(
              'rounded-card border border-border p-4',
              where === 'website'
                ? 'bg-[repeating-linear-gradient(45deg,var(--card-2)_0_10px,var(--card)_10px_20px)]'
                : 'bg-bg',
            )}
          >
            <div className={cn('mx-auto', device === 'phone' ? 'max-w-[390px]' : 'w-full')}>
              {/* Never designed: the box is painted on a website, as it always was. */}
              <FormLookFrame
                design={draft.design}
                businessColor={brand.color}
                logo={where === 'website' ? brand.logo : null}
                embedded={where === 'website' && draft.design !== null}
              >
                <BookingPreview name={calendarName} />
              </FormLookFrame>
            </div>
          </div>
          <p className="mt-3 text-center text-[12.5px] text-text-3">
            Changes go live on your booking page and website when you save.
          </p>
        </div>
      </div>
    </div>
  );
}

const DAYS = [
  ['Mon', 17],
  ['Tue', 18],
  ['Wed', 19],
  ['Thu', 20],
  ['Fri', 21],
] as const;
const TIMES = ['9:00 AM', '10:00 AM', '11:30 AM', '1:00 PM', '2:30 PM', '4:00 PM'];

/**
 * A stand-in booking page, drawn with the same parts and classes as the real one (booking-flow.tsx, time-picker.tsx),
 * so the design shows here as it will there: a day and a time picked, a box to type in, and the button.
 */
function BookingPreview({ name }: { name: string }) {
  const { showTitle, bare } = useFormLook();
  return (
    <div
      className={cn(
        'flex flex-col gap-4 rounded-card p-4 text-text',
        !bare && 'bg-[var(--form-surface)]',
      )}
      aria-hidden
      data-testid="design-preview"
    >
      <FormLogoMark className="mb-0 self-start" />
      <div className="flex flex-col gap-0.5">
        <span className="text-xs font-semibold uppercase tracking-[0.04em] text-text-3">
          Step 1 of 2
        </span>
        <h3
          className={cn('text-lg font-semibold tracking-[-0.005em]', !showTitle && 'sr-only')}
          data-testid="design-preview-name"
        >
          {name}
        </h3>
        <span className="flex items-center gap-1.5 text-[13px] text-text-2">
          <Clock size={14} aria-hidden />1 hour
        </span>
      </div>
      <div className="grid grid-cols-5 gap-1">
        {DAYS.map(([day, date], i) => {
          const on = i === 1;
          return (
            <span
              key={day}
              className={cn(
                'flex min-h-[58px] flex-col items-center gap-[3px] rounded-[10px] pb-1.5 pt-[7px]',
                on ? 'bg-accent text-white' : 'text-text',
              )}
            >
              <span className={cn('text-[11px] font-medium', on ? 'text-white/85' : 'text-text-3')}>
                {day}
              </span>
              <span className="text-base font-semibold leading-[1.1]">{date}</span>
            </span>
          );
        })}
      </div>
      <div className="grid grid-cols-3 gap-2">
        {TIMES.map((t, i) => (
          <span
            key={t}
            className={cn(
              'inline-flex h-9 items-center justify-center whitespace-nowrap rounded-control border px-1.5 text-[14.5px] font-medium',
              i === 1
                ? 'border-accent bg-accent text-white'
                : 'border-border-strong bg-card text-text',
            )}
          >
            {t}
          </span>
        ))}
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium">Your name</span>
        <input
          readOnly
          tabIndex={-1}
          value=""
          placeholder="Jordan Lee"
          className="h-10 w-full rounded-control border border-border-strong bg-card px-3 text-sm text-text placeholder:text-placeholder"
        />
      </div>
      <div className="flex flex-col">
        <Button className="w-full" tabIndex={-1} data-form-action="">
          Continue with 10:00 AM
        </Button>
      </div>
      <Byline />
    </div>
  );
}
