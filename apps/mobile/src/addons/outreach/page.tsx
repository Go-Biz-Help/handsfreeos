import { SETUP_WORDS, type SetupOutput } from '@hfos/core/addons/outreach/setup';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import * as React from 'react';

import {
  BookOpen,
  CalendarCheck,
  ChartLine,
  Inbox,
  MessagesSquare,
  Radar,
  Settings2,
  UserPlus,
  Users,
} from '@/components/icons';
import { List, ListLabel, ListRow } from '@/components/shell/list';
import { Screen } from '@/components/shell/screen';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { openWebPath } from '@/home/open';
import { api, unwrap } from '@/lib/api';

import { ChatsScreen } from './chats';
import { useOutreachWaiting } from './copy';
import { GroupsScreen } from './groups';
import {
  Note,
  openOutreach,
  outreachPath,
  useOutreachAnswer,
  useOutreachContext,
  type OutreachTab,
  type WebTab,
} from './kit';
import { LiveScreen } from './live';
import { PlaybooksScreen } from './playbooks';
import { SettingsScreen } from './settings';
import { TodayScreen } from './today';
import { WaitingScreen } from './waiting';

/**
 * Social Outreach's page on the phone (decision 44), by its address's `?view=`, as the web's: Waiting for you, the live
 * view, Today, Groups, Chats, Playbooks and Settings are the phone's own screens. Activity and Friends have a lot to
 * look through, so they stay on the web: a link to them opens there (the manifest's `ui.phone` `web`), and this says
 * so if one is opened here anyway. With no `?view=`, the add-on's own first screen: a row for each, and, until the
 * person has set Social Outreach up (decision 45, the web's setup), a line saying to do that on a computer.
 */

const PHONE_TABS: readonly OutreachTab[] = [
  'waiting',
  'live',
  'today',
  'groups',
  'chats',
  'playbooks',
  'settings',
];
const WEB_TABS: readonly WebTab[] = ['activity', 'friends'];

export function OutreachPage({
  view,
  for: whose,
  show,
  tag,
  q,
}: {
  view?: string;
  for?: string;
  show?: string;
  tag?: string;
  q?: string;
}) {
  const tab = PHONE_TABS.find((t) => t === view);
  const webTab = WEB_TABS.find((t) => t === view);
  switch (tab) {
    case 'waiting':
      return <WaitingScreen />;
    case 'live':
      return <LiveScreen />;
    case 'today':
      return <TodayScreen />;
    case 'groups':
      return <GroupsScreen show={show} q={q} />;
    case 'chats':
      return <ChatsScreen show={show} tag={tag} q={q} />;
    case 'playbooks':
      return <PlaybooksScreen />;
    case 'settings':
      return <SettingsScreen whose={whose} />;
    default:
      return webTab ? <WebOnlyScreen tab={webTab} /> : <OutreachHome />;
  }
}

/**
 * The add-on's first screen: a row for each of its tabs, and what waits for the person, from the phone's copy. It points
 * to the setup until the person has finished it (`finishedAt` in HandsFreeOS's answer, with signal), whether or not the
 * web's "Finish setting up" line was hidden.
 */
export function OutreachHome() {
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
    <OutreachHomeRows
      workspaceId={ctx.workspaceId}
      messages={waiting.kinds.message.count + waiting.kinds.reply.count}
      setUp={isSetUp(setup.data)}
    />
  );
}

/**
 * Whether the person has set Social Outreach up, for the phone's line (decision 45): only once they finished the
 * setup. Hiding the web's "Finish setting up" line doesn't count. With no answer yet, the line waits.
 */
export const isSetUp = (setup: Pick<SetupOutput, 'finishedAt'> | null): boolean =>
  setup === null || setup.finishedAt !== null;

export function OutreachHomeRows({
  workspaceId,
  messages,
  setUp = true,
}: {
  workspaceId: string;
  messages: number;
  /** False until the person has set Social Outreach up: the screen says to do that on a computer. */
  setUp?: boolean;
}) {
  const open = (tab: OutreachTab | WebTab) => () => openOutreach(workspaceId, tab);
  return (
    <Screen title={W.title} leading="back" testID="outreach-home">
      {setUp ? null : (
        <Card className="px-4 py-3.5" testID="outreach-set-up-on-computer">
          <Note>{SETUP_WORDS.onPhone}</Note>
        </Card>
      )}
      <List>
        <ListRow
          icon={Inbox}
          label={W.rows.waiting}
          detail={W.waitingMore(messages)}
          end={
            messages > 0 ? (
              <Badge variant="accent">
                <Text>{messages.toLocaleString('en-US')}</Text>
              </Badge>
            ) : undefined
          }
          onPress={open('waiting')}
          testID="outreach-row-waiting"
        />
        <ListRow
          icon={Radar}
          label={W.rows.live}
          detail={W.rowDetails.live}
          onPress={open('live')}
          testID="outreach-row-live"
        />
        <ListRow
          icon={CalendarCheck}
          label={W.rows.today}
          detail={W.rowDetails.today}
          onPress={open('today')}
          testID="outreach-row-today"
        />
        <ListRow
          icon={Users}
          label={W.rows.groups}
          detail={W.rowDetails.groups}
          onPress={open('groups')}
          testID="outreach-row-groups"
        />
        <ListRow
          icon={MessagesSquare}
          label={W.rows.chats}
          detail={W.rowDetails.chats}
          onPress={open('chats')}
          testID="outreach-row-chats"
        />
        <ListRow
          icon={BookOpen}
          label={W.rows.playbooks}
          detail={W.rowDetails.playbooks}
          onPress={open('playbooks')}
          testID="outreach-row-playbooks"
        />
        <ListRow
          icon={Settings2}
          label={W.rows.settings}
          detail={W.rowDetails.settings}
          onPress={open('settings')}
          testID="outreach-row-settings"
        />
      </List>
      <ListLabel>{W.onTheWeb}</ListLabel>
      <List>
        <ListRow
          icon={ChartLine}
          label={W.rows.activity}
          external
          onPress={open('activity')}
          testID="outreach-row-activity"
        />
        <ListRow
          icon={UserPlus}
          label={W.rows.friends}
          external
          onPress={open('friends')}
          testID="outreach-row-friends"
        />
      </List>
    </Screen>
  );
}

/** A tab the phone leaves to the web, opened here anyway: what it is, and a button to open it there. */
export function WebOnlyScreen({ tab }: { tab: WebTab }) {
  const ctx = useOutreachContext();
  return <WebOnlyBody tab={tab} workspaceId={ctx.workspaceId} />;
}

export function WebOnlyBody({ tab, workspaceId }: { tab: WebTab; workspaceId: string }) {
  const what = W.rows[tab];
  return (
    <Screen title={what} leading="back" testID="outreach-web-only">
      <Card className="gap-3 px-5 py-6">
        <Text className="text-[16px] font-semibold">{W.webOnlyTitle(what)}</Text>
        <Text className="text-[14.5px] leading-[21px] text-text-2">{W.webOnlyBody}</Text>
        <Button
          variant="secondary"
          onPress={() => openWebPath(outreachPath(workspaceId, tab))}
          testID="outreach-open-web"
        >
          {W.openOnTheWeb}
        </Button>
      </Card>
    </Screen>
  );
}
