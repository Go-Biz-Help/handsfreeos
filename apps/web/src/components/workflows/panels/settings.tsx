'use client';
import { formatClock, type StopOn, type WorkflowSettingsInput } from '@hfos/core';
import { Checkbox } from '@/components/ui/checkbox';
import { Input, Select } from '@/components/ui/input';
import { useEditor } from '../editor-context';
import { DurationInput, PanelField, RadioRow, useDraftText } from './fields';

const STOP_LABELS: Record<StopOn, string> = {
  reply: 'Reply by text or email',
  booking: 'Book an appointment',
  lead_won: 'Their lead is won',
  lead_lost: 'Their lead is lost',
  estimate_accepted: 'Approve their estimate',
};

/** Re-entry, stopping early, quiet hours, consent and how long a run may last. */
export function SettingsPanel() {
  const { def, apply, quietHours, readOnly } = useEditor();
  const s = def.settings;
  const set = (patch: Partial<WorkflowSettingsInput>, label: string, group?: string) =>
    apply([{ op: 'set_settings', patch }], label, { group, quiet: !!group });
  const qh = quietHours ?? { enabled: true, start: '20:00', end: '08:00' };
  const days = useDraftText(String(s.maxRunDays), (next) => {
    const n = Number(next);
    if (!/^\d+$/.test(next) || n < 1 || n > 365)
      return { ok: false, message: 'Between 1 and 365 days.', error: null };
    return set({ maxRunDays: n }, 'Change how long runs last', 'days');
  });
  return (
    <div data-testid="panel-settings">
      <PanelField label="Can the same person go through it again?">
        <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="Going through again">
          <RadioRow
            on={s.reentry.mode === 'once'}
            onSelect={() => set({ reentry: { mode: 'once' } }, 'Change who can start again')}
            title="Only once, ever"
          />
          <RadioRow
            on={s.reentry.mode === 'after_exit'}
            onSelect={() => set({ reentry: { mode: 'after_exit' } }, 'Change who can start again')}
            title="Again after their last run finishes"
            detail="The usual choice"
          />
          <RadioRow
            on={s.reentry.mode === 'always'}
            onSelect={() =>
              set(
                { reentry: { mode: 'always', cooldown: { amount: 7, unit: 'days' } } },
                'Change who can start again',
              )
            }
            title="Any time, with a gap"
          >
            {s.reentry.mode === 'always' ? (
              <span className="flex items-center gap-1.5 text-xs text-text-3">
                at least
                <DurationInput
                  label="Gap"
                  value={s.reentry.cooldown}
                  onChange={(cooldown) =>
                    set({ reentry: { mode: 'always', cooldown } }, 'Change the gap')
                  }
                />
              </span>
            ) : null}
          </RadioRow>
        </div>
      </PanelField>
      <PanelField label="Stop the run when they">
        <div className="flex flex-col gap-1.5">
          {(Object.keys(STOP_LABELS) as StopOn[]).map((k) => (
            <Checkbox
              key={k}
              label={STOP_LABELS[k]}
              checked={s.stopOn.includes(k)}
              disabled={readOnly}
              onChange={(e) =>
                set(
                  { stopOn: e.target.checked ? [...s.stopOn, k] : s.stopOn.filter((x) => x !== k) },
                  'Change when runs stop',
                )
              }
            />
          ))}
        </div>
      </PanelField>
      <PanelField
        label={
          qh.enabled
            ? `Texts due in quiet hours (${formatClock(qh.start).replace(':00', '')} to ${formatClock(qh.end).replace(':00', '')})`
            : 'Texts due in quiet hours'
        }
        htmlFor="settings-quiet"
        hint={
          qh.enabled
            ? 'Or send an email instead, or skip the text.'
            : 'Quiet hours are off for this business.'
        }
      >
        <Select
          id="settings-quiet"
          selectSize="sm"
          value={s.quietHours}
          disabled={readOnly}
          onChange={(e) =>
            set(
              { quietHours: e.target.value as WorkflowSettingsInput['quietHours'] },
              'Change quiet hours',
            )
          }
        >
          <option value="wait">
            Wait until {formatClock(qh.end).replace(':00', '')}, plus a few minutes
          </option>
          <option value="email_instead">Send an email instead</option>
          <option value="skip">Skip the text</option>
        </Select>
      </PanelField>
      <PanelField
        label="If they haven’t agreed to texts"
        htmlFor="settings-consent"
        hint="STOP always wins. A reply to their own call or text within 24 hours is allowed."
      >
        <Select
          id="settings-consent"
          selectSize="sm"
          value={s.noConsent}
          disabled={readOnly}
          onChange={(e) =>
            set(
              { noConsent: e.target.value as WorkflowSettingsInput['noConsent'] },
              'Change what happens without text consent',
            )
          }
        >
          <option value="email_fallback">Send an email instead</option>
          <option value="skip">Skip the text</option>
        </Select>
      </PanelField>
      <PanelField
        label="End a run after"
        htmlFor="settings-days"
        error={days.error}
        hint="A run still going then stops."
      >
        <span className="flex items-center gap-2 text-[13px]">
          <Input
            id="settings-days"
            inputSize="sm"
            inputMode="numeric"
            className="w-[84px]"
            value={days.value}
            invalid={!!days.error}
            readOnly={readOnly}
            onChange={(e) => days.change(e.target.value)}
          />
          days
        </span>
      </PanelField>
    </div>
  );
}
