'use client';
import { openHoursOf, type IndustryId, type WeeklyHours } from '@hfos/core';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { hoursProblem, WeeklyHoursEditor } from '@/components/calendars/weekly-hours';
import { IndustryPicker } from '@/components/settings/industry-picker';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { fieldErrors } from '@/lib/api/field-errors';
import type { WorkspaceGet } from '@/lib/api/types';
import { TIMEZONES } from '@/lib/time-zones';

export function WorkspaceForm({ workspace }: { workspace: WorkspaceGet['workspace'] }) {
  const router = useRouter();
  const [name, setName] = useState(workspace.name);
  const [timezone, setTimezone] = useState(workspace.timezone);
  const [industry, setIndustry] = useState(workspace.industry);
  // Workflows put these in customers' texts as {{business.website}} and {{links.review}}.
  const settings = (workspace.settings ?? {}) as Record<string, unknown>;
  const links = (
    settings.links && typeof settings.links === 'object' ? settings.links : {}
  ) as Record<string, unknown>;
  const savedWebsite = typeof settings.website === 'string' ? settings.website : '';
  const savedReview =
    typeof links.review === 'string'
      ? links.review
      : typeof settings.reviewUrl === 'string'
        ? settings.reviewUrl
        : '';
  const [website, setWebsite] = useState(savedWebsite);
  const [review, setReview] = useState(savedReview);
  // When the business is open; the AI teammate's after-hours mode and hand-off message use it.
  const savedHours = openHoursOf(settings);
  const [hours, setHours] = useState<WeeklyHours>(savedHours);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setErrors({ name: 'Give the business a name.' });
    const hoursIssue = hoursProblem(hours);
    if (hoursIssue) return setErrors({ openHours: hoursIssue });
    setBusy(true);
    setErrors({});
    try {
      const patch: {
        name?: string;
        timezone?: string;
        industry?: IndustryId;
        settings?: Record<string, unknown>;
      } = {};
      if (name.trim() !== workspace.name) patch.name = name.trim();
      if (timezone !== workspace.timezone) patch.timezone = timezone;
      if (industry !== workspace.industry) patch.industry = industry as IndustryId;
      const linksChanged = website.trim() !== savedWebsite || review.trim() !== savedReview;
      const hoursChanged = JSON.stringify(hours) !== JSON.stringify(savedHours);
      if (linksChanged || hoursChanged)
        patch.settings = {
          ...(linksChanged
            ? {
                website: website.trim() || null,
                links: { ...links, review: review.trim() || null },
              }
            : {}),
          ...(hoursChanged ? { openHours: hours } : {}),
        };
      if (Object.keys(patch).length === 0) return toast.success('Nothing changed.');
      unwrap(
        await apiBrowser().POST('/v1/commands/workspace.update', {
          body: { workspaceId: workspace.id, ...patch },
        }),
      );
      toast.success('Workspace saved.');
      router.refresh();
    } catch (err) {
      const fe = fieldErrors(err);
      if (Object.keys(fe).length) setErrors(fe);
      else toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="flex max-w-[520px] flex-col gap-4"
      noValidate
      data-testid="workspace-form"
    >
      <Field label="Business name" htmlFor="ws-name" error={errors.name}>
        <Input
          id="ws-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          invalid={!!errors.name}
        />
      </Field>
      <Field label="Time zone" htmlFor="ws-tz" hint="Due dates, “today” and “overdue” follow this.">
        <Select id="ws-tz" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
          {TIMEZONES.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
          {TIMEZONES.some(([v]) => v === timezone) ? null : (
            <option value={timezone}>{timezone}</option>
          )}
        </Select>
      </Field>
      <Field
        label="Industry"
        htmlFor="ws-industry"
        hint="Suggested add-ons and the AI teammate’s starting questions for leads follow this."
        error={errors.industry}
      >
        <IndustryPicker id="ws-industry" value={industry} onChange={setIndustry} />
      </Field>
      <Field
        label="Website"
        htmlFor="ws-website"
        hint="Workflows can put it in texts as {{business.website}}."
        error={errors.website}
      >
        <Input
          id="ws-website"
          type="url"
          inputMode="url"
          placeholder="https://yourbusiness.com"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
          invalid={!!errors.website}
          data-testid="ws-website"
        />
      </Field>
      <Field
        label="Review link (Google Business Profile)"
        htmlFor="ws-review"
        hint="Where happy customers leave a review. The review recipe texts it as {{links.review}}."
        error={errors.review}
      >
        <Input
          id="ws-review"
          type="url"
          inputMode="url"
          placeholder="https://g.page/r/your-business/review"
          value={review}
          onChange={(e) => setReview(e.target.value)}
          invalid={!!errors.review}
          data-testid="ws-review"
        />
      </Field>
      <fieldset className="flex min-w-0 flex-col gap-1.5" data-testid="ws-open-hours">
        <legend className="text-[13px] font-medium">Business hours</legend>
        <p className="text-xs text-text-2">
          When you’re open, in the time zone above. Your AI teammate uses it to work after hours and
          to tell customers when they’ll hear back.
        </p>
        <div className="rounded-control border border-border px-3 py-1">
          <WeeklyHoursEditor value={hours} onChange={setHours} idPrefix="ws-hours" />
        </div>
        {errors.openHours ? (
          <span role="alert" className="text-xs text-danger-text">
            {errors.openHours}
          </span>
        ) : null}
      </fieldset>
      <div className="flex justify-end">
        <Button type="submit" loading={busy} data-testid="workspace-save">
          Save changes
        </Button>
      </div>
    </form>
  );
}
