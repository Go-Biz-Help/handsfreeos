import { GET_HELP_WORDS } from '@hfos/core';
import { router } from 'expo-router';
import * as React from 'react';
import { Platform, TextInput, View } from 'react-native';

import { businessHref, useBusiness } from '@/components/shell/business-context';
import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { api, errorMessage, unwrap } from '@/lib/api';
import { appVersion } from '@/lib/app-version';
import { useNetwork } from '@/lib/network';

/**
 * Asking HandsFreeOS for help from the phone (M13).
 *
 * It goes straight out rather than into the queue of changes: a person writing this is asking us to look at
 * something now, and a message that sat on the phone until it found a signal would be worse than being told
 * plainly that it needs one.
 */
export default function GetHelp() {
  const { business } = useBusiness();
  const { online } = useNetwork();
  const [subject, setSubject] = React.useState('');
  const [body, setBody] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const send = async () => {
    if (!body.trim()) return toast.error(GET_HELP_WORDS.needsBody);
    if (!online) return toast.error(GET_HELP_WORDS.offline);
    setBusy(true);
    try {
      const out = unwrap(
        await api.POST('/v1/commands/support.request.create', {
          body: {
            workspaceId: business.id,
            subject: subject.trim(),
            body: body.trim(),
            context: {
              appVersion: appVersion(),
              platform: Platform.OS === 'ios' ? 'ios' : 'android',
            },
          },
        }),
      );
      toast.show(GET_HELP_WORDS.sent(out.number));
      router.replace(businessHref(business.id, 'more'));
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <Screen
      title={GET_HELP_WORDS.title}
      leading="back"
      back={businessHref(business.id, 'more')}
      testID="get-help"
    >
      <Card className="gap-4 px-3.5 py-4">
        <Text className="text-[13px] leading-5 text-text-2">{GET_HELP_WORDS.intro}</Text>
        <View className="gap-1.5">
          <Label>{GET_HELP_WORDS.subject}</Label>
          <Input
            value={subject}
            onChangeText={setSubject}
            placeholder={GET_HELP_WORDS.subjectPlaceholder}
            testID="get-help-subject"
          />
        </View>
        <View className="gap-1.5">
          <Label>{GET_HELP_WORDS.body}</Label>
          <TextInput
            value={body}
            onChangeText={setBody}
            multiline
            numberOfLines={7}
            textAlignVertical="top"
            className="min-h-[140px] rounded-menu border border-border-strong bg-card p-3 font-sans text-base text-text"
            testID="get-help-body"
          />
          <Text className="text-[12.5px] text-text-3">{GET_HELP_WORDS.bodyHint}</Text>
        </View>
        <Button onPress={send} disabled={busy} testID="get-help-send">
          {busy ? GET_HELP_WORDS.sending : GET_HELP_WORDS.send}
        </Button>
      </Card>
    </Screen>
  );
}
