import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import * as Linking from 'expo-linking';
import { router, type Href } from 'expo-router';
import * as React from 'react';
import { View } from 'react-native';

import { CloudOff } from '@/components/icons';
import { useBusiness } from '@/components/shell/business-context';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { openWebPath } from '@/home/open';
import { config } from '@/lib/config';
import { targetOfLink } from '@/links/route-map';
import { useGrants } from '@/lib/grants';
import { useLiveAnswer, type LiveAnswer, type LiveAnswerOptions } from '@/lib/live-answer';
import { useNetwork } from '@/lib/network';

/**
 * What every Social Outreach screen on the phone shares (decision 44): who is looking, where its screens live, and how
 * a screen says what needs signal. Its words are core's (`@hfos/core/addons/outreach/words`).
 */

/** Social Outreach's permissions, as its manifest names them. */
export const OUTREACH_USE = 'outreach.use';
export const OUTREACH_MANAGE = 'outreach.manage';

/** The page's views the phone draws, as the web's `?view=` names them. */
export type OutreachTab =
  | 'waiting'
  | 'live'
  | 'today'
  | 'pipeline'
  | 'groups'
  | 'chats'
  | 'results'
  | 'playbooks'
  | 'settings';
/** The tabs the phone leaves to the web: they have a lot to look through (the manifest's `ui.phone` `web`). */
export type WebTab = 'activity' | 'friends';

/** A Social Outreach page's address, the web's own: `/app/w/<business>/a/outreach?view=waiting`. */
export function outreachPath(workspaceId: string, view?: OutreachTab | WebTab, more = ''): string {
  const query = [view ? `view=${view}` : '', more].filter(Boolean).join('&');
  return `/app/w/${workspaceId}/a/outreach${query ? `?${query}` : ''}`;
}

/** Opens a tab: the phone's screen, or the web's for the tabs it leaves there (the route map decides). */
export const openOutreach = (workspaceId: string, view?: OutreachTab | WebTab, more = '') =>
  openWebPath(outreachPath(workspaceId, view, more));

/**
 * Moves between the four tabs (decision 59): the screen is swapped for the tab's, rather than stacked on it, so Back
 * still leaves Social Outreach.
 */
export function switchOutreach(workspaceId: string, view: OutreachTab): void {
  const path = outreachPath(workspaceId, view);
  const target = targetOfLink(path, [config.webUrl]);
  if (target.kind === 'screen') router.replace(target.href as Href);
  else openWebPath(path);
}

/** Opens a playbook's screen. */
export const openPlaybook = (workspaceId: string, playbookId: string) =>
  openWebPath(`/app/w/${workspaceId}/a/outreach/playbooks/${playbookId}`);

/** Opens a page on Facebook or Messenger, in its app when the phone has it. */
export function openOutside(url: string | null): void {
  if (!url) return;
  void Linking.openURL(url).catch(() =>
    toast.error('This phone couldn’t open that page. Try again in a minute.'),
  );
}

export interface OutreachContext {
  readonly workspaceId: string;
  readonly userId: string;
  readonly timeZone: string;
  /** An owner's or admin's say: playbooks, business settings, the team (`outreach.manage`). */
  readonly manages: boolean;
  readonly online: boolean;
}

export function useOutreachContext(): OutreachContext {
  const { business, me } = useBusiness();
  const { permissions } = useGrants();
  const { online } = useNetwork();
  return React.useMemo(
    () => ({
      workspaceId: business.id,
      userId: me.user.id,
      timeZone: business.timezone || 'UTC',
      manages: permissions?.includes(OUTREACH_MANAGE) ?? false,
      online,
    }),
    [business.id, business.timezone, me.user.id, permissions, online],
  );
}

/**
 * Whether the person has set Social Outreach up, for the phone's line (decision 45): only once they finished the
 * setup. Hiding the web's "Finish setting up" line doesn't count. With no answer yet, the line waits.
 */
export const isSetUp = (setup: { readonly finishedAt: string | null } | null): boolean =>
  setup === null || setup.finishedAt !== null;

/** One of the server's answers for a screen: with no signal, the screen says it needs signal, plainly. */
export function useOutreachAnswer<T>(
  load: (() => Promise<T>) | null,
  key: string,
  screen: string,
  options?: LiveAnswerOptions,
): LiveAnswer<T> {
  return useLiveAnswer(load, key, W.needsSignal(screen), options);
}

/** A screen, or part of one, that needs HandsFreeOS, with no signal or after a failure: what it is, and Try again. */
export function NeedsSignal({
  words,
  onRetry,
  testID,
}: {
  words: string;
  onRetry?: () => void;
  testID?: string;
}) {
  return (
    <Card className="items-center gap-3 px-5 py-8" testID={testID ?? 'outreach-needs-signal'}>
      <Icon as={CloudOff} className="size-6 text-text-3" />
      <Text className="text-center text-[14.5px] leading-[21px] text-text-2">{words}</Text>
      {onRetry ? (
        <Button
          variant="secondary"
          className="self-stretch"
          onPress={onRetry}
          testID="outreach-retry"
        >
          {W.tryAgain}
        </Button>
      ) : null}
    </Card>
  );
}

/** A small line of help or state under a part of a screen. */
export function Note({ children, testID }: { children: React.ReactNode; testID?: string }) {
  return (
    <Text className="text-[13px] leading-[18px] text-text-2" testID={testID}>
      {children}
    </Text>
  );
}

/** "It goes when you’re back online.", under something pressed with no signal. */
export function QueuedNote({ online, testID }: { online: boolean; testID?: string }) {
  if (online) return null;
  return (
    <View className="flex-row items-center gap-1.5" testID={testID ?? 'outreach-queued-note'}>
      <Icon as={CloudOff} className="size-3.5 text-text-3" />
      <Text className="text-[12.5px] leading-[17px] text-text-3">{W.queued}</Text>
    </View>
  );
}

/** A part of a screen with a heading. */
export function Part({
  title,
  about,
  children,
  testID,
}: {
  title: string;
  about?: string | null;
  children?: React.ReactNode;
  testID?: string;
}) {
  return (
    <View className="gap-2" testID={testID}>
      <View className="gap-0.5 px-1">
        <Text className="text-[15px] font-semibold">{title}</Text>
        {about ? <Note>{about}</Note> : null}
      </View>
      {children}
    </View>
  );
}
