'use client';
import { formLook, type FormDesign } from '@hfos/core';
import { createContext, useContext, type CSSProperties, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** A business's logo where anyone can see it (the worker's PublicLook). */
export interface FormLogo {
  readonly url: string;
  readonly width: number;
  readonly height: number;
}

interface FormLookValue {
  /** Each question's words inside its box (boxes people type in only). */
  readonly labelsInside: boolean;
  /** Painted with the form's own background and a border, or see-through on a website. */
  readonly bare: boolean;
  /** The logo to show at the top, when the design asks for it and the business has one. */
  readonly logo: FormLogo | null;
  /** The form's name at the top; hidden, it's still there for screen readers. */
  readonly showTitle: boolean;
  /** A dark form, for parts drawn by others (Cloudflare's check) to match. */
  readonly dark: boolean;
}

const FormLookContext = createContext<FormLookValue>({
  labelsInside: false,
  bare: false,
  logo: null,
  showTitle: true,
  dark: false,
});

export const useFormLook = (): FormLookValue => useContext(FormLookContext);

/**
 * A form in its design (core's forms/design.ts): the public page and the editor's preview both sit in this, so the
 * preview is what goes live. It sets every colour token the form's parts use, the corners, the font and the rest,
 * and globals.css (`.form-look`) reads its data attributes for the field and button styles.
 */
export function FormLookFrame({
  design,
  businessColor = null,
  logo = null,
  embedded = false,
  className,
  children,
}: {
  design: FormDesign | null | undefined;
  /** The business's own colour; null for HandsFreeOS's blue. */
  businessColor?: string | null;
  logo?: FormLogo | null;
  /** On someone else's website (`?embed=1`). */
  embedded?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const look = formLook(design, { businessColor, embedded });
  return (
    <FormLookContext.Provider
      value={{
        labelsInside: look.labelsInside,
        bare: !look.paintsBackground,
        logo: look.showLogo ? logo : null,
        showTitle: look.showTitle,
        dark: look.dark,
      }}
    >
      {/* React puts a stylesheet link in the page's head, once however many forms ask for it. */}
      {look.fontHref ? <link rel="stylesheet" href={look.fontHref} precedence="form-font" /> : null}
      <div
        className={cn('form-look', className)}
        style={look.vars as CSSProperties}
        {...look.data}
        data-testid="form-look"
      >
        {children}
      </div>
    </FormLookContext.Provider>
  );
}

/** The panel the form sits on: its own background and a border, or nothing at all on a website without one. */
export function FormSurface({
  className,
  children,
  ...props
}: { className?: string; children: ReactNode } & Record<`data-${string}`, string>) {
  const { bare } = useFormLook();
  return (
    <div
      className={cn(
        'rounded-card',
        bare ? 'px-1 py-2' : 'border border-border bg-[var(--form-surface)] shadow-1',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

/** The business's logo above the form's heading, when the design shows it. */
export function FormLogoMark() {
  const { logo } = useFormLook();
  if (!logo) return null;
  // At most 48 high and 220 across, its shape kept.
  const scale = Math.min(48 / logo.height, 220 / logo.width, 1);
  // Storage's public address: plain <img>, nothing for an image optimizer to keep.
  return (
    <img
      src={logo.url}
      alt=""
      width={Math.round(logo.width * scale)}
      height={Math.round(logo.height * scale)}
      className="mb-4"
      data-testid="form-logo"
    />
  );
}

/**
 * The top of a form: the logo, its name and its intro, as the design shows them. A hidden name stays for screen
 * readers; with nothing showing at all, the top takes no room (globals.css drops the gap under it).
 */
export function FormHead({
  title,
  intro,
  heading: Heading = 'h1',
  titleClassName,
  introClassName,
}: {
  title: string;
  intro: string | null | undefined;
  heading?: 'h1' | 'h2';
  titleClassName: string;
  introClassName: string;
}) {
  const { logo, showTitle } = useFormLook();
  const shown = Boolean(logo) || showTitle || Boolean(intro);
  return (
    <div className={cn(!shown && 'sr-only')} data-form-head="">
      <FormLogoMark />
      <Heading className={cn(titleClassName, !showTitle && 'sr-only')}>{title}</Heading>
      {intro ? (
        <p className={cn('whitespace-pre-wrap', introClassName, !showTitle && 'mt-0')}>{intro}</p>
      ) : null}
    </div>
  );
}
