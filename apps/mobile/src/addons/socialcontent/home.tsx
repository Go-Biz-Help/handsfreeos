import type { Overview } from '@hfos/core/addons/socialcontent/shapes';
import { SOCIALCONTENT_WORDS as W } from '@hfos/core/addons/socialcontent/words';
import type { LucideIcon } from 'lucide-react-native';
import * as React from 'react';

import {
  BookOpen,
  CalendarDays,
  Lightbulb,
  Settings2,
  TrendingUp,
  Users,
} from '@/components/icons';
import { List, ListRow } from '@/components/shell/list';
import { Screen } from '@/components/shell/screen';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { api, unwrap } from '@/lib/api';

import {
  Note,
  openSocialcontent,
  PAGE_TITLES,
  useSocialcontentAnswer,
  useSocialcontentContext,
  type SocialcontentPage,
} from './kit';

/**
 * AI Social Media Content Creator's first screen on the phone (docs/socialcontent.md, parts 5 and 12): its pages, the ones the
 * web's side menu pops out of its one row, each with what it holds. With signal, Creators and Standouts carry their
 * counts, and it says when no computer reads the networks yet. With none, the pages still list, and each says it
 * needs signal when opened.
 */

type Page = Exclude<SocialcontentPage, ''>;

const PAGES: readonly { page: Page; icon: LucideIcon }[] = [
  { page: 'creators', icon: Users },
  { page: 'standouts', icon: TrendingUp },
  { page: 'playbook', icon: BookOpen },
  { page: 'ideas', icon: Lightbulb },
  { page: 'calendar', icon: CalendarDays },
  { page: 'settings', icon: Settings2 },
];

export function SocialcontentHome() {
  const ctx = useSocialcontentContext();
  const ws = ctx.workspaceId;
  const answer = useSocialcontentAnswer<Overview>(
    async () =>
      unwrap(await api.POST('/v1/queries/socialcontent.overview', { body: { workspaceId: ws } })),
    `socialcontent-home:${ws}`,
    W.title,
  );
  return <SocialcontentHomeBody overview={answer.data} onOpen={(p) => openSocialcontent(ws, p)} />;
}

/** What each page's row says under its name: its counts once they've come. */
export function pageDetail(page: Page, overview: Overview | null): string {
  switch (page) {
    case 'creators':
      return W.phone.pages.creators(
        overview?.counts.studying ?? 0,
        overview?.counts.suggested ?? 0,
      );
    case 'standouts':
      return W.phone.pages.standouts(overview?.counts.standouts ?? 0);
    case 'playbook':
      return W.phone.pages.playbook;
    case 'ideas':
      return W.phone.pages.ideas;
    case 'calendar':
      return W.phone.pages.calendar;
    case 'settings':
      return W.phone.pages.gear;
  }
}

export function SocialcontentHomeBody({
  overview,
  onOpen,
}: {
  overview: Overview | null;
  onOpen: (page: Page) => void;
}) {
  return (
    <Screen title={W.title} leading="back" testID="socialcontent-home">
      {overview && !overview.settings.readerUserId ? (
        <Card
          className="border-warning-soft bg-warning-soft/40 p-4"
          testID="socialcontent-home-needs-reader"
        >
          <Text className="text-[13.5px] leading-[19px]">{W.needsReader}</Text>
        </Card>
      ) : null}
      <List testID="socialcontent-pages">
        {PAGES.map(({ page, icon }) => (
          <ListRow
            key={page}
            icon={icon}
            label={PAGE_TITLES[page]}
            detail={pageDetail(page, overview)}
            onPress={() => onOpen(page)}
            testID={`socialcontent-open-${page}`}
          />
        ))}
      </List>
      {overview && overview.counts.waiting ? (
        <Note testID="socialcontent-home-waiting">
          {W.settings.waiting(overview.counts.waiting)}
        </Note>
      ) : null}
    </Screen>
  );
}
