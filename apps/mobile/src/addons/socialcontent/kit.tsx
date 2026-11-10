import { networkName } from '@hfos/core/addons/socialcontent/networks';
import type { Work } from '@hfos/core/addons/socialcontent/shapes';
import {
  SOCIALCONTENT_PAGES,
  SOCIALCONTENT_WORDS as W,
} from '@hfos/core/addons/socialcontent/words';
import * as Linking from 'expo-linking';
import * as React from 'react';
import { View } from 'react-native';

import { ChangeError } from '@/changes';
import { CloudOff } from '@/components/icons';
import { useBusiness } from '@/components/shell/business-context';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { openWebPath } from '@/home/open';
import { errorMessage } from '@/lib/api';
import { useGrants } from '@/lib/grants';
import { useLiveAnswer, type LiveAnswer, type LiveAnswerOptions } from '@/lib/live-answer';
import { useNetwork } from '@/lib/network';

/**
 * What every AI Social Media Content Creator screen on the phone shares (docs/socialcontent.md, part 5): who is
 * looking, where its screens live, how a screen says what needs signal, and how a press runs. Its words are core's
 * (`@hfos/core/addons/socialcontent/words`). Everything it shows comes from HandsFreeOS with signal: the phone keeps
 * none of it.
 */

/** Its permissions, as its manifest names them. */
export const SOCIALCONTENT_USE = 'socialcontent.use';
export const SOCIALCONTENT_MANAGE = 'socialcontent.manage';

/** Its pages, as the web's addresses name them (`/a/socialcontent/creators`); '' is its first screen. */
export type SocialcontentPage =
  '' | 'creators' | 'standouts' | 'playbook' | 'ideas' | 'calendar' | 'settings';

/** A page's address, the web's own: `/app/w/<business>/a/socialcontent/standouts?network=instagram`. */
export function socialcontentPath(
  workspaceId: string,
  page: SocialcontentPage = '',
  query = '',
): string {
  return `/app/w/${workspaceId}/a/socialcontent${page ? `/${page}` : ''}${query ? `?${query}` : ''}`;
}

/** Opens one of its pages: the phone's screen (the route map decides), or the web's on a build without it. */
export const openSocialcontent = (workspaceId: string, page: SocialcontentPage = '', query = '') =>
  openWebPath(socialcontentPath(workspaceId, page, query));

/** A page's name, as the side menu has it. */
export const PAGE_TITLES: Readonly<Record<Exclude<SocialcontentPage, ''>, string>> = {
  creators: SOCIALCONTENT_PAGES.creators,
  standouts: SOCIALCONTENT_PAGES.standouts,
  playbook: SOCIALCONTENT_PAGES.playbook,
  ideas: SOCIALCONTENT_PAGES.ideas,
  calendar: SOCIALCONTENT_PAGES.calendar,
  settings: SOCIALCONTENT_PAGES.gear,
};

/** Opens a post or a creator's page on its network, in its app when the phone has it. */
export function openOutside(url: string | null): void {
  if (!url) return;
  void Linking.openURL(url).catch(() =>
    toast.error('This phone couldn’t open that page. Try again in a minute.'),
  );
}

export interface SocialcontentContext {
  readonly workspaceId: string;
  readonly userId: string;
  /** An owner's or admin's say: the networks, whose computer reads, watching videos (`socialcontent.manage`). */
  readonly manages: boolean;
  readonly online: boolean;
}

export function useSocialcontentContext(): SocialcontentContext {
  const { business, me } = useBusiness();
  const { permissions } = useGrants();
  const { online } = useNetwork();
  return React.useMemo(
    () => ({
      workspaceId: business.id,
      userId: me.user.id,
      manages: permissions?.includes(SOCIALCONTENT_MANAGE) ?? false,
      online,
    }),
    [business.id, me.user.id, permissions, online],
  );
}

/** One of HandsFreeOS's answers for a screen: with no signal, the screen says it needs signal, plainly. */
export function useSocialcontentAnswer<T>(
  load: (() => Promise<T>) | null,
  key: string,
  screen: string,
  options?: LiveAnswerOptions,
): LiveAnswer<T> {
  return useLiveAnswer(load, key, W.phone.needsSignal(screen), options);
}

/** What a press runs: what it was, how it's run, and the words to say once it's done. */
export type Act = <T>(
  key: string,
  run: () => Promise<T>,
  done?: string | ((out: T) => string),
) => Promise<T | null>;

/**
 * Runs a press the way the web's pages do: busy while it runs (`busy` names what's running, so only its button
 * spins), the refusal's own words when it's refused, a short toast when it's done, then the screen asked again.
 */
export function useAct(after?: () => void): { busy: string | null; act: Act } {
  const [busy, setBusy] = React.useState<string | null>(null);
  const latest = React.useRef(after);
  latest.current = after;
  const act = React.useCallback<Act>(async (key, run, done) => {
    setBusy(key);
    try {
      const out = await run();
      const words = typeof done === 'function' ? done(out) : done;
      if (words) toast.show(words);
      latest.current?.();
      return out;
    } catch (e) {
      toast.error(e instanceof ChangeError ? e.message : errorMessage(e));
      return null;
    } finally {
      setBusy(null);
    }
  }, []);
  return { busy, act };
}

/** Now, ticking each half minute, so "checked in 1 minute ago" stays true. */
export function useNow(): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** What a piece of work is about: "Find creators for “CRM software” on Instagram". */
export function workWhat(w: Work): string {
  const network = networkName(w.network);
  return w.kind === 'find'
    ? W.work.kinds.find(w.nicheName ?? '', network)
    : W.work.kinds[w.kind](w.creatorShown ?? '', network);
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
    <Card className="items-center gap-3 px-5 py-8" testID={testID ?? 'socialcontent-needs-signal'}>
      <Icon as={CloudOff} className="size-6 text-text-3" />
      <Text className="text-center text-[14.5px] leading-[21px] text-text-2">{words}</Text>
      {onRetry ? (
        <Button
          variant="secondary"
          className="self-stretch"
          onPress={onRetry}
          testID="socialcontent-retry"
        >
          {W.phone.tryAgain}
        </Button>
      ) : null}
    </Card>
  );
}

/** A small line of help or state. */
export function Note({ children, testID }: { children: React.ReactNode; testID?: string }) {
  return (
    <Text className="text-[13px] leading-[18px] text-text-2" testID={testID}>
      {children}
    </Text>
  );
}

/** A part of a screen on a card, with its heading, a line about it, and what sits beside the heading. */
export function Part({
  title,
  about,
  side,
  children,
  testID,
}: {
  title: string;
  about?: string | null;
  side?: React.ReactNode;
  children?: React.ReactNode;
  testID?: string;
}) {
  return (
    <Card className="gap-3 p-4" testID={testID}>
      <View className="gap-1">
        <View className="flex-row items-center gap-2">
          <Text className="flex-1 text-[15px] font-semibold">{title}</Text>
          {side}
        </View>
        {about ? <Note>{about}</Note> : null}
      </View>
      {children}
    </Card>
  );
}

/** A short group label inside a part ("YOUR NICHE"). */
export function Group({ children }: { children: string }) {
  return <Text variant="group">{children}</Text>;
}
