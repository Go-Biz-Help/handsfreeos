'use client';
/**
 * Deal settings (boards 8, 9 and 12): the duty list and its versions, who hears when it's critical, the days the
 * office is closed, which milestones get a drafted client update, keeping records and legal holds (round six, board
 * 93), and support access. Owners and admins (`realestate.manage`); the business's settings are saved through core's
 * `addon.save_settings`, checked against the add-on's own schema (packages/core/src/addons/realestate/settings.ts).
 * Its Safety tab is core's Settings → Safety, for whoever may change the business's settings.
 */
import { KEEPING_WORDS } from '@hfos/core/addons/realestate/keeping-words';
import type { RealestateSettings } from '@hfos/core/addons/realestate/settings';
import { fmtAt, fmtMonthDay, zoneLabel } from '@hfos/core';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type ComponentProps } from 'react';
import { PageHeader } from '@/components/shell/page-header';
import { AddonConnections } from '@/components/addons/connections';
import { SupportAccessCard } from '@/components/settings/support-access-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { apiBrowser, unwrap } from '@/lib/api/client';
import type { AddonConnectionList, Ok } from '@/lib/api/types';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { cn } from '@/lib/utils';
import { realestateHref } from './bits';
import { DutyList } from './duty-list';
import { KeepingRecords } from './keeping';
import type { Hold, TemplateList, TemplateVersions, Teammate } from './types';
import { useAct } from './use-act';

export type SettingsTab = 'duties' | 'alerts' | 'connections' | 'records' | 'versions' | 'support';

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
  connections = null,
  holds = null,
  canHold = false,
  canSafety = false,
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
  /** The Connections tab: the add-on's connections, what each is used for, and what a sign-in came back with. */
  connections?: {
    readonly list: AddonConnectionList;
    readonly uses: ConnectionUses;
    readonly back: ComponentProps<typeof AddonConnections>['back'];
  } | null;
  /** Keeping records (round six): the deals on legal hold. */
  holds?: readonly Hold[] | null;
  /** May place and lift legal holds (`records.hold`). */
  canHold?: boolean;
  /** May change the business's settings, so Settings → Safety is theirs (`workspace.update`). */
  canSafety?: boolean;
  support: ComponentProps<typeof SupportAccessCard> | null;
}) {
  useLiveRefresh(['addon']);
  const [writing, setWriting] = useState(false);
  const { busy, act } = useAct();
  const tabs: { key: SettingsTab | 'safety'; label: string; href?: string }[] = [
    { key: 'duties', label: 'Duty list' },
    { key: 'alerts', label: 'Alerts & dates' },
    { key: 'connections', label: 'Connections' },
    { key: 'records', label: KEEPING_WORDS.tab },
    // Check-ins are core's, for everyone in the business: its times live in Settings → Safety.
    ...(canSafety
      ? [{ key: 'safety' as const, label: 'Safety', href: `/app/w/${workspaceId}/settings/safety` }]
      : []),
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
              : tab === 'connections'
                ? 'What Real Estate connects to: listing data, e-sign and ShowingTime'
                : tab === 'records'
                  ? KEEPING_WORDS.description
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
      <nav
        aria-label="Deal settings"
        className="mb-5 flex gap-1 overflow-x-auto whitespace-nowrap border-b border-border"
      >
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={
              t.href ??
              (t.key === 'duties'
                ? realestateHref(workspaceId, 'settings')
                : `${realestateHref(workspaceId, 'settings')}?tab=${t.key}`)
            }
            data-testid={`settings-tab-${t.key}`}
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
      {tab === 'connections' && connections && settings ? (
        <AddonConnections
          workspaceId={workspaceId}
          addonId="realestate"
          list={connections.list}
          back={connections.back}
          about={{
            listing_data: 'Homes, buyers’ searches, sold comps, your listings’ status',
            esign: 'Send documents for signing; the signed copy comes back to Documents',
          }}
          uses={{
            listing_data: {
              words: connections.uses.listingData.words,
              count: connections.uses.listingData.listings + connections.uses.listingData.searches,
            },
            esign: { words: connections.uses.esign.words, count: connections.uses.esign.out },
          }}
          ownAccount={{
            listing_data:
              'Your own Repliers, AnyProp or MLS feed (RESO Web API: MLS Grid, Bridge, Trestle) replaces it; your MLS license is then your own.',
          }}
        >
          <ShowingTimeCard
            workspaceId={workspaceId}
            settings={settings}
            words={connections.uses.showingTime.words}
          />
        </AddonConnections>
      ) : null}
      {tab === 'records' && settings && holds ? (
        <KeepingRecords
          workspaceId={workspaceId}
          timeZone={timeZone}
          settings={settings}
          holds={holds}
          canHold={canHold}
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

type ConnectionUses = Ok<'/v1/queries/realestate.connections.uses'>;

/** ShowingTime (board 62): its emails read into showings for listings already on it, on or off. */
function ShowingTimeCard({
  workspaceId,
  settings,
  words,
}: {
  workspaceId: string;
  settings: RealestateSettings;
  words: string;
}) {
  const router = useRouter();
  const { busy, act } = useAct();
  const on = settings.showingTimeEmails;
  return (
    <Card className="p-5" data-testid="connector-showingtime">
      <h2 className="text-[15px] font-semibold">ShowingTime</h2>
      <p className="text-[13px] text-text-2">Showings and feedback for listings already on it</p>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-control border border-border p-3.5">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-card-2 text-[12px] font-semibold text-text-2">
          ST
        </span>
        <div className="min-w-[11rem] flex-1 basis-[12rem]">
          <p className="font-medium">
            ShowingTime’s emails <Badge variant={on ? 'ok' : 'gray'}>{on ? 'On' : 'Off'}</Badge>
          </p>
          <p className="text-[13px] text-text-2">
            {on
              ? 'Read from the emails that come into your Inbox'
              : 'Left in your Inbox as emails; nothing becomes a showing'}
          </p>
          <p className="text-[12.5px] text-text-3">{words}</p>
        </div>
        <Button
          size="sm"
          variant={on ? 'ghost' : 'secondary'}
          loading={busy === 'showingtime'}
          onClick={() =>
            void act(
              'showingtime',
              async () => {
                unwrap(
                  await apiBrowser().POST('/v1/commands/addon.save_settings', {
                    body: {
                      workspaceId,
                      addonId: 'realestate',
                      settings: { ...settings, showingTimeEmails: !on } as unknown as Record<
                        string,
                        unknown
                      >,
                    },
                  }),
                );
                router.refresh();
              },
              on
                ? 'ShowingTime’s emails stay in the Inbox now.'
                : 'ShowingTime’s emails become showings again.',
            )
          }
          data-testid="showingtime-switch"
        >
          {on ? 'Turn off' : 'Turn on'}
        </Button>
      </div>
    </Card>
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
  const picked = s.alertPersonUserIds;
  const nameOf = new Map(members.map((m) => [m.id, m]));
  const addable = members.filter((m) => !picked.includes(m.id));
  return (
    <div className="grid gap-4 lg:grid-cols-2" data-testid="alert-settings">
      <Card className="p-4 md:p-5">
        <h2 className="text-[15px] font-semibold">Who hears when it’s serious</h2>
        <p className="mt-1 text-[13px] text-text-2">
          An at-risk alert that nobody on the deal acknowledges within one business day goes to
          these people too. Critical ones (a closing blocker, a missed contract date, changed
          wiring) go to them straight away, at any hour.
        </p>
        <div className="mt-3">
          <div className="mb-1.5 text-[13px] font-medium">Alert people</div>
          {picked.length ? (
            <ul className="mb-2 flex flex-wrap gap-1.5" data-testid="alert-people">
              {picked.map((id) => {
                const m = nameOf.get(id);
                return (
                  <li key={id}>
                    <Badge variant="gray">
                      {m ? `${m.fullName} · ${m.role}` : 'Someone who left'}
                      <button
                        type="button"
                        aria-label={`Stop alerting ${m?.fullName ?? 'them'}`}
                        className="ml-1 text-text-3 hover:text-danger-text"
                        disabled={busy === 'save'}
                        onClick={() =>
                          void save(
                            { ...s, alertPersonUserIds: picked.filter((x) => x !== id) },
                            'Saved.',
                          )
                        }
                      >
                        ×
                      </button>
                    </Badge>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="mb-2 text-[12.5px] text-text-3">Nobody picked: the owners hear.</p>
          )}
          {picked.length < 10 && addable.length ? (
            <Select
              id="alert-person"
              aria-label="Add someone"
              value=""
              disabled={busy === 'save'}
              onChange={(e) =>
                e.target.value &&
                void save({ ...s, alertPersonUserIds: [...picked, e.target.value] }, 'Saved.')
              }
              data-testid="alert-person"
            >
              <option value="">+ Add someone</option>
              {addable.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.fullName} · {m.role}
                </option>
              ))}
            </Select>
          ) : null}
          <p className="mt-1.5 text-[12.5px] text-text-3">
            An owner, or someone who can see every deal; up to 10.
          </p>
        </div>
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
