import {
  OUTREACH_PAGE_ABOUT,
  OUTREACH_PAGE_KEYS,
  OUTREACH_PAGES,
  type OutreachPage,
} from '@hfos/core/addons/outreach/pages';
import { SETUP_WORDS } from '@hfos/core/addons/outreach/setup';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import type { LucideIcon } from 'lucide-react-native';
import * as React from 'react';

import {
  BookOpen,
  ChartColumn,
  Inbox,
  Settings2,
  Sun,
  Users,
  UsersRound,
} from '@/components/icons';
import { List, ListRow } from '@/components/shell/list';
import { Screen } from '@/components/shell/screen';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { api, unwrap } from '@/lib/api';

import { useOutreachWaiting } from './copy';
import {
  isSetUp,
  Note,
  openOutreach,
  useOutreachAnswer,
  useOutreachContext,
  type OutreachTab,
} from './kit';

/**
 * Social Outreach's first screen on the phone (decision 126), where its row under More opens: its pages, in the web's
 * side-menu order, each with what it's for. Needs you says how many messages wait for the person's OK, from the
 * phone's own copy, so it reads the same with no signal. Each page opens as its own screen over this one, so Back
 * comes here.
 */

/** Each page's screen, as the web's `?view=` names it. */
const PAGE_VIEW: Readonly<Record<OutreachPage, OutreachTab>> = {
  'needs-you': 'waiting',
  today: 'today',
  people: 'pipeline',
  groups: 'groups',
  results: 'results',
  playbooks: 'playbooks',
  gear: 'settings',
};

const PAGE_ICON: Readonly<Record<OutreachPage, LucideIcon>> = {
  'needs-you': Inbox,
  today: Sun,
  people: Users,
  groups: UsersRound,
  results: ChartColumn,
  playbooks: BookOpen,
  gear: Settings2,
};

export function OutreachHomeScreen() {
  const ctx = useOutreachContext();
  const waiting = useOutreachWaiting(ctx.workspaceId, ctx.userId);
  const setup = useOutreachAnswer(
    async () =>
      unwrap(
        await api.POST('/v1/queries/outreach.setup', { body: { workspaceId: ctx.workspaceId } }),
      ),
    `setup:${ctx.workspaceId}`,
    W.title,
  );
  return (
    <OutreachHomeBody
      workspaceId={ctx.workspaceId}
      messages={waiting.kinds.message.count + waiting.kinds.reply.count}
      setUp={isSetUp(setup.data)}
    />
  );
}

export function OutreachHomeBody({
  workspaceId,
  messages,
  setUp = true,
}: {
  workspaceId: string;
  /** Messages waiting for the person's OK, replies handed over among them. */
  messages: number;
  /** Whether the person finished setting it up (decision 45): until then, it says to do that on a computer. */
  setUp?: boolean;
}) {
  return (
    <Screen title={W.title} leading="back" testID="outreach-home">
      {setUp ? null : (
        <Card className="px-4 py-3.5" testID="outreach-set-up-on-computer">
          <Note>{SETUP_WORDS.onPhone}</Note>
        </Card>
      )}
      <List testID="outreach-pages">
        {OUTREACH_PAGE_KEYS.map((page) => {
          const count = page === 'needs-you' ? messages : 0;
          return (
            <ListRow
              key={page}
              icon={PAGE_ICON[page]}
              label={OUTREACH_PAGES[page]}
              detail={count ? W.waitingMore(count) : OUTREACH_PAGE_ABOUT[page]}
              end={
                count ? <Badge variant="accent">{count.toLocaleString('en-US')}</Badge> : undefined
              }
              endWords={count ? W.waitingMore(count) : undefined}
              onPress={() => openOutreach(workspaceId, PAGE_VIEW[page])}
              testID={`outreach-page-${page}`}
            />
          );
        })}
      </List>
    </Screen>
  );
}
