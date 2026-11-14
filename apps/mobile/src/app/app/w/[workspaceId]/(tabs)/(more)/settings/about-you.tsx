import { ABOUT_YOU_MOST, ABOUT_YOU_WORDS as W } from '@hfos/core';
import * as React from 'react';
import { View } from 'react-native';

import { CloudOff, Lock } from '@/components/icons';
import { businessHref, useBusiness } from '@/components/shell/business-context';
import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { api, errorMessage, unwrap } from '@/lib/api';
import { useNetwork } from '@/lib/network';

/**
 * About you (docs/outreach.md, decision 165), as on the web's Settings → Account: one box in the person's own words
 * for every AI that writes as them, with what's worth saying under it. Theirs alone, so it's never kept in the phone's
 * copy: it's read and saved with signal. Empty and saved, it's cleared.
 */
export default function AboutYou() {
  const { business } = useBusiness();
  const { online } = useNetwork();
  const [saved, setSaved] = React.useState<string | null>(null);
  const [about, setAbout] = React.useState('');
  const [failed, setFailed] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(() => {
    setFailed(false);
    api
      .POST('/v1/queries/user_about.get', { body: {} })
      .then(unwrap)
      .then((out) => {
        setSaved(out.about);
        setAbout(out.about);
      })
      .catch(() => setFailed(true));
  }, []);
  React.useEffect(load, [load]);

  const dirty = saved !== null && about.trim() !== saved;
  const save = async () => {
    setBusy(true);
    try {
      const out = unwrap(
        await api.POST('/v1/commands/user_about.set', { body: { about: about.trim() } }),
      );
      setSaved(about.trim());
      toast.show(out.filled ? W.saved : W.cleared);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen
      title={W.title}
      leading="back"
      back={businessHref(business.id, 'settings')}
      testID="about-you"
      contentClassName="gap-3"
    >
      <Text className="px-0.5 leading-[22px] text-text-2">{W.lead}</Text>

      {saved === null && (!online || failed) ? (
        <View
          className="flex-row items-start gap-2.5 rounded-menu bg-warning-soft px-3 py-[11px]"
          testID="about-you-needs-signal"
        >
          <Icon as={CloudOff} className="mt-0.5 size-[18px] text-warning-text" />
          <View className="min-w-0 flex-1 gap-2">
            <Text className="text-[13.5px] leading-5 text-warning-text">{W.needsSignal}</Text>
            {online ? (
              <Button variant="secondary" onPress={load} testID="about-you-retry">
                {W.retry}
              </Button>
            ) : null}
          </View>
        </View>
      ) : null}

      <Input
        value={about}
        onChangeText={setAbout}
        multiline
        editable={saved !== null}
        maxLength={ABOUT_YOU_MOST}
        placeholder={W.placeholder}
        accessibilityLabel={W.label}
        textAlignVertical="top"
        className="h-44 items-stretch"
        style={{ paddingTop: 11, paddingBottom: 11 }}
        testID="about-you-box"
      />
      <Text className="px-0.5 text-[12.5px] leading-[18px] text-text-3">{W.how}</Text>

      <Button
        onPress={() => void save()}
        loading={busy}
        disabled={!dirty || !online}
        testID="about-you-save"
      >
        {W.save}
      </Button>

      <View className="flex-row items-center gap-1.5 px-0.5">
        <Icon as={Lock} className="size-3.5 text-text-3" />
        <Text className="min-w-0 flex-1 text-[12.5px] leading-[18px] text-text-3">{W.private}</Text>
      </View>

      <Card className="gap-1.5 p-3.5">
        <Text className="text-[13.5px] font-medium">{W.ideasTitle}</Text>
        {W.ideas.map((idea) => (
          <Text key={idea} className="text-[13px] leading-[19px] text-text-2">
            {`•  ${idea}`}
          </Text>
        ))}
      </Card>
    </Screen>
  );
}
