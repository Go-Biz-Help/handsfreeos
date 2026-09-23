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
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { CampaignPreview, PipelineList, Tag } from '@/lib/api/types';
import { people, skipWords } from './words';

/**
 * A new outreach campaign: who (tags or pipeline stages), what it's for in a line, and how fast. Nothing is sent
 * from here: the AI writes each text first, and a person reads and approves them all on the next screen.
 */
export function NewCampaign({
  workspaceId,
  tags,
  pipelines,
}: {
  workspaceId: string;
  tags: Tag[];
  pipelines: PipelineList['pipelines'];
}) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [stageIds, setStageIds] = useState<string[]>([]);
  const [perHour, setPerHour] = useState(String(CAMPAIGN_PER_HOUR_DEFAULT));
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
            body: { workspaceId, audience: { tagIds, stageIds } },
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
  }, [workspaceId, tagIds, stageIds, picked]);

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
      <Field label="Name" htmlFor="campaign-name">
        <Input
          id="campaign-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Fall tune-up"
          maxLength={120}
        />
      </Field>
      <Field
        label="What’s it for?"
        htmlFor="campaign-goal"
        hint="One line. The AI writes each person’s text from this and what they’ve had done before."
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
            <span className="font-medium">It would text {people(preview.recipients)}.</span>
            {skipped.length ? (
              <ul className="mt-1 text-[12.5px] text-text-2">
                {skipped.map(([why, n]) => (
                  <li key={why}>
                    {people(n)} left out: {skipWords(why).toLowerCase()}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>

      <Field
        label="Texts an hour"
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

      <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
        <span className="text-[12.5px] text-text-2">
          Texts only, to people who agreed to them. Nothing goes until you approve.
        </span>
        <Button
          onClick={create}
          loading={busy}
          disabled={!name.trim() || !goal.trim() || !picked || !paceOk || preview?.recipients === 0}
          data-testid="campaign-create"
        >
          Write the texts
        </Button>
      </div>
    </Card>
  );
}
