'use client';
import { Copy, ExternalLink } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { SetRow } from '@/components/settings/set-row';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { copyText } from '@/components/ui/copy-field';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { fieldErrors } from '@/lib/api/field-errors';
import type { BookingSite } from '@/lib/api/types';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { usePublicOrigin } from '@/lib/use-origin';

const slugFrom = (name: string) =>
  name
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

/** Settings → Calendars → Booking site: the public home, /book/<name>, that lists public calendars. */
export function BookingSiteForm({
  workspaceId,
  site,
  workspaceName,
  brandedOrigin,
}: {
  workspaceId: string;
  site: BookingSite | null;
  workspaceName: string;
  /** Their own domain when one is serving (M17), so the address shown here is the one to put on a van. */
  brandedOrigin: string | null;
}) {
  const router = useRouter();
  const origin = usePublicOrigin(brandedOrigin);
  useLiveRefresh(['booking_site']);
  const [name, setName] = useState(site?.name ?? workspaceName);
  const [slug, setSlug] = useState(site?.slug ?? slugFrom(workspaceName));
  const [intro, setIntro] = useState(site?.intro ?? '');
  const [enabled, setEnabled] = useState(site?.enabled ?? true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setErrors({});
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/booking_site.update', {
          body: {
            workspaceId,
            name: name.trim(),
            slug: slug.trim().toLowerCase(),
            intro: intro.trim() || null,
            enabled,
          },
        }),
      );
      toast.success(site ? 'Booking site saved.' : 'Your booking site is set up.');
      router.refresh();
    } catch (e) {
      setErrors(fieldErrors(e));
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const link = site ? `${origin}${site.path}` : null;
  return (
    <Card className="max-w-[640px] p-5 md:p-6" data-testid="booking-site">
      <h2 className="text-lg font-semibold tracking-tight">Booking site</h2>
      <p className="mt-1 text-[13px] text-text-2">
        Your public booking home. It lists every calendar customers can book online, and each has
        its own page under it.
      </p>
      {link ? (
        <div className="mt-3 flex items-center gap-2 rounded-control border border-border bg-card-2 px-3 py-2">
          <span
            className="min-w-0 flex-1 truncate font-mono text-xs"
            data-testid="booking-site-link"
          >
            {link.replace(/^https?:\/\//, '')}
          </span>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Copy the link"
            onClick={() => void copyText(link, 'Link copied')}
          >
            <Copy className="h-3.5 w-3.5" strokeWidth={1.5} />
          </Button>
          <a
            href={site!.path}
            target="_blank"
            rel="noreferrer"
            aria-label="Open the booking site"
            className="inline-flex h-8 w-8 items-center justify-center rounded-control text-text-2 hover:bg-card-3 hover:text-text"
          >
            <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.5} />
          </a>
        </div>
      ) : null}
      <div className="mt-4 flex flex-col gap-3.5">
        <Field label="Business name shown" htmlFor="site-name" error={errors.name}>
          <Input
            id="site-name"
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field
          label="Link name"
          htmlFor="site-slug"
          error={errors.slug}
          hint="Letters, numbers and dashes. Changing it later breaks links you’ve shared."
        >
          <div className="flex items-center gap-1.5">
            <span className="flex-none font-mono text-xs text-text-3">
              {origin.replace(/^https?:\/\//, '')}/book/
            </span>
            <Input
              id="site-slug"
              value={slug}
              maxLength={64}
              onChange={(e) => setSlug(e.target.value)}
            />
          </div>
        </Field>
        <Field
          label="Intro (optional)"
          htmlFor="site-intro"
          hint="A line or two at the top of the page."
        >
          <Textarea
            id="site-intro"
            value={intro}
            maxLength={2000}
            onChange={(e) => setIntro(e.target.value)}
          />
        </Field>
      </div>
      <SetRow
        center
        className="mt-2"
        title="Taking bookings online"
        description="When off, the pages say to call instead. Staff can still book from the calendar."
      >
        <Switch
          checked={enabled}
          label="Taking bookings online"
          onChange={setEnabled}
          testId="booking-site-enabled"
        />
      </SetRow>
      <div className="mt-3 flex justify-end">
        <Button
          loading={busy}
          disabled={!name.trim() || !slug.trim()}
          onClick={() => void save()}
          data-testid="booking-site-save"
        >
          {site ? 'Save' : 'Set up booking site'}
        </Button>
      </div>
    </Card>
  );
}
