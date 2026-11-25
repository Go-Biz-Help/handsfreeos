import { POSTING_NETWORKS, type PostingNetwork } from '@hfos/core/addons/socialcontent/calendar';
import {
  DEFAULT_LINK_PLACES,
  LINK,
  LINK_PLACES,
  type LinkPlace,
} from '@hfos/core/addons/socialcontent/links';
import { networkName } from '@hfos/core/addons/socialcontent/networks';
import { SOCIALCONTENT_WORDS as W } from '@hfos/core/addons/socialcontent/words';
import * as React from 'react';
import { View } from 'react-native';

import { change } from '@/changes';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { FilterChip } from '@/components/ui/filter-chip';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Text } from '@/components/ui/text';

import { Note, useAct } from './kit';

/**
 * Your link at the top of the Playbook on the phone, as on the web (docs/socialcontent.md, "Your link"; the owner,
 * 24 Nov 2026): the link the business's posts send people to, and where it goes on each network. Owners and admins
 * change it, with signal; everyone else sees it.
 */
export function LinkCard({
  workspaceId,
  link,
  places,
  mayManage,
  online,
  onSaved,
}: {
  workspaceId: string;
  link: string | null;
  places: Readonly<Record<PostingNetwork, LinkPlace>> | undefined;
  mayManage: boolean;
  online: boolean;
  onSaved: () => void;
}) {
  const [typed, setTyped] = React.useState(link ?? '');
  React.useEffect(() => setTyped(link ?? ''), [link]);
  const { busy, act } = useAct(onSaved);
  const shown = places ?? DEFAULT_LINK_PLACES;
  const off = !mayManage || !online || busy !== null;
  const save = (
    key: string,
    body: { link?: string | null; places?: Partial<Record<PostingNetwork, LinkPlace>> },
  ) =>
    void act(
      key,
      async () => (await change('socialcontent.link.save', { workspaceId, ...body })).output,
      (out) =>
        body.link === null
          ? W.link.removed
          : out.carried
            ? `${W.link.saved} ${W.link.carried(out.carried)}`
            : W.link.saved,
    );
  return (
    <Card className="gap-3 p-4" testID="socialcontent-link">
      <Text className="text-[15px] font-semibold">{W.link.title}</Text>
      <Note>{W.link.intro}</Note>
      <Input
        value={typed}
        onChangeText={setTyped}
        placeholder={W.link.placeholder}
        accessibilityLabel={W.link.label}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        maxLength={LINK.most}
        editable={mayManage}
        testID="socialcontent-link-input"
      />
      <View className="flex-row flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          loading={busy === 'link'}
          disabled={off || !typed.trim() || typed.trim() === (link ?? '')}
          onPress={() => save('link', { link: typed.trim() })}
          testID="socialcontent-link-save"
        >
          {busy === 'link' ? W.link.saving : W.link.save}
        </Button>
        {link ? (
          <Button
            size="sm"
            variant="ghost"
            loading={busy === 'remove'}
            disabled={off}
            onPress={() => {
              setTyped('');
              save('remove', { link: null });
            }}
            testID="socialcontent-link-remove"
          >
            {W.link.remove}
          </Button>
        ) : null}
      </View>
      {!link ? <Note>{W.link.none}</Note> : null}
      <Text className="text-[13.5px] font-medium">{W.link.where}</Text>
      {POSTING_NETWORKS.map((n) => (
        <View key={n} className="gap-1.5" testID={`socialcontent-link-${n}`}>
          <Text className="text-[13.5px]">{networkName(n)}</Text>
          <Segmented
            value={shown[n]}
            onChange={(place) => save(`place:${n}`, { places: { [n]: place } })}
            label={`${W.link.where}: ${networkName(n)}`}
            options={LINK_PLACES.map((p) => ({
              value: p,
              label: W.link.places[p],
              disabled: off,
              testID: `socialcontent-link-${n}-${p}`,
            }))}
          />
          <Text className="text-[12.5px] leading-[17px] text-text-3">
            {W.link.hint(n, shown[n])}
          </Text>
        </View>
      ))}
      {!mayManage ? <Note>{W.link.onlyManagers}</Note> : null}
    </Card>
  );
}

/**
 * Where a post's link goes, on its own screen (docs/socialcontent.md, "Your link"): no link, in the post, link in bio,
 * or the first comment. The link itself is the business's, from the Playbook; without one, it says so.
 */
export function PostLinkChoice({
  network,
  place,
  link,
  disabled,
  onChange,
}: {
  network: PostingNetwork;
  place: LinkPlace | null;
  link: string | null;
  disabled: boolean;
  onChange: (place: LinkPlace | null) => void;
}) {
  return (
    <View className="gap-1.5" testID="socialcontent-post-link">
      <Text className="text-[13px] font-medium">{W.link.post}</Text>
      <View className="flex-row flex-wrap gap-2">
        <FilterChip
          label={W.link.postNone}
          on={place === null}
          disabled={disabled}
          onPress={() => onChange(null)}
          testID="socialcontent-post-link-none"
        />
        {LINK_PLACES.map((p) => (
          <FilterChip
            key={p}
            label={W.link.places[p]}
            on={place === p}
            disabled={disabled}
            onPress={() => onChange(p)}
            testID={`socialcontent-post-link-${p}`}
          />
        ))}
      </View>
      {place && !link ? (
        <Text className="text-[12.5px] text-warning-text">{W.link.noLinkYet}</Text>
      ) : place ? (
        <Text className="text-[12.5px] leading-[17px] text-text-3">
          {link} · {W.link.hint(network, place)}
        </Text>
      ) : null}
    </View>
  );
}
