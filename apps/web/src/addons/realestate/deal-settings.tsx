'use client';
/**
 * Deal settings (boards 8, 9 and 12): the duty list and its versions, who hears when it's critical, the days the
 * office is closed, which milestones get a drafted client update, and support access. Owners and admins
 * (`realestate.manage`); the business's settings are saved through core's `addon.save_settings`, checked against
 * the add-on's own schema (packages/core/src/addons/realestate/settings.ts).
 */
import type { RealestateSettings } from '@hfos/core/addons/realestate/settings';
import { fmtAt, fmtMonthDay, zoneLabel } from '@hfos/core';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type ComponentProps } from 'react';
import { PageHeader } from '@/components/shell/page-header';
import { SupportAccessCard } from '@/components/settings/support-access-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { cn } from '@/lib/utils';
import { realestateHref } from './bits';
import { DutyList } from './duty-list';
import type { TemplateList, TemplateVersions, Teammate } from './types';
import { useAct } from './use-act';

export type SettingsTab = 'duties' | 'alerts' | 'versions' | 'support';

const MILESTONES: { key: keyof RealestateSettings['milestoneDrafts']; label: string }[] = [
  { key: 'under_contract', label: 'Under contract' },
  { key: 'inspection_done', label: 'Inspection done' },
  { key: 'clear_to_close', label: 'Clear to close' },
  { key: 'closed', label: 'Closed' },
];

export function DealSettings({
  workspaceId,
  tab,
  timeZone,
  list,
  versions,
  settings,
  members,
  calendars = [],
  support,
}: {
  workspaceId: string;
  tab: SettingsTab;
  timeZone: string;
  list: TemplateList | null;
  versions: TemplateVersions | null;
  settings: RealestateSettings | null;
  members: readonly (Teammate & { role: string })[];
  /** The business's calendars, for where tours go. */
  calendars?: readonly { readonly id: string; readonly name: string }[];
  support: ComponentProps<typeof SupportAccessCard> | null;
}) {
  useLiveRefresh(['addon']);
  const [writing, setWriting] = useState(false);
  const { busy, act } = useAct();
  const tabs: { key: SettingsTab; label: string }[] = [
    { key: 'duties', label: 'Duty list' },
    { key: 'alerts', label: 'Alerts & dates' },
    { key: 'versions', label: 'Versions' },
    { key: 'support', label: 'Support access' },
  ];
  const published = list?.published;
  const next = (published?.version ?? 0) + 1;
  return (
    <div data-testid="realestate-settings">
      <PageHeader
        title="Deal settings"
        description={
          tab === 'duties' && list
            ? published
              ? `Duty list · version ${published.version}, published ${fmtMonthDay(published.publishedAt.slice(0, 10))}${published.publishedBy ? ` by ${published.publishedBy.name}` : ''} · open deals keep the version they started with`
              : 'Duty list · not published yet: new deals use the list as HandsFreeOS ships it'
            : tab === 'alerts'
              ? 'Alerts, business days and client updates'
              : tab === 'versions'
                ? 'Every published version of the duty list'
                : 'HandsFreeOS support can’t see private deals unless you let them'
        }
        actions={
          tab === 'duties' && list ? (
            <>
              <Button variant="secondary" onClick={() => setWriting(true)} data-testid="write-duty">
                Write a duty
              </Button>
              <Button
                disabled={!list.unpublished}
                loading={busy === 'publish'}
                onClick={() => {
                  const note = window.prompt(
                    `Publish version ${next}? New deals take it; open deals keep theirs. A note for the history (optional):`,
                  );
                  if (note === null) return;
                  void act(
                    'publish',
                    async () =>
                      unwrap(
                        await apiBrowser().POST('/v1/commands/realestate.template.publish', {
                          body: { workspaceId, ...(note.trim() ? { note: note.trim() } : {}) },
                        }),
                      ),
                    `Version ${next} published. New deals take it.`,
                  );
                }}
                data-testid="publish-list"
              >
                Publish version {next}
              </Button>
            </>
          ) : null
        }
      />
      <nav aria-label="Deal settings" className="mb-5 flex gap-1 border-b border-border">
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={
              t.key === 'duties'
                ? realestateHref(workspaceId, 'settings')
                : `${realestateHref(workspaceId, 'settings')}?tab=${t.key}`
            }
            aria-current={tab === t.key ? 'page' : undefined}
            className={cn(
              '-mb-px border-b-2 px-3 py-2.5 text-[14px]',
              tab === t.key
                ? 'border-accent font-medium text-accent-text'
                : 'border-transparent text-text-2 hover:text-text',
            )}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      {tab === 'duties' && list ? (
        <DutyList
          workspaceId={workspaceId}
          list={list}
          writing={writing}
          onWritingChange={setWriting}
        />
      ) : null}
      {tab === 'alerts' && settings ? (
        <AlertSettings
          workspaceId={workspaceId}
          timeZone={timeZone}
          settings={settings}
          members={members}
          calendars={calendars}
        />
      ) : null}
      {tab === 'versions' && versions ? <Versions versions={versions} timeZone={timeZone} /> : null}
      {tab === 'support' && support ? (
        <div className="max-w-3xl">
          <SupportAccessCard {...support} />
          <p className="mt-4 text-[12.5px] text-text-3">
            Access covers every deal the person who allows it can see, read-only, for 24 hours or
            until it’s ended. Every request, access and ending is in Settings → Audit log.
          </p>
        </div>
      ) : null}
    </div>
  );
}

function AlertSettings({
  workspaceId,
  timeZone,
  settings,
  members,
  calendars,
}: {
  workspaceId: string;
  timeZone: string;
  settings: RealestateSettings;
  members: readonly (Teammate & { role: string })[];
  calendars: readonly { readonly id: string; readonly name: string }[];
}) {
  const router = useRouter();
  const [s, setS] = useState(settings);
  const [day, setDay] = useState('');
  const [why, setWhy] = useState('');
  const { busy, act } = useAct();
  const save = (next: RealestateSettings, done: string) => {
    setS(next);
    return act(
      'save',
      async () => {
        unwrap(
          await apiBrowser().POST('/v1/commands/addon.save_settings', {
            body: {
              workspaceId,
              addonId: 'realestate',
              settings: next as unknown as Record<string, unknown>,
            },
          }),
        );
        router.refresh();
      },
      done,
    );
  };
  const closed = Object.entries(s.closedDays).sort(([a], [b]) => a.localeCompare(b));
  const person = s.alertPersonUserIds[0] ?? '';
  return (
    <div className="grid gap-4 lg:grid-cols-2" data-testid="alert-settings">
      <Card className="p-4 md:p-5">
        <h2 className="text-[15px] font-semibold">Who hears when it’s critical</h2>
        <p className="mt-1 text-[13px] text-text-2">
          A closing blocker, a missed contract date or changed wiring goes to the deal’s people and
          to this person, at any hour.
        </p>
        <Field
          label="Alert person"
          htmlFor="alert-person"
          hint="An owner, or someone who can see every deal. Nobody picked: the owners."
          className="mt-3"
        >
          <Select
            id="alert-person"
            value={person}
            disabled={busy === 'save'}
            onChange={(e) =>
              void save(
                { ...s, alertPersonUserIds: e.target.value ? [e.target.value] : [] },
                'Saved.',
              )
            }
            data-testid="alert-person"
          >
            <option value="">The owners</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.fullName} · {m.role}
              </option>
            ))}
          </Select>
        </Field>
      </Card>
      <Card className="p-4 md:p-5">
        <h2 className="text-[15px] font-semibold">Reminders</h2>
        <p className="mt-1 text-[13px] text-text-2">
          Each duty reminds on its own days, set in the duty list: most remind 7, 3 and 1 days
          before. A week out is a Home card; closer, a phone push too, and an email for duties that
          matter to the deal. Everything but critical waits for working hours.
        </p>
        <Link
          href={realestateHref(workspaceId, 'settings')}
          className="mt-2 inline-block text-[13px] text-accent-text hover:underline"
        >
          Change a duty’s reminders
        </Link>
      </Card>
      <Card className="p-4 md:p-5">
        <h2 className="text-[15px] font-semibold">Business days</h2>
        <p className="mt-1 text-[13px] text-text-2">
          Business days skip weekends and US federal holidays as observed (Juneteenth, the Fourth,
          Thanksgiving and the rest), and the days this office is closed. A date with no time is due
          at 11:59 PM, {zoneLabel(timeZone)}.
        </p>
        <div className="mt-3">
          <div className="mb-1.5 text-[13px] font-medium">Days this office is closed</div>
          {closed.length ? (
            <ul className="mb-2 flex flex-wrap gap-1.5">
              {closed.map(([date, label]) => (
                <li key={date}>
                  <Badge variant="gray">
                    {fmtMonthDay(date, new Date().getFullYear())}
                    {label ? ` · ${label}` : ''}
                    <button
                      type="button"
                      aria-label={`Open on ${date}`}
                      className="ml-1 text-text-3 hover:text-danger-text"
                      onClick={() => {
                        const rest = { ...s.closedDays };
                        delete rest[date];
                        void save({ ...s, closedDays: rest }, 'Saved.');
                      }}
                    >
                      ×
                    </button>
                  </Badge>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mb-2 text-[12.5px] text-text-3">None besides weekends and holidays.</p>
          )}
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!day) return;
              void save(
                { ...s, closedDays: { ...s.closedDays, [day]: why.trim() } },
                'Saved. Business days skip it.',
              ).then((ok) => {
                if (ok) {
                  setDay('');
                  setWhy('');
                }
              });
            }}
          >
            <Input
              type="date"
              className="w-44"
              aria-label="A day closed"
              value={day}
              onChange={(e) => setDay(e.target.value)}
            />
            <Input
              className="w-44"
              placeholder="Why (optional)"
              aria-label="Why"
              value={why}
              maxLength={60}
              onChange={(e) => setWhy(e.target.value)}
            />
            <Button type="submit" variant="secondary" disabled={!day} loading={busy === 'save'}>
              Add
            </Button>
          </form>
        </div>
      </Card>
      <Card className="p-4 md:p-5">
        <h2 className="text-[15px] font-semibold">Tours</h2>
        <p className="mt-1 text-[13px] text-text-2">
          A buyer’s tour goes on this calendar as one appointment, with its homes in order. Nothing
          picked: the agent’s own calendar, when they’re on just one.
        </p>
        <Field label="Tours go on" htmlFor="tour-calendar" className="mt-3">
          <Select
            id="tour-calendar"
            value={s.tourCalendarId ?? ''}
            disabled={busy === 'save'}
            onChange={(e) => void save({ ...s, tourCalendarId: e.target.value || null }, 'Saved.')}
            data-testid="tour-calendar"
          >
            <option value="">The agent’s own calendar</option>
            {calendars.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
      </Card>
      <Card className="p-4 md:p-5">
        <h2 className="text-[15px] font-semibold">Client updates</h2>
        <p className="mt-1 text-[13px] text-text-2">
          The Assistant drafts one for the main agent to check at each of these. Nothing is sent
          without the agent.
        </p>
        <ul className="mt-3 space-y-2.5">
          {MILESTONES.map((m) => (
            <li key={m.key} className="flex items-center justify-between gap-3 text-[13.5px]">
              <span>{m.label}</span>
              <Switch
                checked={s.milestoneDrafts[m.key]}
                label={m.label}
                disabled={busy === 'save'}
                onChange={(on) =>
                  void save(
                    { ...s, milestoneDrafts: { ...s.milestoneDrafts, [m.key]: on } },
                    on ? 'Drafts on.' : 'Drafts off.',
                  )
                }
                testId={`milestone-${m.key}`}
              />
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function Versions({ versions, timeZone }: { versions: TemplateVersions; timeZone: string }) {
  return (
    <Card className="p-0">
      {versions.versions.length === 0 ? (
        <p className="px-5 py-8 text-center text-[13.5px] text-text-2">
          Nothing published yet. New deals use the list as HandsFreeOS ships it until you publish
          your own.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {versions.versions.map((v, i) => (
            <li
              key={v.templateSetId}
              className="flex flex-wrap items-baseline justify-between gap-3 px-5 py-3 text-[13.5px]"
            >
              <span>
                <span className="font-medium">Version {v.version}</span>
                {i === 0 ? (
                  <Badge variant="accent" className="ml-2">
                    New deals take it
                  </Badge>
                ) : null}
                {v.note ? <span className="block text-text-2">{v.note}</span> : null}
              </span>
              <span className="text-text-2">
                {fmtAt(v.publishedAt, timeZone)} ·{' '}
                {v.openDeals === 1 ? '1 open deal' : `${v.openDeals} open deals`} on it
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="border-t border-border px-5 py-3 text-[12.5px] text-text-3">
        An open deal keeps its version. To move one to the newest, open it and choose More → Apply
        the newest duty list.
      </p>
    </Card>
  );
}
