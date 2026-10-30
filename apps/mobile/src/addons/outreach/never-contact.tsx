import type { FriendsOutput } from '@hfos/core/addons/outreach/friends';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import * as React from 'react';
import { View } from 'react-native';

import { change, ChangeError } from '@/changes';
import { ExternalLink } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { api, errorMessage, unwrap } from '@/lib/api';

import { OutreachFrame } from './frame';
import { NeedsSignal, Note, openOutside, useOutreachAnswer, useOutreachContext } from './kit';

/**
 * The business's Never contact list on the phone's People tab (`?view=never_contact`), as the web's Friends tab has
 * it (`?view=friends&show=never_contact`): everyone on it, the latest added first, searched by name, with who added
 * them and when. Turning someone's switch off takes them off (`outreach.friend.set`, with signal only); only whoever
 * added them, or an owner or admin, may, and a refusal flips it back with why. The words are core's
 * (`OUTREACH_WORDS.neverContactList`).
 */

type Person = FriendsOutput['people'][number];

export function NeverContactScreen({ q }: { q?: string }) {
  const ctx = useOutreachContext();
  const ws = ctx.workspaceId;
  const [search, setSearch] = React.useState(q ?? '');
  const [asked, setAsked] = React.useState(q ?? '');
  const [pages, setPages] = React.useState(1);
  React.useEffect(() => {
    const t = setTimeout(() => setAsked(search.trim()), 400);
    return () => clearTimeout(t);
  }, [search]);
  React.useEffect(() => setPages(1), [asked]);
  const answer = useOutreachAnswer(
    async () => {
      const all: FriendsOutput[] = [];
      for (let page = 1; page <= pages; page++)
        all.push(
          unwrap(
            await api.POST('/v1/queries/outreach.friends', {
              body: {
                workspaceId: ws,
                view: 'never_contact',
                page,
                ...(asked ? { search: asked } : {}),
              },
            }),
          ),
        );
      const last = all[all.length - 1]!;
      return { ...last, people: all.flatMap((a) => a.people) };
    },
    `never-contact:${ws}:${asked}:${pages}`,
    W.rows.never_contact,
  );
  return (
    <NeverContactBody
      search={search}
      onSearch={setSearch}
      list={answer.data}
      error={answer.error}
      onRetry={answer.reload}
      onMore={() => setPages((p) => p + 1)}
      online={ctx.online}
      onTakeOff={async (profileId) => {
        await change('outreach.friend.set', { workspaceId: ws, profileId, neverContact: false });
        answer.reload();
      }}
    />
  );
}

export function NeverContactBody({
  search,
  onSearch,
  list,
  error,
  onRetry,
  onMore,
  online,
  onTakeOff,
}: {
  search: string;
  onSearch: (s: string) => void;
  list: FriendsOutput | null;
  error: string | null;
  onRetry: () => void;
  onMore: () => void;
  online: boolean;
  onTakeOff: (profileId: string) => Promise<void>;
}) {
  const N = W.neverContactList;
  return (
    <OutreachFrame page="people" people="never_contact" testID="outreach-never-contact">
      <Note>{N.about}</Note>
      <Input
        value={search}
        onChangeText={onSearch}
        placeholder={W.search}
        autoCorrect={false}
        testID="never-contact-search"
      />
      {list ? (
        list.people.length ? (
          <>
            {list.people.map((p) => (
              <NeverContactRow key={p.profileId} person={p} online={online} onTakeOff={onTakeOff} />
            ))}
            {list.page < list.pages ? (
              <Button variant="secondary" onPress={onMore} testID="never-contact-more">
                {W.more}
              </Button>
            ) : null}
            {!online ? <Note>{W.neverContactList.needsSignal}</Note> : null}
          </>
        ) : (
          <Card className="gap-1.5 px-5 py-6" testID="never-contact-empty">
            <Text className="text-[16px] font-semibold">
              {search.trim() ? N.noMatch.title : N.empty.title}
            </Text>
            <Note>{search.trim() ? N.noMatch.body : N.empty.body}</Note>
          </Card>
        )
      ) : error ? (
        <NeedsSignal words={error} onRetry={onRetry} testID="never-contact-needs-signal" />
      ) : null}
    </OutreachFrame>
  );
}

/** Someone on the list: their name, who added them and when, Facebook, and the switch that takes them off. */
function NeverContactRow({
  person: p,
  online,
  onTakeOff,
}: {
  person: Person;
  online: boolean;
  onTakeOff: (profileId: string) => Promise<void>;
}) {
  const [busy, setBusy] = React.useState(false);
  const takeOff = async () => {
    setBusy(true);
    try {
      await onTakeOff(p.profileId);
      toast.show(W.person.neverContactOff(p.name));
    } catch (e) {
      toast.error(e instanceof ChangeError ? e.message : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="gap-1.5 px-4 py-3.5" testID="never-contact-item">
      <View className="flex-row items-center justify-between gap-3">
        <View className="min-w-0 flex-1">
          <Text className="text-[15px] font-semibold">{p.name}</Text>
          <Note>
            {W.neverContactList.added(p.neverContact?.by ?? null, p.neverContact?.at ?? null)}
          </Note>
        </View>
        <Switch
          size="sm"
          label={`${W.person.neverContact} ${p.name}`}
          checked={!busy}
          disabled={busy || !online}
          onCheckedChange={(on) => {
            if (!on) void takeOff();
          }}
          testID="never-contact-switch"
        />
      </View>
      <View className="flex-row flex-wrap gap-2">
        <Button size="sm" variant="ghost" icon={ExternalLink} onPress={() => openOutside(p.url)}>
          {W.neverContactList.openFacebook}
        </Button>
      </View>
    </Card>
  );
}
