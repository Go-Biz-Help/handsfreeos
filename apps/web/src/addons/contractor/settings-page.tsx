'use client';
/**
 * Contractor Operations' settings (docs/contractor.md, "Settings"): the trades the business does (the owner's
 * decision 1) and the phases a new project starts with. Saved by core's `addon.save_settings`, checked against the
 * manifest's settings shape. Owners and admins (`contractor.manage`).
 */
import { LIMITS } from '@hfos/core/addons/contractor/schemas';
import {
  STARTER_PHASES,
  TRADE_NAMES,
  TRADES,
  type Trade,
} from '@hfos/core/addons/contractor/trades';
import { CONTRACTOR_WORDS } from '@hfos/core/addons/contractor/words';
import { ArrowDown, ArrowUp, X } from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { apiBrowser, unwrap } from '@/lib/api/client';
import type { Overview } from './types';
import { useAct } from './use-act';

const S = CONTRACTOR_WORDS.settings;

export function ContractorSettingsPage({
  workspaceId,
  settings,
}: {
  workspaceId: string;
  settings: Overview['settings'];
}) {
  const [trades, setTrades] = useState<readonly Trade[]>(settings.trades);
  const [phases, setPhases] = useState<readonly string[]>(settings.phases);
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
                    settings: { trades: TRADES.filter((t) => trades.includes(t)), phases },
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

        <div className="flex justify-end">
          <Button type="submit" loading={busy === 'save'} data-testid="settings-save">
            {S.save}
          </Button>
        </div>
      </form>
    </div>
  );
}
