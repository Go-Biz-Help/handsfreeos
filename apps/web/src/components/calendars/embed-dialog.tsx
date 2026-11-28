'use client';
/**
 * A calendar on the business's own website (the owner, 2026-11-18: an embed like forms have). From the calendar's
 * Booking link card: the sites allowed to show it, and the code to paste, either for a box in the page where the
 * calendar should go or for a pop-up a button opens (design tools, part 3). The codes are core's
 * (`bookingEmbedSnippet`, `popupSnippet`), which the Assistant hands out too. Sites save when the box loses focus, as
 * a form's Share tab saves them, and the list is also what stops anybody else framing the booking page.
 */
import { bookingEmbedSnippet, type PopupButtonLook } from '@hfos/core';
import { AlertTriangle, Code2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { PopupEmbed } from '@/components/look/popup-embed';
import { Button } from '@/components/ui/button';
import { CopyField } from '@/components/ui/copy-field';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { useOrigin } from '@/lib/use-origin';

const typedSites = (text: string): string[] =>
  text
    .split(/[\s,]+/)
    .map((o) => o.trim())
    .filter(Boolean);

/** "https://www.acme.com" → "www.acme.com": how people type a site. */
const shown = (origins: readonly string[]) =>
  origins.map((o) => o.replace(/^https:\/\//, '')).join(', ');

export function CalendarEmbed({
  workspaceId,
  calendarId,
  calendarName,
  bookingUrl,
  embedOrigins,
  bookingSiteHref,
  popupLook = null,
}: {
  workspaceId: string;
  calendarId: string;
  calendarName: string;
  /** The calendar's whole booking link (on the business's own domain when one is serving); null with no booking site. */
  bookingUrl: string | null;
  embedOrigins: readonly string[];
  /** Settings → Calendars → Booking site, for a business that hasn't set one up. */
  bookingSiteHref: string;
  /** The booking page's own button colour, words and corners, for the pop-up's button. */
  popupLook?: PopupButtonLook | null;
}) {
  const [open, setOpen] = useState(false);
  const [how, setHow] = useState<'page' | 'popup'>('page');
  const [saved, setSaved] = useState<readonly string[]>(embedOrigins);
  const [typed, setTyped] = useState(shown(embedOrigins));
  const [saving, setSaving] = useState(false);
  // The script line loads from the app's own address: a business's domain serves its pages, not our scripts.
  const appOrigin = useOrigin();

  async function save() {
    const sites = typedSites(typed);
    if (sites.join(',') === typedSites(shown(saved)).join(',')) return;
    setSaving(true);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/calendar.set_embed_sites', {
          body: { workspaceId, calendarId, embedOrigins: sites },
        }),
      );
      // As saved: exact addresses, with the www (or bare) version added for each.
      setSaved(out.embedOrigins);
      setTyped(shown(out.embedOrigins));
      toast.success(out.embedOrigins.length ? 'Saved.' : 'Saved. It isn’t shown on any site now.');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        data-testid="builder-embed-open"
      >
        <Code2 className="h-3.5 w-3.5" strokeWidth={1.5} />
        Embed
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          title="Put it on your website"
          description="Customers book right on your site, without leaving it."
          className="w-[min(560px,calc(100vw-32px))]"
        >
          {bookingUrl ? (
            <div className="mt-3 flex flex-col gap-4" data-testid="calendar-embed">
              <Field
                label="Sites allowed to show it"
                htmlFor="calendar-embed-sites"
                hint="Like example.com, with commas between them. The www version is added for you. It only shows on these sites."
              >
                <Input
                  id="calendar-embed-sites"
                  placeholder="example.com"
                  value={typed}
                  disabled={saving}
                  onChange={(e) => setTyped(e.target.value)}
                  onBlur={() => void save()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void save();
                    }
                  }}
                  data-testid="calendar-embed-sites"
                />
              </Field>
              {saved.length ? null : (
                <p
                  className="flex items-start gap-2 rounded-control bg-warning-soft px-3 py-2 text-[12.5px] text-warning-text"
                  data-testid="calendar-embed-none"
                >
                  <AlertTriangle className="mt-px h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
                  Add your website above first. Until it’s listed, the calendar shows as a blank box
                  there.
                </p>
              )}
              <Segmented
                ariaLabel="How it shows"
                value={how}
                onChange={setHow}
                options={[
                  { value: 'page', label: 'In the page', testId: 'calendar-embed-in-page' },
                  { value: 'popup', label: 'Pop-up', testId: 'calendar-embed-popup' },
                ]}
              />
              {how === 'page' ? (
                <div className="flex flex-col gap-1.5">
                  <span className="text-[13px] font-medium">The code to paste</span>
                  <CopyField
                    value={bookingEmbedSnippet({ bookingUrl, appOrigin, name: calendarName })}
                    label="Copy the code"
                    copied="Copied the code"
                  />
                  <p className="text-[12.5px] text-text-3">
                    Paste it where the calendar should go, in an HTML or embed block. The box grows
                    and shrinks to fit. Payments and Change or cancel open in a new tab.
                  </p>
                </div>
              ) : (
                <PopupEmbed
                  url={bookingUrl}
                  appOrigin={appOrigin}
                  name={calendarName}
                  defaultLabel="Book now"
                  look={popupLook}
                  testId="calendar-popup"
                />
              )}
            </div>
          ) : (
            <div
              className="mt-3 flex flex-col gap-2 text-[13px]"
              data-testid="calendar-embed-no-site"
            >
              <p className="text-text-2">
                A calendar goes on your website from its booking link, and it gets one once the
                booking site is set up.
              </p>
              <Link
                href={bookingSiteHref}
                className="w-fit font-medium text-accent-text hover:underline"
              >
                Set up the booking site
              </Link>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
