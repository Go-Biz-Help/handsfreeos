import {
  OUTREACH_PAGE_ABOUT,
  OUTREACH_PAGE_KEYS,
  OUTREACH_PAGES,
  type OutreachPage,
} from '@hfos/core/addons/outreach/pages';
import {
  SET_UP_PAGE_WORDS,
  setUpInMenu,
  setupDoneOf,
} from '@hfos/core/addons/outreach/set-up-page';
import { SETUP_WORDS } from '@hfos/core/addons/outreach/setup';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import type { LucideIcon } from 'lucide-react-native';
import * as React from 'react';

import {
  BookOpen,
  ChartColumn,
  Inbox,
  ListChecks,
  Search,
  Settings2,
  Sun,
  Users,
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
 * Social Outreach's first screen on the phone (decision 127), where its row under More opens: its pages, in the web's
 * side-menu order, each with what it's for. Set up is first, with how far it's come ("6 of 9"), while anything's left
 * and the reminder isn't hidden (decision 129). Needs you says how many messages wait for the person's OK, from the
 * phone's own copy, so it reads the same with no signal. Each page opens as its own screen over this one, so Back
 * comes here.
 */

/** Each page's screen, as the web's `?view=` names it. */
const PAGE_VIEW: Readonly<Record<OutreachPage, OutreachTab>> = {
  setup: 'setup',
  'needs-you': 'waiting',
  today: 'today',
  people: 'pipeline',
  find: 'find',
  results: 'results',
  playbooks: 'playbooks',
  gear: 'settings',
};

const PAGE_ICON: Readonly<Record<OutreachPage, LucideIcon>> = {
  setup: ListChecks,
  'needs-you': Inbox,
  today: Sun,
  people: Users,
  find: Search,
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
      setupLeft={
        setup.data && setUpInMenu(setup.data)
          ? setupDoneOf({ states: setup.data.states, networks: setup.data.networks })
          : null
      }
    />
  );
}

export function OutreachHomeBody({
  workspaceId,
  messages,
  setUp = true,
  setupLeft = null,
}: {
  workspaceId: string;
  /** Messages waiting for the person's OK, replies handed over among them. */
  messages: number;
  /** Whether the person finished setting it up (decision 45): until then, it says to do that on a computer. */
  setUp?: boolean;
  /** How far the setup has come, while Set up is listed (`setUpInMenu`): null once it's gone. */
  setupLeft?: { readonly done: number; readonly of: number } | null;
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
          if (page === 'setup') {
            if (!setupLeft) return null;
            const words = SET_UP_PAGE_WORDS.menuCountLabel(setupLeft.done, setupLeft.of);
            return (
              <ListRow
                key={page}
                icon={PAGE_ICON[page]}
                label={OUTREACH_PAGES[page]}
                detail={OUTREACH_PAGE_ABOUT[page]}
                end={
                  <Badge variant="gray">
                    {SET_UP_PAGE_WORDS.menuCount(setupLeft.done, setupLeft.of)}
                  </Badge>
                }
                endWords={words}
                onPress={() => openOutreach(workspaceId, PAGE_VIEW[page])}
                testID={`outreach-page-${page}`}
              />
            );
          }
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
