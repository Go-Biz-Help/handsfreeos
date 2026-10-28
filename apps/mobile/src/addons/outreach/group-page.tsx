import {
  GROUP_PEOPLE_VIEW_KEYS,
  GROUP_PEOPLE_VIEWS,
  type GroupPeopleOutput,
  type GroupPeopleView,
} from '@hfos/core/addons/outreach/journey';
import { PLATFORMS } from '@hfos/core/addons/outreach/networks';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import { router, type Href } from 'expo-router';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { ExternalLink } from '@/components/icons';
import { businessHref } from '@/components/shell/business-context';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Segmented } from '@/components/ui/segmented';
import { Text } from '@/components/ui/text';
import { api, unwrap } from '@/lib/api';

import { OutreachFrame } from './frame';
import { NeedsSignal, Note, openOutside, useOutreachAnswer, useOutreachContext } from './kit';

/**
 * A group's own page on the phone (`?view=groups&group=`, decision 103), the web's: everyone the extension found in
 * it, its admins and moderators marked, and how each turned out for the person, the furthest first, then who's still
 * to reach; one outcome at a time (`?show=`), counted, with Show more for the next page. A customer opens their page,
 * anyone else their profile. It needs signal.
 */

export const groupPeopleViewOf = (show: string | undefined): GroupPeopleView =>
  GROUP_PEOPLE_VIEW_KEYS.find((k) => k === show) ?? 'all';

type Person = GroupPeopleOutput['people'][number];

/** Each outcome's badge, as the pipeline's: a client's is green, not a fit and not reached grey. */
const badgeOf = (p: Person): 'ok' | 'gray' | 'accent' =>
  p.stage === 'client' ? 'ok' : p.stage === 'lost' || !p.stage ? 'gray' : 'accent';

export function GroupPageScreen({ groupId, show }: { groupId: string; show?: string }) {
  const ctx = useOutreachContext();
  const ws = ctx.workspaceId;
  const [view, setView] = React.useState<GroupPeopleView>(groupPeopleViewOf(show));
  const [pages, setPages] = React.useState(1);
  React.useEffect(() => setPages(1), [view]);
  const answer = useOutreachAnswer(
    async () => {
      const all: GroupPeopleOutput[] = [];
      for (let page = 1; page <= pages; page++)
        all.push(
          unwrap(
            await api.POST('/v1/queries/outreach.group.people', {
              body: { workspaceId: ws, groupId, view, page },
            }),
          ),
        );
      const last = all[all.length - 1]!;
      return { ...last, people: all.flatMap((a) => a.people) };
    },
    `group-people:${ws}:${groupId}:${view}:${pages}`,
    W.rows.groups,
  );
  return (
    <GroupPageBody
      workspaceId={ws}
      view={view}
      onView={setView}
      page={answer.data}
      error={answer.error}
      onRetry={answer.reload}
      onMore={() => setPages((p) => p + 1)}
    />
  );
}

export function GroupPageBody({
  workspaceId,
  view,
  onView,
  page,
  error,
  onRetry,
  onMore,
}: {
  workspaceId: string;
  view: GroupPeopleView;
  onView: (v: GroupPeopleView) => void;
  page: GroupPeopleOutput | null;
  error: string | null;
  onRetry: () => void;
  onMore: () => void;
}) {
  const open = (p: Person) =>
    p.personId
      ? router.push(businessHref(workspaceId, `customers/people/${p.personId}`) as Href)
      : openOutside(p.url);
  return (
    <OutreachFrame tab="groups" subtitle={page?.group.name ?? undefined} testID="outreach-group">
      {page ? (
        <>
          <Card className="gap-1.5 px-4 py-3.5" testID="group-page-head">
            <Text className="text-[16px] font-semibold" testID="group-page-name">
              {page.group.name ?? 'This group'}
            </Text>
            <Note>
              {[
                PLATFORMS[page.group.platform],
                page.group.members !== null
                  ? `${page.group.members.toLocaleString()} members`
                  : null,
                page.group.joined ? 'You’re in it' : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </Note>
            <Note testID="group-page-summary">
              {`${page.counts.all.toLocaleString()} found here, ${(page.counts.all - page.counts.not_reached).toLocaleString()} reached`}
            </Note>
            <Button
              size="sm"
              variant="ghost"
              icon={ExternalLink}
              className="self-start"
              onPress={() => openOutside(page.group.url)}
            >
              {`Open on ${PLATFORMS[page.group.platform]}`}
            </Button>
          </Card>
          <Segmented
            value={view}
            onChange={onView}
            label="Who"
            options={GROUP_PEOPLE_VIEW_KEYS.filter(
              (k) => k === 'all' || k === view || page.counts[k] > 0,
            ).map((k) => ({
              value: k,
              label: `${GROUP_PEOPLE_VIEWS[k]} ${page.counts[k]}`,
              testID: `group-page-view-${k}`,
            }))}
          />
          {page.people.length ? (
            <>
              {page.people.map((p) => (
                <Pressable
                  key={p.profileId}
                  role="button"
                  accessibilityLabel={p.name}
                  onPress={() => open(p)}
                  testID="group-page-person"
                >
                  <Card className="gap-1 px-4 py-3.5">
                    <View className="flex-row flex-wrap items-center gap-2">
                      <Text className="text-[15px] font-semibold text-accent-text">{p.name}</Text>
                      <Badge variant={badgeOf(p)} testID="group-page-stage">
                        <Text>
                          {p.stage ? GROUP_PEOPLE_VIEWS[p.stage] : GROUP_PEOPLE_VIEWS.not_reached}
                        </Text>
                      </Badge>
                    </View>
                    <Note>
                      {[...p.why, p.part ? `Found in ${p.part}` : null].filter(Boolean).join(' · ')}
                    </Note>
                    {p.nextStep ? <Note>{`${W.nextStepLabel}: ${p.nextStep}`}</Note> : null}
                  </Card>
                </Pressable>
              ))}
              {page.page < page.pages ? (
                <Button variant="secondary" onPress={onMore} testID="group-page-more">
                  {W.more}
                </Button>
              ) : null}
            </>
          ) : (
            <Card className="gap-1.5 px-5 py-6" testID="group-page-empty">
              <Text className="text-[16px] font-semibold">Nobody here yet</Text>
              <Note>
                {page.counts.all
                  ? 'Nobody found in this group is at this point. Pick another above.'
                  : 'Nobody from this group is saved yet. Ask your computer to save its members on Groups.'}
              </Note>
            </Card>
          )}
        </>
      ) : error ? (
        <NeedsSignal words={error} onRetry={onRetry} testID="group-page-needs-signal" />
      ) : null}
    </OutreachFrame>
  );
}
