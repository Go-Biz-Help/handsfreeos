'use client';
/**
 * A calendar's Design section: how its booking page looks, on its own page and on the business's website, with the
 * same choices as a form's Design tab (core's forms/design.ts) and a preview beside them. It's part of the calendar's
 * settings, so a new look goes live with Save, like any other change, and shows in its history. Nothing set (null)
 * is the business's own colour and HandsFreeOS's look, as every calendar had before.
 *
 * Design tools, part 3: the width and spacing forms have, a picture across the top, each person's photo where
 * customers pick who comes (kept on the calendar's team), and Use on all my calendars, which puts the saved design on
 * every other calendar (calendar.use_design_everywhere).
 */
import {
  DEFAULT_FORM_DESIGN,
  designCornersOf,
  FORM_FONTS,
  formLook,
  type CalendarConfig,
  type ConfigPatch,
  type FormDesign,
  type FormDesignColors,
  type FormDesignInput,
  type PictureRef,
} from '@hfos/core';
import { Clock, Monitor, Smartphone } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  Choice,
  DESIGN_TOKEN,
  FontSelect,
  KitNote,
  Labelled,
  MatchWebsite,
  Section,
  shownColour,
  SwitchRow,
  type FormBrand,
} from '@/components/forms/design-panel';
import { FormCover, FormLogoMark, FormLookFrame, useFormLook } from '@/components/forms/form-look';
import { PicturePicker } from '@/components/look/picture-picker';
import { Byline } from '@/components/booking/public-shell';
import { ColorChoice } from '@/components/settings/chat-look-parts';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogClose, DialogContent } from '@/components/ui/dialog';
import { Hint } from '@/components/ui/field';
import { Segmented } from '@/components/ui/segmented';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { pictureSrc } from '@/lib/look';
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

/** Someone on the calendar's team, by name. */
export interface DesignPerson {
  readonly userId: string;
  readonly fullName: string;
}

export function CalendarDesignModule({
  workspaceId,
  draft,
  patch,
  brand,
  calendarName,
  calendarId,
  saved,
  people = [],
}: {
  workspaceId: string;
  draft: CalendarConfig;
  patch: (p: ConfigPatch) => void;
  brand: FormBrand;
  calendarName: string;
  /** The calendar, for Use on all my calendars; left out, that isn't offered (a calendar not saved yet). */
  calendarId?: string;
  /** Its saved design, which Use on all my calendars copies. */
  saved?: FormDesign | null;
  /** The business's team, for the names of the people on this calendar. */
  people?: readonly DesignPerson[];
}) {
  const design: FormDesign = draft.design ?? DEFAULT_FORM_DESIGN;
  const nameOf = (id: string) => people.find((p) => p.userId === id)?.fullName ?? 'Someone';
  const members = draft.team.members;
  const setPhoto = (userId: string, picture: PictureRef | null) =>
    patch({
      team: { members: members.map((m) => (m.userId === userId ? { ...m, picture } : m)) },
    });
  const [where, setWhere] = useState<'page' | 'website'>('website');
  const [device, setDevice] = useState<'computer' | 'phone'>('computer');
  const set = (p: Partial<FormDesignInput>) => patch({ design: p });
  // What "Automatic" gives right now, worked out exactly as the page does.
  const shown = formLook(design, { businessColor: brand.color, kit: brand.kit }).vars;
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
                <FontSelect
                  id={id}
                  value={design.font}
                  kit={brand.kit}
                  fonts={fonts}
                  onChange={(font) => set({ font })}
                />
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
              value={designCornersOf(design, brand.kit)}
              onChange={(corners) => set({ corners })}
              options={[
                ['square', 'Square'],
                ['slight', 'Slightly round'],
                ['round', 'Round'],
              ]}
              testId="design-corners"
            />
            <KitNote
              following={design.corners === null}
              onFollow={() => set({ corners: null })}
              testId="design-corners-kit"
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

          <Section title="Layout">
            <Choice
              title="Space between parts"
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
              hint="The open times get wider than the details, so a week of times fits on a computer."
            />
          </Section>

          <Section title="Pictures">
            <Labelled title="Across the top">
              {() => (
                <PicturePicker
                  workspaceId={workspaceId}
                  label="Picture across the top"
                  value={design.cover}
                  canUpload
                  testId="design-cover"
                  onChange={(cover) => set({ cover })}
                />
              )}
            </Labelled>
            <Hint className="mt-0">
              On the first step, above the calendar’s name. A team photo or your truck works well.
            </Hint>
            {members.length ? (
              <div className="flex flex-col gap-2.5" data-testid="design-people">
                <span className="text-[13px] font-medium">Each person’s photo</span>
                {members.map((m) => (
                  <div key={m.userId} className="flex items-center gap-3">
                    <PicturePicker
                      workspaceId={workspaceId}
                      label={`${nameOf(m.userId)}’s photo`}
                      value={m.picture}
                      canUpload
                      compact
                      testId="design-person-photo"
                      onChange={(picture) => setPhoto(m.userId, picture)}
                    />
                    <span className="min-w-0 truncate text-[13px]">{nameOf(m.userId)}</span>
                  </div>
                ))}
                <Hint className="mt-0">
                  {draft.team.assignment === 'customer_choice'
                    ? 'Shown beside their name where customers pick who comes.'
                    : 'Shown beside their name when customers pick who comes (Team → How people are assigned → Customer picks).'}
                </Hint>
              </div>
            ) : null}
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

          {calendarId ? (
            <UseOnAllCalendars
              workspaceId={workspaceId}
              calendarId={calendarId}
              unsaved={JSON.stringify(draft.design) !== JSON.stringify(saved ?? null)}
            />
          ) : null}

          {draft.design ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => patch({ design: null })}
              data-testid="design-reset"
            >
              Start over from your brand kit
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
                kit={brand.kit}
                logo={where === 'website' ? brand.logo : null}
                embedded={where === 'website' && draft.design !== null}
              >
                <BookingPreview
                  name={calendarName}
                  faces={
                    draft.team.assignment === 'customer_choice'
                      ? members
                          .filter((m) => m.picture)
                          .map((m) => ({ name: nameOf(m.userId), picture: m.picture! }))
                      : []
                  }
                />
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
function BookingPreview({
  name,
  faces,
}: {
  name: string;
  faces: readonly { name: string; picture: PictureRef }[];
}) {
  const { showTitle, bare } = useFormLook();
  return (
    <div
      className={cn(
        'mx-auto flex w-full max-w-[var(--booking-max-width,860px)] flex-col gap-[var(--booking-gap,1rem)] rounded-card p-4 text-text',
        !bare && 'bg-[var(--form-surface)]',
      )}
      aria-hidden
      data-testid="design-preview"
    >
      <FormCover />
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
      {faces.length ? (
        <div className="flex flex-wrap gap-2" data-testid="design-preview-faces">
          {faces.map((f) => (
            <span
              key={f.picture.path + f.name}
              className="inline-flex items-center gap-2 rounded-[10px] border border-border-strong bg-card py-1.5 pl-1.5 pr-3 text-[13px] font-medium"
            >
              <img
                src={pictureSrc(f.picture.path)}
                alt=""
                className="h-8 w-8 rounded-full object-cover"
              />
              {f.name}
            </span>
          ))}
        </div>
      ) : null}
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

/**
 * Use on all my calendars, behind a confirmation: the saved design goes on every other calendar, each as a new
 * revision. A design changed here and not saved yet asks for Save first, since it's the saved one that's copied.
 */
function UseOnAllCalendars({
  workspaceId,
  calendarId,
  unsaved,
}: {
  workspaceId: string;
  calendarId: string;
  unsaved: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  async function confirm() {
    setBusy(true);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/calendar.use_design_everywhere', {
          body: { workspaceId, calendarId },
        }),
      );
      const n = out.calendarIds.length;
      toast.success(
        n === 0
          ? 'Your other calendars look like this already.'
          : `${n === 1 ? '1 other calendar uses' : `${n} other calendars use`} this design now.`,
      );
      setOpen(false);
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="flex flex-col gap-2 p-4" data-testid="design-everywhere">
      <div className="flex items-center gap-3">
        <p className="min-w-0 flex-1 text-[13px] text-text-2">
          Set this look up once and use it on every calendar.
        </p>
        <Dialog open={open} onOpenChange={setOpen}>
          <Button
            variant="secondary"
            size="sm"
            disabled={unsaved}
            onClick={() => setOpen(true)}
            data-testid="design-everywhere-open"
          >
            Use on all my calendars
          </Button>
          <DialogContent
            title="Use this design on all your calendars?"
            description="Your other calendars take these colours, font, shape, layout and picture across the top, and their booking pages show them straight away. Each one saves it as a change you can undo from its History. Each person’s photo stays with its own calendar."
          >
            <div className="mt-5 flex justify-end gap-2">
              <DialogClose asChild>
                <Button variant="secondary">Cancel</Button>
              </DialogClose>
              <Button
                loading={busy}
                onClick={() => void confirm()}
                data-testid="design-everywhere-confirm"
              >
                Use on all my calendars
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>
      {unsaved ? (
        <Hint className="mt-0" data-testid="design-everywhere-save-first">
          Save this calendar first. It’s the saved design that goes on the others.
        </Hint>
      ) : null}
    </Card>
  );
}
