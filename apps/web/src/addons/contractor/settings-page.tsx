'use client';
/**
 * Contractor Operations' settings (docs/contractor.md, "Settings"): the trades the business does (the owner's
 * decision 1), the phases a new project starts with, the checklist a new visit's work order starts with, and how
 * long before a visit its missing materials are told (the owner's decision 9). Saved by core's
 * `addon.save_settings`, checked against the manifest's settings shape. Owners and admins
 * (`contractor.manage`). Its crews are beside them (./crews-card.tsx), saved by the add-on's own commands.
 *
 * Under them, how the business estimates: its lowest margin (the owner's decision 6), the markup a new line starts
 * with, and labor's hourly price and cost. Seen by people who may see job costs, and changed by the people who OK
 * estimates under that margin (`contractor.approve`), with the add-on's own `contractor.estimating.save`. Last, what
 * an hour of each person costs the business (./labor-costs-card.tsx), seen and changed by the same people.
 */
import {
  ITEM_KINDS,
  PLAIN_CHECKLIST,
  STARTER_CHECKLISTS,
  type ItemKind,
  type StarterItem,
} from '@hfos/core/addons/contractor/checklists';
import { MATERIALS_ALERT_HOURS } from '@hfos/core/addons/contractor/materials';
import { LIMITS } from '@hfos/core/addons/contractor/schemas';
import {
  STARTER_PHASES,
  TRADE_NAMES,
  TRADES,
  type Trade,
} from '@hfos/core/addons/contractor/trades';
import {
  alertHoursWords,
  CONTRACTOR_WORDS,
  ITEM_KIND_WORDS,
} from '@hfos/core/addons/contractor/words';
import { ArrowDown, ArrowUp, Camera, X } from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Input, Select } from '@/components/ui/input';
import { MoneyInput, PercentInput } from '@/components/money/money-input';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { CrewsCard } from './crews-card';
import { LaborCostsCard } from './labor-costs-card';
import type { Crew, LaborRateList, Overview } from './types';
import { useAct } from './use-act';

const S = CONTRACTOR_WORDS.settings;
const E = CONTRACTOR_WORDS.estimating;
const C = CONTRACTOR_WORDS.checklistSettings;
const A = CONTRACTOR_WORDS.materialsSettings;
const W = CONTRACTOR_WORDS.workOrder;

export function ContractorSettingsPage({
  workspaceId,
  settings,
  crews,
  people,
  estimating,
  laborRates,
  mayApprove,
}: {
  workspaceId: string;
  settings: Overview['settings'];
  /** The business's crews, archived ones too. */
  crews: readonly Crew[];
  /** The people who can use the add-on, as a crew picks its team members. */
  people: Overview['people'];
  /** How the business estimates; null for someone who may not see job costs. */
  estimating: Overview['estimating'];
  /** What an hour of each person costs; null for someone who may not see job costs. */
  laborRates: LaborRateList | null;
  mayApprove: boolean;
}) {
  const [trades, setTrades] = useState<readonly Trade[]>(settings.trades);
  const [phases, setPhases] = useState<readonly string[]>(settings.phases);
  const [checklist, setChecklist] = useState<readonly StarterItem[]>(settings.checklist);
  const [alertHours, setAlertHours] = useState<number>(settings.materialsAlertHours);
  const [name, setName] = useState('');
  const { busy, errors, act } = useAct();
  const add = () => {
    const n = name.trim();
    if (!n || phases.some((p) => p.toLowerCase() === n.toLowerCase())) return setName('');
    setPhases([...phases, n]);
    setName('');
  };
  const move = (i: number, by: -1 | 1) => {
    const next = [...phases];
    const [one] = next.splice(i, 1);
    next.splice(i + by, 0, one!);
    setPhases(next);
  };
  const starterTrade = trades[0] ?? null;
  return (
    <div className="max-w-[760px]" data-testid="contractor-settings">
      <PageHeader title={S.title} description={S.lede} />
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void act(
            'save',
            async () =>
              unwrap(
                await apiBrowser().POST('/v1/commands/addon.save_settings', {
                  body: {
                    workspaceId,
                    addonId: 'contractor',
                    // Kept in the order the trades are listed, so "your first trade" means the same everywhere.
                    settings: {
                      trades: TRADES.filter((t) => trades.includes(t)),
                      phases,
                      checklist,
                      materialsAlertHours: alertHours,
                    },
                  },
                }),
              ),
            S.saved,
          );
        }}
      >
        <Card className="p-5">
          <h2 className="text-[15px] font-semibold">{S.trades}</h2>
          <p className="mt-0.5 text-[13px] text-text-2">{S.tradesHint}</p>
          <div className="mt-3 grid gap-2.5 sm:grid-cols-2">
            {TRADES.map((t) => (
              <Checkbox
                key={t}
                label={TRADE_NAMES[t]}
                checked={trades.includes(t)}
                onChange={(e) =>
                  setTrades(e.target.checked ? [...trades, t] : trades.filter((x) => x !== t))
                }
                data-testid={`trade-${t}`}
              />
            ))}
          </div>
          {errors.trades ? (
            <p className="mt-2 text-[13px] text-danger-text">{errors.trades}</p>
          ) : null}
        </Card>

        <Card className="p-5">
          <h2 className="text-[15px] font-semibold">{S.phases}</h2>
          <p className="mt-0.5 text-[13px] text-text-2">{S.phasesHint}</p>
          {trades.length ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {TRADES.filter((t) => trades.includes(t)).map((t) => (
                <Button
                  key={t}
                  size="sm"
                  variant="secondary"
                  onClick={() => setPhases([...STARTER_PHASES[t]])}
                  data-testid={`phases-from-${t}`}
                >
                  {S.startFrom(TRADE_NAMES[t])}
                </Button>
              ))}
            </div>
          ) : null}
          {phases.length ? (
            <ol className="mt-3 divide-y divide-border rounded-card border border-border">
              {phases.map((p, i) => (
                <li key={p} className="flex items-center gap-2 px-3 py-2 text-[13.5px]">
                  <span className="w-5 text-right tabular-nums text-text-3">{i + 1}.</span>
                  <span className="flex-1">{p}</span>
                  <button
                    type="button"
                    className="rounded p-1 text-text-3 hover:bg-card-2 disabled:opacity-30"
                    aria-label={`Move up: ${p}`}
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                  >
                    <ArrowUp className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    className="rounded p-1 text-text-3 hover:bg-card-2 disabled:opacity-30"
                    aria-label={`Move down: ${p}`}
                    disabled={i === phases.length - 1}
                    onClick={() => move(i, 1)}
                  >
                    <ArrowDown className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    className="rounded p-1 text-text-3 hover:bg-danger-soft hover:text-danger-text"
                    aria-label={`Remove ${p}`}
                    onClick={() => setPhases(phases.filter((x) => x !== p))}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <p className="mt-3 rounded-card bg-card-2 px-3.5 py-2.5 text-[13px] text-text-2">
              {starterTrade
                ? `New projects use ${TRADE_NAMES[starterTrade]}’s starter phases: ${STARTER_PHASES[starterTrade].join(', ')}.`
                : 'New projects start with Plan, Do the work and Final walkthrough until you pick a trade or add phases here.'}
            </p>
          )}
          {phases.length < LIMITS.phases ? (
            <div className="mt-3 flex gap-2">
              <Input
                value={name}
                inputSize="sm"
                maxLength={LIMITS.phaseName}
                placeholder={CONTRACTOR_WORDS.job.phases.addPlaceholder}
                aria-label="New phase"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    add();
                  }
                }}
                data-testid="settings-phase-name"
              />
              <Button size="sm" variant="secondary" disabled={!name.trim()} onClick={add}>
                {S.addPhase}
              </Button>
            </div>
          ) : null}
          {errors.phases ? (
            <p className="mt-2 text-[13px] text-danger-text">{errors.phases}</p>
          ) : null}
        </Card>

        <ChecklistCard
          checklist={checklist}
          onChange={setChecklist}
          trades={TRADES.filter((t) => trades.includes(t))}
          error={errors.checklist}
        />

        <Card className="p-5" data-testid="settings-materials-alert">
          <h2 className="text-[15px] font-semibold">{A.title}</h2>
          <p className="mt-0.5 text-[13px] text-text-2">{A.hint}</p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <label htmlFor="settings-alert-hours" className="text-[13.5px] font-medium">
              {A.when}
            </label>
            <Select
              id="settings-alert-hours"
              selectSize="sm"
              className="w-[190px]"
              value={String(alertHours)}
              onChange={(e) => setAlertHours(Number(e.target.value))}
              data-testid="settings-alert-hours"
            >
              {/* A time someone set another way (the Assistant can) stays pickable. */}
              {[...new Set([...MATERIALS_ALERT_HOURS, alertHours])]
                .sort((a, b) => a - b)
                .map((h) => (
                  <option key={h} value={h}>
                    {alertHoursWords(h)}
                  </option>
                ))}
            </Select>
          </div>
          {alertHours !== settings.materialsAlertHours ? (
            <p className="mt-2 text-[12.5px] text-text-3">{A.saveFirst}</p>
          ) : null}
          {errors.materialsAlertHours ? (
            <p className="mt-2 text-[13px] text-danger-text">{errors.materialsAlertHours}</p>
          ) : null}
        </Card>

        <div className="flex justify-end">
          <Button type="submit" loading={busy === 'save'} data-testid="settings-save">
            {S.save}
          </Button>
        </div>
      </form>
      <CrewsCard workspaceId={workspaceId} crews={crews} people={people} />
      {estimating ? (
        <EstimatingCard workspaceId={workspaceId} estimating={estimating} mayApprove={mayApprove} />
      ) : null}
      {laborRates ? <LaborCostsCard workspaceId={workspaceId} rates={laborRates} /> : null}
    </div>
  );
}

/** The checklist a new visit's work order starts with: boxes to tick and photos to add, some of them required. */
function ChecklistCard({
  checklist,
  onChange,
  trades,
  error,
}: {
  checklist: readonly StarterItem[];
  onChange: (next: readonly StarterItem[]) => void;
  trades: readonly Trade[];
  error?: string;
}) {
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState<ItemKind>('check');
  const [required, setRequired] = useState(false);
  const add = () => {
    const words = label.trim();
    if (!words) return;
    if (!checklist.some((i) => i.label.toLowerCase() === words.toLowerCase()))
      onChange([...checklist, { label: words, kind, required }]);
    setLabel('');
    setRequired(false);
  };
  const move = (i: number, by: -1 | 1) => {
    const next = [...checklist];
    const [one] = next.splice(i, 1);
    next.splice(i + by, 0, one!);
    onChange(next);
  };
  const starterTrade = trades[0] ?? null;
  const said = (items: readonly StarterItem[]) => items.map((i) => i.label).join(', ');
  return (
    <Card className="p-5" data-testid="settings-checklist">
      <h2 className="text-[15px] font-semibold">{C.title}</h2>
      <p className="mt-0.5 text-[13px] text-text-2">{C.hint}</p>
      {trades.length ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {trades.map((t) => (
            <Button
              key={t}
              size="sm"
              variant="secondary"
              onClick={() => onChange([...STARTER_CHECKLISTS[t]])}
              data-testid={`checklist-from-${t}`}
            >
              {C.startFrom(TRADE_NAMES[t])}
            </Button>
          ))}
        </div>
      ) : null}
      {checklist.length ? (
        <ol className="mt-3 divide-y divide-border rounded-card border border-border">
          {checklist.map((item, i) => (
            <li key={item.label} className="flex items-center gap-2 px-3 py-2 text-[13.5px]">
              <span className="w-5 text-right tabular-nums text-text-3">{i + 1}.</span>
              <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                {item.kind === 'photo' ? (
                  <Camera
                    className="h-3.5 w-3.5 flex-none text-text-3"
                    aria-label={ITEM_KIND_WORDS.photo}
                  />
                ) : null}
                {item.label}
                {item.required ? <Badge variant="pending">{W.required}</Badge> : null}
              </span>
              <button
                type="button"
                className="rounded px-1.5 py-1 text-[12.5px] text-text-2 hover:bg-card-2"
                onClick={() =>
                  onChange(
                    checklist.map((x, at) => (at === i ? { ...x, required: !x.required } : x)),
                  )
                }
              >
                {item.required ? W.makeOptional : W.makeRequired}
              </button>
              <button
                type="button"
                className="rounded p-1 text-text-3 hover:bg-card-2 disabled:opacity-30"
                aria-label={`Move up: ${item.label}`}
                disabled={i === 0}
                onClick={() => move(i, -1)}
              >
                <ArrowUp className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                className="rounded p-1 text-text-3 hover:bg-card-2 disabled:opacity-30"
                aria-label={`Move down: ${item.label}`}
                disabled={i === checklist.length - 1}
                onClick={() => move(i, 1)}
              >
                <ArrowDown className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                className="rounded p-1 text-text-3 hover:bg-danger-soft hover:text-danger-text"
                aria-label={`${C.remove} ${item.label}`}
                onClick={() => onChange(checklist.filter((_, at) => at !== i))}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-3 rounded-card bg-card-2 px-3.5 py-2.5 text-[13px] text-text-2">
          {starterTrade
            ? C.usesTrade(TRADE_NAMES[starterTrade], said(STARTER_CHECKLISTS[starterTrade]))
            : C.usesPlain(said(PLAIN_CHECKLIST))}
        </p>
      )}
      {checklist.length < LIMITS.checklist ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Input
            value={label}
            inputSize="sm"
            className="min-w-[180px] flex-1"
            maxLength={LIMITS.itemLabel}
            placeholder={C.addPlaceholder}
            aria-label={W.addItem}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              }
            }}
            data-testid="settings-checklist-label"
          />
          <Select
            selectSize="sm"
            className="w-[120px]"
            value={kind}
            aria-label={W.itemKind}
            onChange={(e) => setKind(e.target.value as ItemKind)}
            data-testid="settings-checklist-kind"
          >
            {ITEM_KINDS.map((k) => (
              <option key={k} value={k}>
                {ITEM_KIND_WORDS[k]}
              </option>
            ))}
          </Select>
          <Checkbox
            label={W.required}
            checked={required}
            onChange={(e) => setRequired(e.target.checked)}
            data-testid="settings-checklist-required"
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={!label.trim()}
            onClick={add}
            data-testid="settings-checklist-add"
          >
            {C.add}
          </Button>
        </div>
      ) : null}
      <p className="mt-2 text-[12.5px] text-text-3">{W.requiredHint}</p>
      {error ? <p className="mt-2 text-[13px] text-danger-text">{error}</p> : null}
    </Card>
  );
}

function EstimatingCard({
  workspaceId,
  estimating,
  mayApprove,
}: {
  workspaceId: string;
  estimating: NonNullable<Overview['estimating']>;
  mayApprove: boolean;
}) {
  const [now, setNow] = useState(estimating);
  const { busy, errors, act } = useAct();
  const changed = JSON.stringify(now) !== JSON.stringify(estimating);
  const field = 'flex flex-col gap-1 text-[13px]';
  return (
    <form
      className="mt-6"
      onSubmit={(e) => {
        e.preventDefault();
        void act(
          'estimating',
          async () =>
            unwrap(
              await apiBrowser().POST('/v1/commands/contractor.estimating.save', {
                body: { workspaceId, ...now },
              }),
            ),
          E.saved,
        );
      }}
      data-testid="contractor-estimating"
    >
      <Card className="p-5">
        <h2 className="text-[15px] font-semibold">{E.title}</h2>
        <p className="mt-0.5 text-[13px] text-text-2">{E.lede}</p>
        <fieldset disabled={!mayApprove} className="mt-3 grid gap-4 sm:grid-cols-2">
          <label className={field}>
            <span className="font-medium">{E.minMargin}</span>
            <span className="flex items-center gap-1.5">
              <PercentInput
                valueBp={now.minMarginBp}
                max={9_000}
                inputSize="sm"
                className="w-[88px]"
                onChange={(minMarginBp) => setNow({ ...now, minMarginBp })}
                data-testid="estimating-min-margin"
              />
              %
            </span>
            <span className="text-[12.5px] text-text-3">{E.minMarginHint}</span>
            {errors.minMarginBp ? (
              <span className="text-danger-text">{errors.minMarginBp}</span>
            ) : null}
          </label>
          <label className={field}>
            <span className="font-medium">{E.markup}</span>
            <span className="flex items-center gap-1.5">
              <PercentInput
                valueBp={now.markupBp}
                max={100_000}
                inputSize="sm"
                className="w-[88px]"
                onChange={(markupBp) => setNow({ ...now, markupBp })}
                data-testid="estimating-markup"
              />
              %
            </span>
            <span className="text-[12.5px] text-text-3">{E.markupHint}</span>
            {errors.markupBp ? <span className="text-danger-text">{errors.markupBp}</span> : null}
          </label>
          <label className={field}>
            <span className="font-medium">{E.laborRate}</span>
            <MoneyInput
              valueCents={now.laborRateCents}
              inputSize="sm"
              className="w-[120px]"
              onChange={(laborRateCents) => setNow({ ...now, laborRateCents })}
              data-testid="estimating-labor-rate"
            />
            {errors.laborRateCents ? (
              <span className="text-danger-text">{errors.laborRateCents}</span>
            ) : null}
          </label>
          <label className={field}>
            <span className="font-medium">{E.laborCost}</span>
            <MoneyInput
              valueCents={now.laborCostCents}
              inputSize="sm"
              className="w-[120px]"
              onChange={(laborCostCents) => setNow({ ...now, laborCostCents })}
              data-testid="estimating-labor-cost"
            />
            <span className="text-[12.5px] text-text-3">{E.laborHint}</span>
            {errors.laborCostCents ? (
              <span className="text-danger-text">{errors.laborCostCents}</span>
            ) : null}
          </label>
        </fieldset>
        {mayApprove ? null : <p className="mt-3 text-[12.5px] text-text-3">{E.readOnly}</p>}
      </Card>
      {mayApprove ? (
        <div className="mt-4 flex justify-end">
          <Button
            type="submit"
            loading={busy === 'estimating'}
            disabled={!changed}
            data-testid="estimating-save"
          >
            {E.save}
          </Button>
        </div>
      ) : null}
    </form>
  );
}
