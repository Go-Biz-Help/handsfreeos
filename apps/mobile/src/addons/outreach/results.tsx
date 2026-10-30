import { relativeTimeAgo } from '@hfos/core';
import {
  ACTIVITY_PEOPLE_WORDS as AP,
  ACTIVITY_PERIOD_KEYS,
  ACTIVITY_PERIODS,
  activityStepsOf,
  topicName,
  type ActivityOutput,
  type ActivityPeriod,
} from '@hfos/core/addons/outreach/activity';
import {
  bestOpenerOf,
  OPENER_KINDS,
  OPENER_RESULT_WORDS as O,
  openerShort,
  type OpenersOutput,
} from '@hfos/core/addons/outreach/openers';
import { PARTNER_WORDS } from '@hfos/core/addons/outreach/partners';
import type { TrackingOutput } from '@hfos/core/addons/outreach/tracking';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import * as React from 'react';
import { View } from 'react-native';

import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Segmented } from '@/components/ui/segmented';
import { Text } from '@/components/ui/text';
import { api, unwrap } from '@/lib/api';
import { cn } from '@/lib/utils';

import { OutreachFrame } from './frame';
import { NetworkName } from './networks';
import { NumbersPart } from './numbers';
import { PersonMenuScope, PersonName } from './person-menu';
import { TouchedPostsPart } from './posted';
import {
  NeedsSignal,
  Note,
  openOutreach,
  Part,
  switchOutreach,
  useOutreachAnswer,
  useOutreachContext,
} from './kit';

/**
 * Results on the phone (decisions 59 and 70): the three numbers to watch every day and the week's review
 * (./numbers.tsx), then what came of it over a stretch, as the web's tab has it: demos booked,
 * then each step from reached to booked with how many of the step before made it, what was done along the way, and the
 * groups that brought the most, and the posts liked and commented on (./posted.tsx); the person's own Partners
 * list: asked, interested, calls booked and partners made (decision 81); person by person, the latest first, each
 * step they've come with when (decision 128), their name opening the person sheet; and which openers work, every first
 * message so far (decision 129: it was under the playbooks). It needs signal.
 */

type Numbers = ActivityOutput['numbers'];
const FUNNEL = [
  'people',
  'chatsStarted',
  'replies',
  'demos',
] as const satisfies readonly (keyof Numbers)[];
const ALONG: readonly { readonly key: keyof Numbers; readonly label: string }[] = [
  { key: 'friendRequests', label: 'Friend requests' },
  { key: 'likes', label: 'Likes' },
  { key: 'comments', label: 'Comments' },
  { key: 'followUps', label: 'Follow-ups' },
];
/** The groups shown here; the web lists them all. */
const GROUPS_SHOWN = 5;

export function ResultsScreen() {
  const ctx = useOutreachContext();
  const ws = ctx.workspaceId;
  const [period, setPeriod] = React.useState<ActivityPeriod>('week');
  const activity = useOutreachAnswer(
    async () =>
      unwrap(
        await api.POST('/v1/queries/outreach.activity', { body: { workspaceId: ws, period } }),
      ),
    `results:${ws}:${period}`,
    W.tabs.results,
  );
  const tracking = useOutreachAnswer(
    async () =>
      unwrap(
        await api.POST('/v1/queries/outreach.tracking', { body: { workspaceId: ws, period } }),
      ),
    `results-numbers:${ws}:${period}`,
    W.tabs.results,
  );
  // Owners and admins see everyone's openers; anyone else, their own.
  const openers = useOutreachAnswer(
    async () =>
      unwrap(
        await api.POST('/v1/queries/outreach.openers', {
          body: { workspaceId: ws, everyone: ctx.manages },
        }),
      ),
    `results-openers:${ws}:${ctx.manages}`,
    W.tabs.results,
  );
  return (
    <PersonMenuScope
      workspaceId={ws}
      online={ctx.online}
      writesContacts={ctx.writesContacts}
      onChanged={activity.reload}
    >
      <ResultsBody
        activity={activity.data}
        tracking={tracking.data}
        error={activity.error}
        period={period}
        onPeriod={setPeriod}
        onRetry={activity.reload}
        onWeb={() => openOutreach(ws, 'activity', `period=${period}`)}
        onPartners={() => switchOutreach(ws, 'partners')}
        posts={<TouchedPostsPart workspaceId={ws} period={period} />}
        openers={openers.data}
      />
    </PersonMenuScope>
  );
}

export function ResultsBody({
  activity,
  tracking = null,
  error,
  period,
  onPeriod,
  onRetry,
  onWeb,
  onPartners,
  posts,
  openers = null,
}: {
  activity: ActivityOutput | null;
  /** The three numbers on top (./numbers.tsx): left out while they load, or when they don't. */
  tracking?: TrackingOutput | null;
  error: string | null;
  period: ActivityPeriod;
  onPeriod: (period: ActivityPeriod) => void;
  onRetry: () => void;
  /** Person by person, on the web. */
  onWeb: () => void;
  /** The Partners list, from its card. */
  onPartners?: () => void;
  /** The posts liked and commented on (./posted.tsx), under the numbers. */
  posts?: React.ReactNode;
  /** Which openers work: left out while they load, or when they don't. */
  openers?: OpenersOutput | null;
}) {
  const R = W.results;
  const n = activity?.numbers;
  return (
    <OutreachFrame page="results" testID="outreach-results">
      <Segmented
        label="How far back"
        value={period}
        onChange={onPeriod}
        options={ACTIVITY_PERIOD_KEYS.map((k) => ({
          value: k,
          label: ACTIVITY_PERIODS[k].label,
          testID: `results-period-${k}`,
        }))}
      />
      {!n ? (
        error ? (
          <NeedsSignal words={error} onRetry={onRetry} testID="results-needs-signal" />
        ) : null
      ) : (
        <>
          {tracking ? <NumbersPart tracking={tracking} /> : null}
          <Text className="text-[22px] font-semibold leading-[28px]" testID="results-headline">
            {R.headline(n.demos)}{' '}
            <Text className="font-medium text-text-2">{R.from(n.people)}</Text>
          </Text>
          <View className="flex-row flex-wrap gap-2.5" testID="results-funnel">
            {FUNNEL.map((key, i) => {
              const before = i > 0 ? FUNNEL[i - 1]! : null;
              const of = before ? n[before] : 0;
              const pct = before && of > 0 ? Math.round((n[key] / of) * 100) : null;
              const last = key === 'demos';
              return (
                <Card
                  key={key}
                  className={cn(
                    'min-w-[45%] flex-1 gap-1 px-4 py-3.5',
                    last && 'border-success-soft bg-success-soft',
                  )}
                  testID={`results-${key}`}
                >
                  <Text
                    className={cn(
                      'text-[13px] font-medium',
                      last ? 'text-success-text' : 'text-text-2',
                    )}
                  >
                    {R.funnel[key]}
                  </Text>
                  <Text className={cn('text-[24px] font-semibold', last && 'text-success-text')}>
                    {n[key].toLocaleString('en-US')}
                  </Text>
                  <Text className={cn('text-[12px]', last ? 'text-success-text' : 'text-text-3')}>
                    {pct !== null && before ? R.rate(pct, R.funnel[before]) : ' '}
                  </Text>
                </Card>
              );
            })}
          </View>
          <Part title={R.along}>
            <Card className="flex-row flex-wrap gap-x-5 gap-y-2 px-4 py-3.5">
              {ALONG.map((a) => (
                <Text key={a.key} className="text-[14px] text-text-2" testID={`results-${a.key}`}>
                  {a.label}{' '}
                  <Text className="font-semibold text-text">
                    {n[a.key].toLocaleString('en-US')}
                  </Text>
                </Text>
              ))}
            </Card>
          </Part>
          {activity.groups.length ? (
            <Part title="Groups that bring results" testID="results-groups">
              <Card className="px-4 py-1">
                {activity.groups.slice(0, GROUPS_SHOWN).map((g, i) => (
                  <View
                    key={g.groupId}
                    className={cn('gap-0.5 py-3', i > 0 && 'border-t border-border')}
                  >
                    <Text className="text-[15px] font-medium" numberOfLines={1}>
                      {g.name ?? 'A group'}
                    </Text>
                    <Note>
                      {`${g.people.toLocaleString('en-US')} reached · ${g.replies.toLocaleString('en-US')} wrote back · ${g.demos.toLocaleString('en-US')} booked`}
                    </Note>
                  </View>
                ))}
              </Card>
            </Part>
          ) : null}
          {activity.topics.length ? (
            <Part title="Hashtags and searches that bring results" testID="results-topics">
              <Card className="px-4 py-1">
                {activity.topics.slice(0, GROUPS_SHOWN).map((t, i) => (
                  <View
                    key={`${t.platform} ${t.words}`}
                    className={cn('gap-0.5 py-3', i > 0 && 'border-t border-border')}
                  >
                    <Text className="text-[15px] font-medium" numberOfLines={1}>
                      {topicName(t)}
                    </Text>
                    <Note>
                      {`${t.people.toLocaleString('en-US')} reached · ${t.replies.toLocaleString('en-US')} wrote back · ${t.demos.toLocaleString('en-US')} booked`}
                    </Note>
                  </View>
                ))}
              </Card>
            </Part>
          ) : null}
          {activity.partners ? (
            <Part title={PARTNER_WORDS.results.title} testID="results-partners">
              <Card className="flex-row flex-wrap gap-x-5 gap-y-2 px-4 py-3.5">
                {(['asked', 'interested', 'calls', 'partners'] as const).map((key) => (
                  <Text
                    key={key}
                    className="text-[14px] text-text-2"
                    testID={`results-partners-${key}`}
                  >
                    {PARTNER_WORDS.results[key]}{' '}
                    <Text className="font-semibold text-text">
                      {activity.partners![key].toLocaleString('en-US')}
                    </Text>
                  </Text>
                ))}
              </Card>
              {onPartners ? (
                <Text
                  role="link"
                  onPress={onPartners}
                  className="px-1 text-[14px] font-medium text-accent-text"
                  testID="results-partners-open"
                >
                  {PARTNER_WORDS.results.open}
                </Text>
              ) : null}
            </Part>
          ) : null}
          {posts}
          {activity.people.length ? (
            <Part title={AP.title} about={AP.latestFirst} testID="results-by-person">
              <Card className="px-4 py-1">
                {activity.people.map((p, i) => (
                  <View
                    key={p.profileId}
                    className={cn('gap-1 py-3', i > 0 && 'border-t border-border')}
                    testID="results-person"
                  >
                    <View className="flex-row flex-wrap items-center gap-2">
                      <PersonName
                        who={{
                          profileId: p.profileId,
                          name: p.name,
                          url: p.url,
                          platform: p.platform,
                          personId: p.personId,
                        }}
                      />
                      <NetworkName platform={p.platform} />
                      <Text className="ml-auto text-[12.5px] text-text-3">
                        {relativeTimeAgo(p.lastAt)}
                      </Text>
                    </View>
                    {p.group ? <Note>{AP.fromGroup(p.group.name)}</Note> : null}
                    <View className="flex-row flex-wrap gap-1.5">
                      {activityStepsOf(p).map((s) => (
                        <Badge
                          key={s.key}
                          variant={s.key === 'repliedAt' ? 'ok' : 'gray'}
                          testID={`results-person-${s.key}`}
                        >
                          <Text>{`${s.label} · ${relativeTimeAgo(s.at)}`}</Text>
                        </Badge>
                      ))}
                    </View>
                  </View>
                ))}
              </Card>
              {activity.morePeople ? <Note>{AP.more(activity.morePeople)}</Note> : null}
            </Part>
          ) : null}
          {openers ? <OpenersPart openers={openers} /> : null}
          <Text
            role="link"
            onPress={onWeb}
            className="px-1 text-[14px] font-medium text-accent-text"
            testID="results-on-web"
          >
            {W.results.onWeb}
          </Text>
        </>
      )}
    </OutreachFrame>
  );
}

/** Which openers work (decision 129): for each playbook, its openers with what came of the first messages sent. */
export function OpenersPart({ openers }: { openers: OpenersOutput }) {
  const shown = openers.playbooks.filter((p) => p.openers.length);
  if (!shown.length) return null;
  return (
    <Part title={O.title} about={O.about(openers.everyone)} testID="results-openers">
      {shown.map((p) => {
        const best = bestOpenerOf(p.openers);
        return (
          <Card key={p.playbookId} className="gap-1 px-4 py-2">
            <Text className="pt-1 text-[12.5px] font-semibold uppercase tracking-[0.5px] text-text-3">
              {p.name}
            </Text>
            {p.openers.map((o, i) => (
              <View
                key={`${o.kind}:${o.text}`}
                className={cn('gap-1 py-2.5', i > 0 && 'border-t border-border')}
                testID="results-opener"
              >
                <Text className="text-[14.5px]">{openerShort(o.text)}</Text>
                <View className="flex-row flex-wrap items-center gap-1.5">
                  <Note>
                    {o.current ? OPENER_KINDS[o.kind] : `${OPENER_KINDS[o.kind]} · ${O.notNow}`}
                  </Note>
                  {o === best ? (
                    <Badge variant="accent" testID="results-opener-best">
                      <Text>{O.best}</Text>
                    </Badge>
                  ) : null}
                </View>
                <Note>{o.sent ? `${O.replies(o)} · ${O.demos(o.demos)}` : O.replies(o)}</Note>
              </View>
            ))}
          </Card>
        );
      })}
    </Part>
  );
}
