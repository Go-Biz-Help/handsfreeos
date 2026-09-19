'use client';
/**
 * Settings → Lead intake (M14). Each way a stranger reaches the business is a row that saves the moment it
 * is flipped: whether they become a customer and a lead at all, which pipeline that lead lands in, what it
 * is filed under, and the most a day — the limit that keeps a robocall storm out of the pipeline.
 */
import { MailIcon, MessageSquare, PhoneMissed } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { cn, relativeTime } from '@/lib/utils';
import { SetRow } from './set-row';

export type IntakeChannel = 'text' | 'call' | 'email';

export interface IntakeSourceRow {
  readonly kind: IntakeChannel;
  readonly name: string;
  readonly active: boolean;
  readonly createLead: boolean;
  readonly pipelineId: string | null;
  readonly stageId: string | null;
  readonly dailyCap: number;
  readonly todayCount: number;
  readonly lastIntakeAt: string | null;
}

export interface IntakePipeline {
  readonly id: string;
  readonly name: string;
  readonly stages: readonly { readonly id: string; readonly name: string; readonly kind: string }[];
}

const CHANNELS: Record<
  IntakeChannel,
  { title: string; description: string; icon: typeof MessageSquare }
> = {
  text: {
    title: 'Someone texts your number',
    description:
      'A number you don’t have writes in. A STOP or a HELP is an instruction, not a lead, and your own numbers never count.',
    icon: MessageSquare,
  },
  call: {
    title: 'Someone calls and doesn’t get through',
    description:
      'A missed call or a voicemail from a number you don’t have. A call you answered is yours to file.',
    icon: PhoneMissed,
  },
  email: {
    title: 'Someone emails your business address',
    description:
      'A sender you don’t have writes in. Bounces, out-of-office replies and newsletters are left out of it.',
    icon: MailIcon,
  },
};

export function LeadIntakeSettings({
  workspaceId,
  sources,
  pipelines,
}: {
  workspaceId: string;
  sources: readonly IntakeSourceRow[];
  pipelines: readonly IntakePipeline[];
}) {
  const [rows, setRows] = useState<readonly IntakeSourceRow[]>(sources);
  const saving = useRef(false);

  async function save(kind: IntakeChannel, patch: Partial<IntakeSourceRow>, done?: string) {
    const before = rows;
    setRows((r) => r.map((s) => (s.kind === kind ? { ...s, ...patch } : s)));
    if (saving.current) return;
    saving.current = true;
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/intake_source.update', {
          body: { workspaceId, kind, ...patch },
        }),
      );
      if (done) toast.success(done);
    } catch (e) {
      setRows(before);
      toast.error(errorMessage(e));
    } finally {
      saving.current = false;
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <Card className="px-4 py-1">
        {rows.map((s, i) => {
          const channel = CHANNELS[s.kind];
          const Icon = channel.icon;
          const pipeline = pipelines.find((p) => p.id === s.pipelineId) ?? null;
          return (
            <div key={s.kind} className={cn(i > 0 && 'border-t border-border')}>
              <SetRow
                first
                center
                title={
                  <span className="flex items-center gap-2">
                    <Icon aria-hidden className="size-4 text-text-3" />
                    {channel.title}
                  </span>
                }
                description={channel.description}
              >
                <Switch
                  checked={s.active}
                  label={channel.title}
                  testId={`intake-${s.kind}`}
                  onChange={(active) =>
                    void save(
                      s.kind,
                      { active },
                      active ? 'New leads will come in here.' : 'Left as a conversation only.',
                    )
                  }
                />
              </SetRow>
              {s.active ? (
                <div className="flex flex-col gap-3 pb-4 pl-6">
                  <label className="flex items-center gap-2 text-[13px]">
                    <Switch
                      checked={s.createLead}
                      label="Open a lead"
                      onChange={(createLead) =>
                        void save(
                          s.kind,
                          { createLead },
                          createLead ? 'A lead opens too.' : 'The customer is made; no lead.',
                        )
                      }
                    />
                    Open a lead as well as the customer
                  </label>
                  {s.createLead ? (
                    <div className="flex flex-wrap items-center gap-2 text-[13px] text-text-2">
                      <span>Leads land in</span>
                      <Select
                        selectSize="sm"
                        className="w-auto"
                        aria-label={`Pipeline for ${channel.title}`}
                        value={s.pipelineId ?? ''}
                        onChange={(e) =>
                          void save(
                            s.kind,
                            { pipelineId: e.target.value || null, stageId: null },
                            'Saved.',
                          )
                        }
                      >
                        <option value="">Your first pipeline</option>
                        {pipelines.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </Select>
                      {pipeline ? (
                        <Select
                          selectSize="sm"
                          className="w-auto"
                          aria-label={`Stage for ${channel.title}`}
                          value={s.stageId ?? ''}
                          onChange={(e) =>
                            void save(s.kind, { stageId: e.target.value || null }, 'Saved.')
                          }
                        >
                          <option value="">Its first open stage</option>
                          {pipeline.stages
                            .filter((st) => st.kind === 'open')
                            .map((st) => (
                              <option key={st.id} value={st.id}>
                                {st.name}
                              </option>
                            ))}
                        </Select>
                      ) : null}
                      <span>, filed under</span>
                      <NameField
                        value={s.name}
                        onSave={(name) => void save(s.kind, { name }, 'Saved.')}
                      />
                    </div>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-2 text-[13px] text-text-2">
                    <span>At most</span>
                    <Input
                      inputSize="sm"
                      type="number"
                      min={1}
                      max={1000}
                      className="w-20"
                      aria-label={`Daily limit for ${channel.title}`}
                      defaultValue={s.dailyCap}
                      onBlur={(e) => {
                        const dailyCap = Math.max(1, Math.min(1000, Number(e.target.value) || 1));
                        e.target.value = String(dailyCap);
                        if (dailyCap !== s.dailyCap) void save(s.kind, { dailyCap }, 'Saved.');
                      }}
                    />
                    <span>a day.</span>
                    <span className="text-text-3">
                      {s.todayCount} so far today
                      {s.lastIntakeAt ? ` · last ${relativeTime(s.lastIntakeAt)}` : ''}
                    </span>
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </Card>
      <p className="max-w-[640px] text-xs text-text-3">
        Someone who hasn’t said their name yet is filed under their number or address, and your AI
        teammate writes their real name over it the moment they give it. Someone already in your
        customers is linked to their record instead, and no second lead opens.
      </p>
    </div>
  );
}

/** The source's name, saved when you leave the box. */
function NameField({ value, onSave }: { value: string; onSave: (next: string) => void }) {
  return (
    <Input
      inputSize="sm"
      className="w-40"
      aria-label="What its leads are filed under"
      defaultValue={value}
      maxLength={60}
      onBlur={(e) => {
        const next = e.target.value.trim();
        if (!next) {
          e.target.value = value;
          return;
        }
        if (next !== value) onSave(next);
      }}
    />
  );
}
