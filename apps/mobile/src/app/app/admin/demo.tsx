import { router, type Href } from 'expo-router';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { useDesk } from '@/components/admin/staff-context';
import { Building, Check, Play } from '@/components/icons';
import { businessHref } from '@/components/shell/business-context';
import { List, ListLabel, ListRow } from '@/components/shell/list';
import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { clearDemoPushes } from '@/demo/push';
import { PHONE_DEMO_SCENES } from '@/demo/scenes';
import { keepDemo } from '@/demo/state';
import { firstNameOf } from '@/demo/world';
import { PHONE_DEMO_WORDS as W } from '@/demo/words';
import { lastOpenedBusiness, rememberOpened, useMe } from '@/lib/businesses';

/** The web's demo business, which the founder plays the web's scenes in (apps/web/src/lib/demo/scenes). */
const DEMO_BUSINESS = 'Bright Path Home Services';

/**
 * Admin → Demo player on the phone: the scenes that play on a phone (src/demo), for videos and live shows. Each plays in
 * one of the person's own businesses, on its real screens, with made-up customers and messages that are never saved or
 * sent; the player sits over the screens until Exit. Each scene's voiceover is here, to read before recording.
 */
export default function DeskDemoPlayer() {
  const { userId } = useDesk();
  const { me } = useMe(userId);
  const businesses = React.useMemo(() => me?.businesses ?? [], [me]);
  const [picked, setPicked] = React.useState<string | null>(null);
  const [open, setOpen] = React.useState<string | null>(null);
  const chosen =
    businesses.find((b) => b.id === picked) ??
    businesses.find((b) => b.name === DEMO_BUSINESS) ??
    businesses.find((b) => b.id === lastOpenedBusiness(userId)) ??
    businesses[0] ??
    null;

  function play(sceneId: string) {
    if (!me || !chosen) return;
    void clearDemoPushes().catch(() => undefined);
    keepDemo({
      viewerId: userId,
      workspaceId: chosen.id,
      scene: sceneId,
      steps: [],
      startedAt: Date.now(),
      business: chosen.name,
      // The business's own teammate's name replaces it once its screens open (the player looks it up there).
      teammate: 'Ava',
      me: firstNameOf(me.user.fullName),
      myName: me.user.fullName || me.user.email,
      timeZone: chosen.timezone,
      read: [],
      typed: [],
    });
    rememberOpened(userId, chosen.id);
    router.replace(businessHref(chosen.id) as Href);
  }

  return (
    <Screen title={W.title} leading="back" back="/app/admin" testID="desk-demo">
      <Text className="px-1 text-[13.5px] text-text-2">{W.intro}</Text>
      {businesses.length === 0 ? (
        <Card className="p-3.5">
          <Text className="text-[14px]">{W.noBusiness}</Text>
        </Card>
      ) : (
        <>
          <ListLabel>{W.playsIn}</ListLabel>
          <List testID="demo-businesses">
            {businesses.map((b) => (
              <ListRow
                key={b.id}
                icon={Building}
                label={b.name}
                end={
                  b.id === chosen?.id ? (
                    <Icon as={Check} className="size-[18px] text-accent-text" />
                  ) : undefined
                }
                endWords={b.id === chosen?.id ? 'Chosen' : undefined}
                chevron={false}
                onPress={() => setPicked(b.id)}
                testID={`demo-business-${b.id}`}
              />
            ))}
          </List>
        </>
      )}
      {PHONE_DEMO_SCENES.map((scene) => (
        <Card key={scene.id} className="gap-2 p-3.5" testID={`demo-scene-${scene.id}`}>
          <Text className="text-[12.5px] font-semibold text-text-3">
            {`Scene ${scene.number} · ${W.steps(scene.steps.length)}`}
          </Text>
          <Text className="text-base font-semibold">{scene.title}</Text>
          <Text className="text-[13.5px] text-text-2">{scene.summary}</Text>
          {open === scene.id ? (
            <View className="gap-2 pt-1" testID={`demo-script-${scene.id}`}>
              {scene.steps.map((step, i) => (
                <View key={step.label} className="gap-0.5">
                  <Text className="text-[13.5px] font-semibold">{`${i + 1}. ${step.label}`}</Text>
                  <Text className="text-[13px] text-text-2">{step.voiceover}</Text>
                </View>
              ))}
            </View>
          ) : null}
          <View className="flex-row items-center gap-2 pt-1">
            <Button
              size="sm"
              icon={Play}
              onPress={() => play(scene.id)}
              disabled={!chosen}
              testID={`demo-play-${scene.id}`}
            >
              {W.play}
            </Button>
            <Pressable
              role="button"
              onPress={() => setOpen(open === scene.id ? null : scene.id)}
              className="min-h-9 justify-center px-2"
              testID={`demo-script-toggle-${scene.id}`}
            >
              <Text className="text-[13.5px] font-medium text-accent-text">
                {open === scene.id ? W.hideScript : W.showScript}
              </Text>
            </Pressable>
          </View>
        </Card>
      ))}
    </Screen>
  );
}
