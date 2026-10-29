'use client';
import { CAMPAIGN_PER_HOUR_DEFAULT, CAMPAIGN_PER_HOUR_MAX } from '@hfos/core';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { TagPicker } from '@/components/crm/tag-picker';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { CampaignPreview, Offer, PipelineList, Tag } from '@/lib/api/types';
import { people, skipWords } from './words';

type Channel = 'sms' | 'email' | 'call';

/**
 * A new outreach campaign: texts, one email or AI calls, who (tags or pipeline stages), what it's for in a line,
 * and how fast. Nothing goes from here: the AI writes each text (or the one email, or how the calls open) first,
 * and a person reads and approves it on the next screen.
 */
export function NewCampaign({
  workspaceId,
  tags,
  pipelines,
  offers,
}: {
  workspaceId: string;
  tags: Tag[];
  pipelines: PipelineList['pipelines'];
  /** The offers still to run or running (Knowledge → Offers). */
  offers: Offer[];
}) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [stageIds, setStageIds] = useState<string[]>([]);
  const [perHour, setPerHour] = useState(String(CAMPAIGN_PER_HOUR_DEFAULT));
  const [offerId, setOfferId] = useState('');
  const [channel, setChannel] = useState<Channel>('sms');
  const [keepAdding, setKeepAdding] = useState(false);
  const email = channel === 'email';
  const calls = channel === 'call';
  // Only calls keep adding people; it may start with nobody to call yet.
  const adding = calls && keepAdding;
  const noun = email ? 'Emails' : calls ? 'Calls' : 'Texts';
  const [preview, setPreview] = useState<CampaignPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const picked = tagIds.length + stageIds.length > 0;
  const pace = Number(perHour);
  const paceOk = Number.isInteger(pace) && pace >= 1 && pace <= CAMPAIGN_PER_HOUR_MAX;

  // Who it would reach, as the picks change.
  useEffect(() => {
    if (!picked) {
      setPreview(null);
      return;
    }
    let stale = false;
    const t = setTimeout(async () => {
      try {
        const out = unwrap(
          await apiBrowser().POST('/v1/queries/campaign.preview_audience', {
            body: { workspaceId, audience: { tagIds, stageIds }, channel },
          }),
        );
        if (!stale) setPreview(out);
      } catch {
        if (!stale) setPreview(null);
      }
    }, 300);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [workspaceId, tagIds, stageIds, picked, channel]);

  async function create() {
    setBusy(true);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/campaign.create', {
          body: {
            workspaceId,
            name: name.trim(),
            goal: goal.trim(),
            audience: { tagIds, stageIds },
            perHour: pace,
            offerId: offerId || null,
            channel,
            keepAdding: adding,
          },
        }),
      );
      router.push(`/app/w/${workspaceId}/campaigns/${out.campaignId}`);
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(false);
    }
  }

  const skipped = Object.entries(preview?.skipped ?? {}).filter(([, n]) => n > 0);
  const openPipelines = pipelines
    .filter((p) => !p.archivedAt)
    .map((p) => ({ ...p, stages: p.stages.filter((s) => s.kind === 'open') }))
    .filter((p) => p.stages.length > 0);

  return (
    <Card className="flex max-w-2xl flex-col gap-5 p-[18px]" data-testid="campaign-new">
      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium text-text">Send as</span>
        <Segmented<Channel>
          value={channel}
          onChange={setChannel}
          ariaLabel="Send as"
          options={[
            { value: 'sms', label: 'Texts', testId: 'campaign-channel-sms' },
            { value: 'email', label: 'Email', testId: 'campaign-channel-email' },
            { value: 'call', label: 'Calls', testId: 'campaign-channel-call' },
          ]}
        />
        <span className="text-[12.5px] text-text-2">
          {email
            ? 'One email to everyone, with their first name. It goes to anyone with an email who hasn’t unsubscribed.'
            : calls
              ? 'Your AI teammate calls each person, says it’s an AI and that the call is recorded. Only to people who agreed to calls in writing.'
              : 'A text for each person, written from what they’ve had done. Only to people who agreed to texts.'}
        </span>
      </div>
      <Field label="Name" htmlFor="campaign-name">
        <Input
          id="campaign-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Fall tune-up"
          maxLength={120}
        />
      </Field>
      {offers.length ? (
        <Field
          label="About a promotion?"
          htmlFor="campaign-offer"
          hint="The AI uses the promotion’s own words and says when it ends."
        >
          <select
            id="campaign-offer"
            value={offerId}
            onChange={(e) => {
              const picked = offers.find((o) => o.id === e.target.value);
              setOfferId(e.target.value);
              if (picked && !goal.trim())
                setGoal([picked.name, picked.details].filter(Boolean).join(': ').slice(0, 500));
            }}
            className="h-10 w-full rounded-control border border-border-strong bg-card px-3 text-[15px] max-md:text-base"
            data-testid="campaign-offer"
          >
            <option value="">No promotion</option>
            {offers.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
                {o.endsOn ? ` (ends ${o.endsOn})` : ''}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      <Field
        label="What’s it for?"
        htmlFor="campaign-goal"
        hint={
          email
            ? 'One line. The AI writes the email from this; you can change every word before it goes.'
            : calls
              ? 'One line. The AI writes how every call opens from this, and talks from it on the call. You can change the opening before it starts.'
              : 'One line. The AI writes each person’s text from this and what they’ve had done before.'
        }
      >
        <Textarea
          id="campaign-goal"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="Fall tune-up special, $89 through October. Ask if they’d like a spot."
          maxLength={500}
          className="min-h-[72px]"
        />
      </Field>

      <div className="flex flex-col gap-2">
        <span className="text-[13px] font-medium text-text">Who gets it</span>
        <span className="text-[12.5px] text-text-2">
          Anyone with one of these tags, or an open deal in one of these stages.
        </span>
        <TagPicker workspaceId={workspaceId} tags={tags} selected={tagIds} onChange={setTagIds} />
        {openPipelines.map((p) => (
          <div key={p.id} className="flex flex-col gap-1.5 pt-1">
            {openPipelines.length > 1 ? (
              <span className="text-[12px] font-medium text-text-3">{p.name}</span>
            ) : null}
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {p.stages.map((s) => (
                <Checkbox
                  key={s.id}
                  label={s.name}
                  checked={stageIds.includes(s.id)}
                  onChange={(e) =>
                    setStageIds((ids) =>
                      e.target.checked ? [...ids, s.id] : ids.filter((id) => id !== s.id),
                    )
                  }
                  data-testid={`campaign-stage-${s.id}`}
                />
              ))}
            </div>
          </div>
        ))}
        {preview ? (
          <div
            className="rounded-control bg-card-2 px-3 py-2 text-[13px]"
            data-testid="campaign-preview"
          >
            <span className="font-medium">
              {adding && preview.recipients === 0
                ? 'Nobody to call yet. Anyone who comes to fit joins and is called.'
                : `It would ${email ? 'email' : calls ? 'call' : 'text'} ${people(preview.recipients)}${adding ? ' to begin with' : ''}.`}
            </span>
            {skipped.length ? (
              <ul className="mt-1 text-[12.5px] text-text-2">
                {skipped.map(([why, n]) => (
                  <li key={why}>
                    {people(n)} left out: {skipWords(why).toLowerCase()}
                  </li>
                ))}
              </ul>
            ) : null}
            {email && !preview.postalAddress ? (
              <p className="mt-1 text-[12.5px] text-warning-text" data-testid="campaign-no-address">
                Add your business address in Settings → Payments first. Every campaign email has to
                show it.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      <Field
        label={`${noun} an hour`}
        htmlFor="campaign-pace"
        hint="Only while you’re open, never in quiet hours. You can change it while it sends."
        error={paceOk ? null : `Between 1 and ${CAMPAIGN_PER_HOUR_MAX}.`}
      >
        <Input
          id="campaign-pace"
          type="number"
          inputMode="numeric"
          min={1}
          max={CAMPAIGN_PER_HOUR_MAX}
          value={perHour}
          onChange={(e) => setPerHour(e.target.value)}
          className="w-28"
        />
      </Field>

      {calls ? (
        <div className="flex flex-col gap-1">
          <Checkbox
            label="Keep adding people"
            checked={keepAdding}
            onChange={(e) => setKeepAdding(e.target.checked)}
            data-testid="campaign-keep-adding"
          />
          <span className="pl-7 text-[12.5px] text-text-2">
            Anyone who later gets one of these tags or reaches one of these stages, and agrees to
            calls in writing, joins and is called at this pace, until you stop it.
          </span>
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
        <span className="text-[12.5px] text-text-2">
          {email
            ? 'Every email has an unsubscribe link and your address. Nothing goes until you approve.'
            : calls
              ? 'Calls only, to people who agreed to them in writing. Nothing goes until you approve.'
              : 'Texts only, to people who agreed to them. Nothing goes until you approve.'}
        </span>
        <Button
          onClick={create}
          loading={busy}
          disabled={
            !name.trim() ||
            !goal.trim() ||
            !picked ||
            !paceOk ||
            (preview?.recipients === 0 && !adding) ||
            (email && preview !== null && !preview.postalAddress)
          }
          data-testid="campaign-create"
        >
          {email ? 'Write the email' : calls ? 'Plan the calls' : 'Write the texts'}
        </Button>
      </div>
    </Card>
  );
}
