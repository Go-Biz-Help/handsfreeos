'use client';
/**
 * A listing's open houses (board 39, design/realestate/OpenHouses.dc.html). Chris decided (2026-10-01): visitors
 * sign in on a page they open from a QR code. Each open house lists who signed in, whether they're with an agent,
 * agreed to texts and have been followed up; a visitor with their own agent is only recorded, never followed up. The
 * sign-in sheet prints with the QR code; its page opens an hour before and closes an hour after, and only once the
 * listing is live on the MLS. `?plan=1` opens "Plan an open house".
 */
import {
  clockOfMinutes,
  fmtMonthDay,
  fmtTime,
  fmtWhen,
  localDayOf,
  localInstant,
  minutesToClock,
  TIME_OPTIONS,
  todayIn,
} from '@hfos/core';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Callout } from '@/components/crm/chips';
import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Label } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { ApiError, apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { fieldErrors } from '@/lib/api/field-errors';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { usePublicOrigin } from '@/lib/use-origin';
import { CardHead, dealHref, HeadLink } from './bits';
import { DealCrumb, firstNames } from './buyer-bits';
import { ReasonDialog } from './deal-dialogs';
import type { CalendarChoice } from './plan-tour';
import type { OpenHouse, OpenHouseList } from './types';
import { useQueryState } from './use-query-state';

const thisYear = () => new Date().getFullYear();
const LENGTHS = [60, 90, 120, 150, 180, 240, 300] as const;
type Visitor = OpenHouse['visitors'][number];

/** Visitors on their own who haven't been followed up: the ones the next-morning reminder is about. */
export const toFollowUp = (o: OpenHouse) =>
  o.visitors.filter((v) => !v.withAgent && !v.followedUpAt).length;

export function OpenHousesPage({
  workspaceId,
  dealId,
  dealName,
  street,
  timeZone,
  list,
  sellers,
  calendars,
  team,
  brandedOrigin,
  live,
}: {
  workspaceId: string;
  dealId: string;
  dealName: string;
  street: string;
  timeZone: string;
  list: OpenHouseList;
  sellers: readonly string[];
  calendars: readonly CalendarChoice[];
  team: readonly { readonly userId: string; readonly name: string; readonly main: boolean }[];
  brandedOrigin: string | null;
  live: boolean;
}) {
  useLiveRefresh(['custom_record', 'appointment']);
  const [plan, setPlan] = useQueryState('plan');
  const [cancelling, setCancelling] = useState<OpenHouse | null>(null);
  const [following, setFollowing] = useState<Visitor | null>(null);
  const seller = firstNames(sellers) || 'the seller';
  const now = Date.now();
  // The sheet is for the next one still to come (or happening now); else the last one planned.
  const planned = list.openHouses.filter((o) => o.state === 'planned');
  const next =
    planned.find((o) => new Date(o.endsAt).getTime() + 3_600_000 >= now) ?? planned.at(-1);
  const origin = usePublicOrigin(brandedOrigin);
  const sheetLink = next?.signInPath && origin ? `${origin}${next.signInPath}` : null;
  const [qr, setQr] = useState<string | null>(null);
  useEffect(() => {
    if (!sheetLink) return;
    let stale = false;
    void QRCode.toDataURL(sheetLink, { margin: 1, width: 512 })
      .then((d) => !stale && setQr(d))
      .catch(() => !stale && setQr(null));
    return () => {
      stale = true;
    };
  }, [sheetLink]);

  return (
    <div data-testid="realestate-open-houses">
      <div className="print:hidden">
        <DealCrumb
          workspaceId={workspaceId}
          dealId={dealId}
          dealName={dealName}
          here="Open houses"
        />
        <PageHeader
          title="Open houses"
          description={street}
          actions={
            <>
              {sheetLink ? (
                <Button
                  variant="secondary"
                  onClick={() => window.print()}
                  data-testid="open-house-print"
                >
                  Print the sign-in sheet
                </Button>
              ) : null}
              {live ? (
                <Button onClick={() => setPlan('1')} data-testid="open-house-plan">
                  Plan an open house
                </Button>
              ) : null}
            </>
          }
        />
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-5 print:block">
        <div className="min-w-0 space-y-4 print:hidden">
          {list.openHouses.length === 0 ? (
            <Card className="p-5 text-[13.5px] text-text-2">
              None yet. Plan one and it goes on the host’s calendar; {seller} sees it in their
              portal, and visitors sign in from a QR code on the day.
            </Card>
          ) : (
            [...list.openHouses]
              .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
              .map((o) => (
                <OpenHouseCard
                  key={o.id}
                  workspaceId={workspaceId}
                  open={o}
                  timeZone={timeZone}
                  seller={seller}
                  onMls={list.live}
                  live={live}
                  onCancel={() => setCancelling(o)}
                  onFollowUp={setFollowing}
                />
              ))
          )}
        </div>
        <div className="space-y-3">
          <Card
            className="p-5 text-center print:mx-auto print:mt-[0.6in] print:max-w-[6.5in] print:border-0 print:shadow-none"
            data-testid="open-house-sheet"
          >
            <div className="text-[16px] font-semibold print:text-[34px]">
              Welcome! Please sign in.
            </div>
            {sheetLink ? (
              qr ? (
                // A data: URL made in this browser: no loader, no request.
                <img
                  src={qr}
                  alt="QR code for the open house’s sign-in page"
                  className="mx-auto mt-3 h-44 w-44 print:mt-8 print:h-[4.5in] print:w-[4.5in]"
                  data-testid="open-house-qr"
                />
              ) : (
                <div className="mx-auto mt-3 h-44 w-44 bg-card-2" />
              )
            ) : (
              <p className="mt-3 text-[13px] text-text-2">
                {!list.live
                  ? 'The QR code shows once the listing is live on the MLS and its page is up.'
                  : !next
                    ? 'The QR code shows once an open house is planned.'
                    : 'Put the listing’s page up first, from Marketing. The sign-in page lives under it.'}
              </p>
            )}
            <div className="mt-2 text-[14px] font-medium print:mt-6 print:text-[26px]">
              {street}
            </div>
            {next ? (
              <div className="text-[12.5px] text-text-2 print:text-[18px]">
                {fmtWhen(next.startsAt, next.endsAt, timeZone)}
              </div>
            ) : null}
            <div className="mt-1 text-[12.5px] text-text-2 print:mt-4 print:text-[18px]">
              Scan with your phone’s camera
            </div>
          </Card>
          <p className="text-[12.5px] text-text-2 print:hidden">
            The sheet prints with the QR code to the sign-in page. Visitors who tick the box agree
            to texts from your business, kept with “Open house: {street}”. You’re reminded the next
            morning about anyone not followed up.
          </p>
        </div>
      </div>
      <PlanOpenHouseDialog
        open={plan !== null}
        onOpenChange={(o) => setPlan(o ? '1' : null)}
        workspaceId={workspaceId}
        dealId={dealId}
        timeZone={timeZone}
        calendars={calendars}
        team={team}
      />
      <ReasonDialog
        open={!!cancelling}
        onOpenChange={(o) => !o && setCancelling(null)}
        title="Cancel this open house?"
        description={
          cancelling
            ? `${fmtWhen(cancelling.startsAt, cancelling.endsAt, timeZone)}. It comes off the calendar and its sign-in page closes.`
            : undefined
        }
        label="Why (optional)"
        optional
        submit="Cancel it"
        danger
        done="Cancelled. It’s off the calendar."
        run={async (reason) =>
          unwrap(
            await apiBrowser().POST('/v1/commands/realestate.open_house.cancel', {
              body: {
                workspaceId,
                openHouseId: cancelling!.id,
                ...(reason ? { reason } : {}),
              },
            }),
          )
        }
      />
      <ReasonDialog
        open={!!following}
        onOpenChange={(o) => !o && setFollowing(null)}
        title={following ? `Followed up with ${following.firstName}?` : 'Followed up?'}
        description="How you reached them, if you like. It’s kept with the visit."
        label="Note (optional)"
        optional
        submit="Mark followed up"
        done="Marked followed up."
        run={async (note) =>
          unwrap(
            await apiBrowser().POST('/v1/commands/realestate.open_house.follow_up', {
              body: { workspaceId, visitorId: following!.id, ...(note ? { note } : {}) },
            }),
          )
        }
      />
    </div>
  );
}

function OpenHouseCard({
  workspaceId,
  open: o,
  timeZone,
  seller,
  onMls,
  live,
  onCancel,
  onFollowUp,
}: {
  workspaceId: string;
  open: OpenHouse;
  timeZone: string;
  seller: string;
  onMls: boolean;
  live: boolean;
  onCancel: () => void;
  onFollowUp: (v: Visitor) => void;
}) {
  const ended = new Date(o.endsAt).getTime() < Date.now();
  const host = o.host?.fullName ?? 'No one';
  const day = (iso: string) => fmtMonthDay(localDayOf(iso, timeZone), thisYear());
  const opens = new Date(new Date(o.startsAt).getTime() - 3_600_000).toISOString();
  const closes = new Date(new Date(o.endsAt).getTime() + 3_600_000).toISOString();
  return (
    <Card className="p-4 md:p-5" data-testid="open-house">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2
          className={
            o.state === 'cancelled'
              ? 'text-[16px] font-semibold text-text-3 line-through'
              : 'text-[16px] font-semibold'
          }
        >
          {fmtWhen(o.startsAt, o.endsAt, timeZone)}
        </h2>
        {o.state === 'cancelled' ? (
          <Badge variant="gray">Cancelled</Badge>
        ) : ended || o.visitors.length ? (
          <span className="text-[13px] text-text-2">
            {host} {ended ? 'hosted' : 'hosts'} · {o.visitors.length} signed in
          </span>
        ) : (
          <Badge variant="gray">Planned</Badge>
        )}
      </div>
      {o.state === 'planned' && !ended ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[13.5px] text-text-2">
            On {host}’s calendar. {seller.replace(/^./, (m) => m.toUpperCase())} sees it in their
            portal.{' '}
            {onMls
              ? `Sign-in opens at ${fmtTime(opens, timeZone)} and closes at ${fmtTime(closes, timeZone)}.`
              : 'Sign-in opens once it’s live on the MLS.'}
          </p>
          {live ? (
            <Button size="sm" variant="ghost" onClick={onCancel}>
              Cancel it
            </Button>
          ) : null}
        </div>
      ) : null}
      {o.visitors.length ? (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-[13.5px]">
            <thead className="border-b border-border text-xs font-semibold uppercase tracking-wide text-text-3">
              <tr>
                <th className="py-2 pr-3 font-semibold">Visitor</th>
                <th className="py-2 pr-3 font-semibold">Contact</th>
                <th className="py-2 pr-3 font-semibold">With an agent</th>
                <th className="py-2 pr-3 font-semibold">Texts OK</th>
                <th className="py-2 font-semibold">Followed up</th>
              </tr>
            </thead>
            <tbody>
              {o.visitors.map((v) => {
                const name = [v.firstName, v.lastName].filter(Boolean).join(' ');
                return (
                  <tr
                    key={v.id}
                    className="border-b border-border last:border-0"
                    data-testid="open-house-visitor"
                  >
                    <td className="py-2.5 pr-3 font-semibold">
                      {v.personId ? (
                        <Link
                          href={`/app/w/${workspaceId}/customers/people/${v.personId}`}
                          className="hover:underline"
                        >
                          {name}
                        </Link>
                      ) : (
                        name
                      )}
                    </td>
                    <td className="py-2.5 pr-3 text-text-2">
                      {[v.email, v.phone].filter(Boolean).join(' · ') || '—'}
                    </td>
                    <td className="py-2.5 pr-3">
                      {v.withAgent ? `Yes${v.agentName ? ` · ${v.agentName}` : ''}` : 'No'}
                    </td>
                    <td className="py-2.5 pr-3">
                      {v.withAgent ? '—' : v.smsConsent ? 'Yes' : 'No'}
                    </td>
                    <td className="py-2.5">
                      {v.withAgent ? (
                        <span className="text-text-2">Their agent’s client</span>
                      ) : v.followedUpAt ? (
                        `Done ${day(v.followedUpAt)}`
                      ) : live ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => onFollowUp(v)}
                          data-testid="open-house-follow-up"
                        >
                          Follow up
                        </Button>
                      ) : (
                        <Badge variant="pending">Not yet</Badge>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-2 text-[12.5px] text-text-2">
            Each visitor on their own is a lead for {host}; those working with another agent are
            only recorded.
          </p>
        </div>
      ) : ended && o.state === 'planned' ? (
        <p className="text-[13.5px] text-text-2">Nobody signed in.</p>
      ) : null}
    </Card>
  );
}

/** "Plan an open house": the day, start and length, who hosts it, and the calendar it goes on. */
function PlanOpenHouseDialog({
  open,
  onOpenChange,
  workspaceId,
  dealId,
  timeZone,
  calendars,
  team,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  dealId: string;
  timeZone: string;
  calendars: readonly CalendarChoice[];
  team: readonly { readonly userId: string; readonly name: string; readonly main: boolean }[];
}) {
  const router = useRouter();
  const [date, setDate] = useState(() => todayIn(timeZone));
  const [time, setTime] = useState(780);
  const [length, setLength] = useState(180);
  const [hostId, setHostId] = useState(team.find((t) => t.main)?.userId ?? '');
  const [calendarId, setCalendarId] = useState('');
  const [warnings, setWarnings] = useState<readonly { message: string }[] | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setErrors({});
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/realestate.open_house.plan', {
          body: {
            workspaceId,
            dealId,
            startsAt: new Date(localInstant(date, minutesToClock(time), timeZone)).toISOString(),
            durationMinutes: length,
            hostUserId: hostId || undefined,
            calendarId: calendarId || undefined,
            acknowledgeWarnings: !!warnings,
          },
        }),
      );
      toast.success(
        `Planned for ${fmtWhen(out.startsAt, out.endsAt, timeZone)}. It’s on the calendar.`,
      );
      setWarnings(null);
      onOpenChange(false);
      router.refresh();
    } catch (e) {
      if (e instanceof ApiError && e.rule === 'needs_confirmation') {
        setWarnings((e.details as { warnings?: { message: string }[] })?.warnings ?? []);
      } else {
        const fe = fieldErrors(e);
        if (Object.keys(fe).length) setErrors(fe);
        toast.error(errorMessage(e));
      }
    } finally {
      setBusy(false);
    }
  };
  const ends = time + length;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Plan an open house"
        description="It goes on the host’s calendar, and the seller sees it in their portal."
      >
        <form
          className="mt-4 flex flex-col gap-3.5"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          data-testid="plan-open-house"
        >
          <div>
            <Label htmlFor="oh-date">Day and start</Label>
            <div className="flex gap-2">
              <Input
                id="oh-date"
                type="date"
                value={date}
                onChange={(e) => {
                  setDate(e.target.value);
                  setWarnings(null);
                }}
                className="min-w-0 flex-1"
                data-testid="open-house-date"
              />
              <Select
                aria-label="Start time"
                value={time}
                onChange={(e) => {
                  setTime(Number(e.target.value));
                  setWarnings(null);
                }}
                className="w-[120px]"
                data-testid="open-house-time"
              >
                {TIME_OPTIONS.map(([m, label]) => (
                  <option key={m} value={m}>
                    {label}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          <Field
            label="How long"
            htmlFor="oh-length"
            hint={ends < 24 * 60 ? `Until ${clockOfMinutes(ends)}.` : undefined}
            error={errors.durationMinutes}
          >
            <Select
              id="oh-length"
              value={length}
              onChange={(e) => setLength(Number(e.target.value))}
            >
              {LENGTHS.map((m) => (
                <option key={m} value={m}>
                  {m < 60 ? `${m} min` : `${m / 60} h`.replace('.5 h', ' h 30 min')}
                </option>
              ))}
            </Select>
          </Field>
          {team.length > 1 ? (
            <Field label="Who hosts it" htmlFor="oh-host" error={errors.hostUserId}>
              <Select id="oh-host" value={hostId} onChange={(e) => setHostId(e.target.value)}>
                {team.map((t) => (
                  <option key={t.userId} value={t.userId}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <Field label="Calendar" htmlFor="oh-calendar">
            <Select
              id="oh-calendar"
              value={calendarId}
              onChange={(e) => setCalendarId(e.target.value)}
            >
              <option value="">The one for tours</option>
              {calendars.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          {warnings ? (
            <Callout tone="warning">
              {warnings.length
                ? warnings.map((w) => w.message).join(' ')
                : 'The calendar has a warning about this time.'}{' '}
              Plan it anyway?
            </Callout>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} data-testid="open-house-submit">
              {warnings ? 'Plan it anyway' : 'Plan it'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The listing's open houses on its deal page (board 32's Open houses): when, who, and who's left to follow up. */
export function OpenHousesCard({
  workspaceId,
  dealId,
  list,
  timeZone,
}: {
  workspaceId: string;
  dealId: string;
  list: OpenHouseList;
  timeZone: string;
}) {
  const shown = list.openHouses.filter((o) => o.state === 'planned');
  return (
    <Card className="p-4 md:p-5" data-testid="listing-open-houses">
      <CardHead
        title="Open houses"
        action={<HeadLink href={dealHref(workspaceId, dealId, 'open-houses')}>Open</HeadLink>}
      />
      {shown.length === 0 ? (
        <p className="text-[13.5px] text-text-2">
          None planned. Visitors sign in from a QR code, and each one on their own is a lead.
        </p>
      ) : (
        <ul className="space-y-2.5">
          {shown.map((o) => {
            const ended = new Date(o.endsAt).getTime() < Date.now();
            const left = toFollowUp(o);
            const host = o.host?.fullName ?? 'No one';
            return (
              <li key={o.id} className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[14px] font-semibold">
                    {fmtWhen(o.startsAt, o.endsAt, timeZone)}
                  </div>
                  <div className="text-[13px] text-text-2">
                    {ended
                      ? `${host} hosted · ${o.visitors.length} signed in${left ? ` · ${left} to follow up` : ''}`
                      : `${host} hosts · on the calendar`}
                  </div>
                </div>
                {ended ? (
                  left ? (
                    <Badge variant="pending">{left} to follow up</Badge>
                  ) : null
                ) : (
                  <Badge variant="gray">Planned</Badge>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
