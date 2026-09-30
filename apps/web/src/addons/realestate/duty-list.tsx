'use client';
/**
 * Deal settings → Duty list (board 8, design/realestate/DutyEditor.dc.html): every duty on the list, what the
 * business changed, and its own duties. Changes are drafts until published; a new version is what new deals take,
 * and open deals keep theirs until someone applies it to them. Owners and admins (`realestate.manage`).
 */
import { catalogDuty, resolveDuty } from '@hfos/core/addons/realestate/catalog/index';
import {
  ACCOUNTABLE_ROLES,
  AUTOMATION_LEVELS,
  AUTOMATION_LEVEL_WORDS,
  DEAL_EVENTS,
  MATERIALITIES,
  TRACKER_CODES,
  type AccountableRole,
  type AutomationLevel,
  type DealEvent,
  type Materiality,
  type ProofRule,
  type ResolvedDuty,
  type TrackerCode,
} from '@hfos/core/addons/realestate/catalog/types';
import type { DueRule } from '@hfos/core/addons/realestate/dates/due';
import {
  KEY_DATES,
  KEY_DATE_KEYS,
  type KeyDateKey,
} from '@hfos/core/addons/realestate/dates/key-dates';
import {
  stableText,
  type CustomDuty,
  type OverridePatch,
} from '@hfos/core/addons/realestate/editor';
import {
  ACCOUNTABLE_LABELS,
  dueRuleWords,
  MATERIALITY_LABELS,
  proofRuleWords,
  remindersWords,
  trackerName,
  TRIGGER_EVENT_WORDS,
  triggerWords,
} from '@hfos/core/addons/realestate/rule-words';
import {
  BUYER_STAGES,
  LISTING_STAGES,
  STAGE_LABELS,
  type DealStage,
} from '@hfos/core/addons/realestate/states';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { DueRuleEditor, ProofEditor, RemindersInput } from './rule-editors';
import type { TemplateItem, TemplateList } from './types';
import { useAct } from './use-act';

type Filter = 'all' | 'buyer' | 'listing' | 'both' | 'own' | 'changed' | 'off';

const defOf = (i: TemplateItem) => i.definition as unknown as ResolvedDuty;

export function DutyList({
  workspaceId,
  list,
  writing,
  onWritingChange,
}: {
  workspaceId: string;
  list: TemplateList;
  writing: boolean;
  onWritingChange: (open: boolean) => void;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<TemplateItem | null>(null);
  const counts = useMemo(
    () => ({
      all: list.items.length,
      buyer: list.items.filter((i) => i.side === 'buyer').length,
      listing: list.items.filter((i) => i.side === 'listing').length,
      both: list.items.filter((i) => i.side === 'both').length,
      own: list.items.filter((i) => i.own).length,
      changed: list.items.filter((i) => i.changed.length).length,
      off: list.items.filter((i) => !i.enabled).length,
    }),
    [list.items],
  );
  const shown = list.items.filter((i) => {
    const pass =
      filter === 'all'
        ? true
        : filter === 'own'
          ? i.own
          : filter === 'changed'
            ? i.changed.length > 0
            : filter === 'off'
              ? !i.enabled
              : i.side === filter;
    const needle = q.trim().toLowerCase();
    return (
      pass &&
      (!needle || i.title.toLowerCase().includes(needle) || i.key.toLowerCase().includes(needle))
    );
  });
  const chips: { key: Filter; label: string }[] = [
    { key: 'all', label: `All · ${counts.all}` },
    { key: 'listing', label: `Listing · ${counts.listing}` },
    { key: 'buyer', label: `Buyer · ${counts.buyer}` },
    { key: 'both', label: `Both · ${counts.both}` },
    { key: 'own', label: `Your own · ${counts.own}` },
    { key: 'changed', label: `Changed · ${counts.changed}` },
    { key: 'off', label: `Turned off · ${counts.off}` },
  ];
  return (
    <div data-testid="duty-list">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1.5">
          {chips.map((c) => (
            <button
              key={c.key}
              type="button"
              aria-pressed={filter === c.key}
              onClick={() => setFilter(c.key)}
              className={cn(
                'h-7 rounded-full px-2.5 text-[12.5px]',
                filter === c.key
                  ? 'bg-accent-soft text-accent-text'
                  : 'bg-card-2 text-text-2 hover:text-text',
              )}
            >
              {c.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {list.unpublished ? <Badge variant="pending">Changes not published</Badge> : null}
          <Input
            inputSize="sm"
            className="w-52"
            placeholder="Find a duty"
            aria-label="Find a duty"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      </div>
      <Card className="overflow-x-auto p-0">
        <table className="w-full min-w-[860px] text-[13.5px]">
          <thead>
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-text-3">
              <th className="px-5 py-2.5 font-semibold">Id</th>
              <th className="px-3 py-2.5 font-semibold">Duty</th>
              <th className="px-3 py-2.5 font-semibold">Due</th>
              <th className="px-3 py-2.5 font-semibold">Proof</th>
              <th className="px-3 py-2.5 font-semibold">Accountable</th>
              <th className="px-5 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {shown.map((i) => {
              const d = defOf(i);
              return (
                <tr
                  key={i.key}
                  className={cn('border-t border-border', !i.enabled && 'text-text-3')}
                  data-testid={`template-${i.key}`}
                >
                  <td className="px-5 py-2.5 font-mono text-[12.5px] text-text-3">{i.key}</td>
                  <td className="px-3 py-2.5">
                    <span className={cn(!i.enabled && 'line-through')}>{i.title}</span>{' '}
                    {i.own ? <Badge variant="gray">Your own</Badge> : null}
                    {i.changed.length ? (
                      <Badge variant="pending" title={`Changed: ${i.changed.join(', ')}`}>
                        Changed
                      </Badge>
                    ) : null}
                    {!i.enabled ? <Badge variant="gray">Off</Badge> : null}
                  </td>
                  <td className="px-3 py-2.5">{dueRuleWords(d.due)}</td>
                  <td className="px-3 py-2.5">{proofRuleWords(d.proof)}</td>
                  <td className="px-3 py-2.5">{ACCOUNTABLE_LABELS[d.accountable]}</td>
                  <td className="px-5 py-2.5 text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setEditing(i)}
                      data-testid={`edit-${i.key}`}
                    >
                      Edit
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {shown.length === 0 ? (
          <p className="px-5 py-6 text-[13.5px] text-text-2">No duty matches.</p>
        ) : null}
      </Card>
      <CatalogDutyDialog
        workspaceId={workspaceId}
        item={editing && !editing.own ? editing : null}
        onClose={() => setEditing(null)}
      />
      <OwnDutyDialog
        workspaceId={workspaceId}
        item={editing?.own ? editing : null}
        open={writing || !!editing?.own}
        onClose={() => {
          setEditing(null);
          onWritingChange(false);
        }}
      />
    </div>
  );
}

/** One of the list's own duties, changed for this business. */
function CatalogDutyDialog({
  workspaceId,
  item,
  onClose,
}: {
  workspaceId: string;
  item: TemplateItem | null;
  onClose: () => void;
}) {
  const base = useMemo(() => {
    const def = item ? catalogDuty(item.key) : undefined;
    return def ? resolveDuty(def) : null;
  }, [item]);
  const [enabled, setEnabled] = useState(true);
  const [due, setDue] = useState<DueRule>({ kind: 'none' });
  const [reminders, setReminders] = useState<number[]>([]);
  const [accountable, setAccountable] = useState<AccountableRole>('agent');
  const [proof, setProof] = useState<ProofRule | null>(null);
  const [materiality, setMateriality] = useState<Materiality>('standard');
  const { busy, act } = useAct(onClose);
  useEffect(() => {
    if (!item) return;
    const d = defOf(item);
    setEnabled(item.enabled);
    setDue(d.due);
    setReminders([...d.reminders]);
    setAccountable(d.accountable);
    setProof(d.proof);
    setMateriality(d.materiality);
  }, [item]);
  if (!item || !base) return null;
  const differs = (a: unknown, b: unknown) => stableText(a) !== stableText(b);
  const patch = {
    ...(differs(due, base.due) ? { due } : {}),
    ...(differs(reminders, base.reminders) ? { reminders } : {}),
    ...(accountable !== base.accountable ? { accountable } : {}),
    ...(differs(proof, base.proof) ? { proof } : {}),
    ...(materiality !== base.materiality ? { materiality } : {}),
  } as unknown as OverridePatch;
  const asCatalog = enabled && Object.keys(patch).length === 0;
  const ids = { workspaceId, dutyKey: item.key };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={`${item.key} · ${item.title}`}
        description={`${trackerName(item.tracker)} · ${triggerWords(base.trigger as Parameters<typeof triggerWords>[0])}. ${base.behavior}`}
        className="w-[min(680px,calc(100vw-32px))]"
      >
        <div className="mt-4 max-h-[65vh] space-y-4 overflow-y-auto pr-1">
          <div className="flex items-center justify-between gap-3 rounded-menu bg-card-2 px-3.5 py-2.5 text-[13.5px]">
            <span>{enabled ? 'On: new deals get it' : 'Off: new deals don’t get it'}</span>
            <Switch checked={enabled} onChange={setEnabled} label="Duty on" />
          </div>
          <Field label="When it’s due" htmlFor="ed-due">
            <DueRuleEditor idPrefix="ed-due" value={due} onChange={setDue} />
          </Field>
          <Field label="What finishes it" htmlFor="ed-proof">
            <ProofEditor value={proof} onChange={setProof} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Accountable" htmlFor="ed-acc">
              <Select
                id="ed-acc"
                value={accountable}
                onChange={(e) => setAccountable(e.target.value as AccountableRole)}
              >
                {ACCOUNTABLE_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ACCOUNTABLE_LABELS[r]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="How much it matters" htmlFor="ed-mat">
              <Select
                id="ed-mat"
                value={materiality}
                onChange={(e) => setMateriality(e.target.value as Materiality)}
              >
                {MATERIALITIES.map((m) => (
                  <option key={m} value={m}>
                    {MATERIALITY_LABELS[m]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Remind, days before" htmlFor="ed-rem" hint={remindersWords(reminders)}>
              <RemindersInput
                id="ed-rem"
                value={reminders}
                onChange={setReminders}
                key={item.key}
              />
            </Field>
          </div>
        </div>
        <div className="mt-5 flex flex-wrap justify-between gap-2">
          <Button
            variant="ghost"
            disabled={item.changed.length === 0 && item.enabled}
            loading={busy === 'clear'}
            onClick={() =>
              void act(
                'clear',
                async () =>
                  unwrap(
                    await apiBrowser().POST('/v1/commands/realestate.template.clear_override', {
                      body: ids,
                    }),
                  ),
                'Back to how the list has it. Publish to use it on new deals.',
              )
            }
          >
            Back to how the list has it
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              loading={busy === 'save'}
              onClick={() =>
                void act(
                  'save',
                  async () =>
                    asCatalog
                      ? unwrap(
                          await apiBrowser().POST(
                            '/v1/commands/realestate.template.clear_override',
                            { body: ids },
                          ),
                        )
                      : unwrap(
                          await apiBrowser().POST('/v1/commands/realestate.template.set_override', {
                            // As JSON: the API's own shape for a rule is the same, written less strictly.
                            body: { ...ids, enabled, patch: JSON.parse(JSON.stringify(patch)) },
                          }),
                        ),
                  'Saved as a draft. Publish to use it on new deals.',
                )
              }
              data-testid="template-save"
            >
              Save
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const blankOwn = {
  side: 'listing',
  title: '',
  behavior: '',
  tracker: 'HEALTH',
  trigger: { on: 'stage', stage: 'signed' },
  due: { kind: 'after_start', businessDays: 2 },
  proof: null,
  accountable: 'agent',
  performedBy: [],
  automation: 'A0',
  materiality: 'standard',
  reminders: [1],
} as CustomDuty;

/** A duty of the business's own, written with the catalog's rules. */
function OwnDutyDialog({
  workspaceId,
  item,
  open,
  onClose,
}: {
  workspaceId: string;
  item: TemplateItem | null;
  open: boolean;
  onClose: () => void;
}) {
  const [d, setD] = useState<CustomDuty>(blankOwn);
  const close = useCallback(() => onClose(), [onClose]);
  const { busy, errors, act } = useAct(close);
  useEffect(() => {
    if (!open) return;
    if (!item) return setD(blankOwn);
    const r = defOf(item);
    setD({
      side: r.side,
      title: r.title,
      behavior: r.behavior ?? '',
      tracker: r.tracker,
      trigger: r.trigger as CustomDuty['trigger'],
      due: r.due,
      proof: r.proof as CustomDuty['proof'],
      accountable: r.accountable,
      performedBy: [...(r.performedBy ?? [])],
      automation: r.automation as CustomDuty['automation'],
      materiality: r.materiality,
      reminders: [...r.reminders],
      ...(r.when?.length ? { when: [...r.when] } : {}),
    });
  }, [open, item]);
  const stages: readonly DealStage[] =
    d.side === 'buyer'
      ? BUYER_STAGES
      : d.side === 'listing'
        ? LISTING_STAGES
        : [...new Set([...BUYER_STAGES, ...LISTING_STAGES])];
  const t = d.trigger;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={item ? `${item.key} · ${item.title}` : 'Write a duty'}
        description="Your own duty, on every new deal it fits once published. It follows the same rules as the list’s."
        className="w-[min(680px,calc(100vw-32px))]"
      >
        <div className="mt-4 max-h-[65vh] space-y-4 overflow-y-auto pr-1">
          <Field label="Name" htmlFor="own-title" error={errors.title}>
            <Input
              id="own-title"
              value={d.title}
              maxLength={80}
              onChange={(e) => setD({ ...d, title: e.target.value })}
              data-testid="own-title"
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Side" htmlFor="own-side">
              <Select
                id="own-side"
                value={d.side}
                onChange={(e) => setD({ ...d, side: e.target.value as CustomDuty['side'] })}
              >
                <option value="listing">Listings</option>
                <option value="buyer">Buyer deals</option>
                <option value="both">Both</option>
              </Select>
            </Field>
            <Field label="Kind of work" htmlFor="own-tracker">
              <Select
                id="own-tracker"
                value={d.tracker}
                onChange={(e) => setD({ ...d, tracker: e.target.value as TrackerCode })}
              >
                {TRACKER_CODES.map((c) => (
                  <option key={c} value={c}>
                    {trackerName(c)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="What brings it" htmlFor="own-on" hint={triggerWords(t)}>
            <div className="flex flex-wrap gap-2">
              <Select
                id="own-on"
                className="w-48"
                value={t.on}
                onChange={(e) =>
                  setD({
                    ...d,
                    trigger:
                      e.target.value === 'stage'
                        ? { on: 'stage', stage: stages[0]! }
                        : e.target.value === 'dates'
                          ? { on: 'dates', key: 'closing' }
                          : { on: 'event', event: 'offer_received' },
                  })
                }
              >
                <option value="stage">Reaching a stage</option>
                <option value="dates">A date confirmed</option>
                <option value="event">Something happening</option>
              </Select>
              {t.on === 'stage' ? (
                <Select
                  className="w-52"
                  aria-label="Stage"
                  value={t.stage}
                  onChange={(e) =>
                    setD({ ...d, trigger: { on: 'stage', stage: e.target.value as DealStage } })
                  }
                >
                  {stages.map((s) => (
                    <option key={s} value={s}>
                      {STAGE_LABELS[s]}
                    </option>
                  ))}
                </Select>
              ) : t.on === 'dates' ? (
                <Select
                  className="w-52"
                  aria-label="Date"
                  value={t.key}
                  onChange={(e) =>
                    setD({ ...d, trigger: { on: 'dates', key: e.target.value as KeyDateKey } })
                  }
                >
                  {KEY_DATE_KEYS.map((k) => (
                    <option key={k} value={k}>
                      {KEY_DATES[k].label}
                    </option>
                  ))}
                </Select>
              ) : (
                <Select
                  className="w-64"
                  aria-label="What happens"
                  value={t.event}
                  onChange={(e) =>
                    setD({ ...d, trigger: { on: 'event', event: e.target.value as DealEvent } })
                  }
                >
                  {DEAL_EVENTS.map((ev) => (
                    <option key={ev} value={ev}>
                      {TRIGGER_EVENT_WORDS[ev]}
                    </option>
                  ))}
                </Select>
              )}
            </div>
          </Field>
          <Field label="When it’s due" htmlFor="own-due" error={errors.due}>
            <DueRuleEditor
              idPrefix="own-due"
              value={d.due}
              onChange={(due) => setD({ ...d, due })}
            />
          </Field>
          <Field label="What finishes it" htmlFor="own-proof">
            <ProofEditor
              value={d.proof as ProofRule | null}
              onChange={(proof) => setD({ ...d, proof: proof as CustomDuty['proof'] })}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Accountable" htmlFor="own-acc">
              <Select
                id="own-acc"
                value={d.accountable}
                onChange={(e) => setD({ ...d, accountable: e.target.value as AccountableRole })}
              >
                {ACCOUNTABLE_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ACCOUNTABLE_LABELS[r]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="How much it matters" htmlFor="own-mat">
              <Select
                id="own-mat"
                value={d.materiality}
                onChange={(e) => setD({ ...d, materiality: e.target.value as Materiality })}
              >
                {MATERIALITIES.map((m) => (
                  <option key={m} value={m}>
                    {MATERIALITY_LABELS[m]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Remind, days before" htmlFor="own-rem" hint={remindersWords(d.reminders)}>
              <RemindersInput
                id="own-rem"
                key={item?.key ?? 'new'}
                value={d.reminders}
                onChange={(reminders) => setD({ ...d, reminders })}
              />
            </Field>
          </div>
          <Field
            label="What HandsFreeOS may do"
            htmlFor="own-auto"
            hint={AUTOMATION_LEVEL_WORDS[d.automation as AutomationLevel].means}
          >
            <Select
              id="own-auto"
              value={d.automation}
              onChange={(e) =>
                setD({ ...d, automation: e.target.value as CustomDuty['automation'] })
              }
            >
              {AUTOMATION_LEVELS.filter((a) => a !== 'A4').map((a) => (
                <option key={a} value={a}>
                  {AUTOMATION_LEVEL_WORDS[a].label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="What it means (optional)" htmlFor="own-behavior">
            <Textarea
              id="own-behavior"
              value={d.behavior}
              className="min-h-[64px]"
              onChange={(e) => setD({ ...d, behavior: e.target.value })}
            />
          </Field>
          {errors.duty ? <p className="text-[12.5px] text-danger-text">{errors.duty}</p> : null}
        </div>
        <div className="mt-5 flex flex-wrap justify-between gap-2">
          {item ? (
            <Button
              variant="ghost"
              loading={busy === 'archive'}
              onClick={() =>
                confirm(`Take “${item.title}” off the list? Deals that have it keep it.`) &&
                void act(
                  'archive',
                  async () =>
                    unwrap(
                      await apiBrowser().POST('/v1/commands/realestate.template.archive_custom', {
                        body: { workspaceId, dutyKey: item.key },
                      }),
                    ),
                  'Taken off the list. Publish to leave it off new deals.',
                )
              }
            >
              Take it off the list
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              loading={busy === 'save'}
              disabled={!d.title.trim()}
              onClick={() =>
                void act(
                  'save',
                  async () =>
                    unwrap(
                      await apiBrowser().POST('/v1/commands/realestate.template.save_custom', {
                        body: {
                          workspaceId,
                          ...(item ? { dutyKey: item.key } : {}),
                          duty: JSON.parse(JSON.stringify({ ...d, title: d.title.trim() })),
                        },
                      }),
                    ),
                  'Saved as a draft. Publish to use it on new deals.',
                )
              }
              data-testid="own-save"
            >
              Save
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
