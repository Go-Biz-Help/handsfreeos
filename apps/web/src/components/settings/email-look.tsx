'use client';
/**
 * Settings → Email → How your emails look (HANDSFREEOS_DESIGN_TOOLS_IMPLEMENTATION_PLAN.md, part 5): a band of the
 * business's colour across the top, its logo on the left or in the centre, and a footer with its address, phone,
 * website and social links. The automatic emails (confirmations, reminders, invoices) and campaigns all use it. The
 * preview is the same HTML the worker sends (core's look/email.ts), drawn in a frame that runs nothing. Kept in the
 * brand kit by `look.set`; Back to the usual look puts emails back as they were.
 */
import {
  emailHtml,
  LOOK_EMAIL_LOGO,
  type BusinessLook,
  type EmailContact,
  type LookEmailLayout,
} from '@hfos/core';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { FieldError, Hint } from '@/components/ui/field';
import { Segmented } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import { errorMessage } from '@/lib/api/client';
import { logoSrc } from '@/lib/look';
import { lookActions } from '@/lib/look-actions';
import { Section } from './email-addresses';

/** What a business that hasn't picked starts from: the band, the logo on the left and the footer. */
const START: LookEmailLayout = { band: true, logo: 'left', footer: true };
const LOGO_WORDS: Record<(typeof LOOK_EMAIL_LOGO)[number], string> = {
  left: 'Left',
  center: 'Centre',
};

/** The email the preview shows: a booking confirmation, with its two links as buttons. */
const sampleEmail = (name: string) =>
  [
    'Hi Sam,',
    `Thanks for booking with ${name || 'us'}. You’re all set for Tuesday at 10:00 AM.`,
    'Change or cancel: https://example.com/b/change\nAdd it to your calendar: https://example.com/b/calendar',
    'See you then!',
  ].join('\n\n');

const same = (a: LookEmailLayout | null, b: LookEmailLayout | null) =>
  a?.band === b?.band && a?.logo === b?.logo && a?.footer === b?.footer;

export function EmailLookCard({
  workspaceId,
  look,
  name,
  contact,
  canChange,
  onChanged,
}: {
  workspaceId: string;
  look: BusinessLook;
  name: string;
  /** What the footer shows; null while it couldn't be read. */
  contact: EmailContact | null;
  /** Kept in the brand kit: whoever may change the business. */
  canChange: boolean;
  onChanged: () => void;
}) {
  const actions = useMemo(() => lookActions(workspaceId), [workspaceId]);
  const saved: LookEmailLayout | null = look.email
    ? { band: look.email.band, logo: look.email.logo, footer: look.email.footer }
    : null;
  const [draft, setDraft] = useState<LookEmailLayout>(saved ?? START);
  const [busy, setBusy] = useState<'save' | 'usual' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dirty = !same(draft, saved);
  const change = (patch: Partial<LookEmailLayout>) => setDraft((d) => ({ ...d, ...patch }));

  const html = useMemo(
    () =>
      emailHtml(sampleEmail(name), {
        name,
        look: {
          logo: look.logo
            ? { url: logoSrc(look.logo.path), width: look.logo.width, height: look.logo.height }
            : null,
          color: look.color?.hex ?? null,
          corners: look.corners?.value ?? null,
        },
        layout: draft,
        contact,
      }),
    [draft, look, name, contact],
  );

  async function keep(email: LookEmailLayout | null, which: 'save' | 'usual') {
    setBusy(which);
    setError(null);
    try {
      await actions.setKit({ email });
      toast.success(email ? 'Your emails’ look is saved' : 'Emails are back to the usual look', {
        id: 'email-look',
      });
      if (!email) setDraft(START);
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const missing = [
    !contact?.address.length ? 'an address (Settings → Payments)' : null,
    !contact?.website ? 'a website (Settings → Workspace)' : null,
    !contact?.socials.length ? 'social links (Settings → Workspace → Brand kit)' : null,
  ].filter(Boolean);

  return (
    <Section
      title="How your emails look"
      setting="email.look"
      description={
        <>
          The emails we send for you on our own (confirmations, reminders, invoices) and your
          campaigns. Your logo and colour come from your{' '}
          <Link
            href={`/app/w/${workspaceId}/settings/workspace#logo-and-colour`}
            className="font-medium text-accent-text hover:underline"
          >
            brand kit
          </Link>
          . Emails you write yourself stay plain, like any email.
        </>
      }
    >
      <div
        className="mt-4 grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)]"
        data-testid="email-look"
      >
        <div className="flex flex-col gap-4">
          <label className="flex items-center justify-between gap-3 text-[13px] font-medium">
            <span>Colour band across the top</span>
            <Switch
              checked={draft.band}
              onChange={(band) => change({ band })}
              label="Colour band across the top"
              disabled={!canChange}
              testId="email-look-band"
            />
          </label>
          <div>
            <p className="mb-1.5 text-[13px] font-medium">Logo</p>
            <Segmented
              ariaLabel="Logo"
              value={draft.logo}
              onChange={(logo) => canChange && change({ logo })}
              options={LOOK_EMAIL_LOGO.map((l) => ({
                value: l,
                label: LOGO_WORDS[l],
                testId: `email-look-logo-${l}`,
              }))}
            />
            {!look.logo ? (
              <Hint>No logo yet, so your business name stands in. Add one in your brand kit.</Hint>
            ) : null}
          </div>
          <div>
            <label className="flex items-center justify-between gap-3 text-[13px] font-medium">
              <span>Footer with your address, phone, website and social links</span>
              <Switch
                checked={draft.footer}
                onChange={(footer) => change({ footer })}
                label="Footer with your address, phone, website and social links"
                disabled={!canChange}
                testId="email-look-footer"
              />
            </label>
            {draft.footer && missing.length ? (
              <Hint>It leaves out what you haven’t added yet: {missing.join(', ')}.</Hint>
            ) : null}
          </div>
          <Hint className="mt-0">
            A line in an automatic email like “Pay your invoice: https://…” shows as a button in
            your colour.
          </Hint>
          {canChange ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                onClick={() => void keep(draft, 'save')}
                disabled={!dirty || busy !== null}
                loading={busy === 'save'}
                data-testid="email-look-save"
              >
                {saved ? 'Save' : 'Use this look'}
              </Button>
              {saved ? (
                <Button
                  variant="ghost"
                  onClick={() => void keep(null, 'usual')}
                  disabled={busy !== null}
                  loading={busy === 'usual'}
                  data-testid="email-look-usual"
                >
                  Back to the usual look
                </Button>
              ) : (
                <span className="text-[12.5px] text-text-3">
                  Until you save, emails keep the usual look.
                </span>
              )}
            </div>
          ) : (
            <Hint>Ask an owner of this business to change how emails look.</Hint>
          )}
          <FieldError>{error}</FieldError>
        </div>
        <div className="overflow-hidden rounded-card border border-border bg-[#f3f4f6]">
          <p className="border-b border-border bg-card px-3 py-2 text-[12px] text-text-3">
            Preview: a booking confirmation, as your customers get it
          </p>
          <iframe
            title="Preview of an email"
            srcDoc={html}
            sandbox=""
            className="block h-[540px] w-full bg-[#f3f4f6]"
            data-testid="email-look-preview"
          />
        </div>
      </div>
    </Section>
  );
}
