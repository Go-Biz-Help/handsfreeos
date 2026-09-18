import * as React from 'react';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import { toast } from '@/components/ui/toast';

/** Text, email, or both — the two the web's Send dialog offers, with what is on file beside each. */
export function SendSheet({
  open,
  onClose,
  who,
  email,
  phone,
  onSend,
}: {
  open: boolean;
  onClose: () => void;
  who: string;
  email: string | null;
  phone: string | null;
  onSend: (channels: readonly ('sms' | 'email')[]) => Promise<void>;
}) {
  const [busy, setBusy] = React.useState(false);
  const send = (channels: readonly ('sms' | 'email')[]) => {
    setBusy(true);
    void onSend(channels)
      .catch((error: unknown) =>
        toast.error(error instanceof Error ? error.message : 'That didn’t work.'),
      )
      .finally(() => setBusy(false));
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={`Send it to ${who}`}
      description="They get a link to their own page. The number is taken the moment you send, so numbers stay in order."
      testID="send-document"
    >
      <View className="gap-2">
        <Button
          loading={busy}
          disabled={!email}
          onPress={() => send(['email'])}
          testID="send-by-email"
        >
          {email ? `Email · ${email}` : 'Email · no address on file'}
        </Button>
        <Button
          variant="secondary"
          loading={busy}
          disabled={!phone}
          onPress={() => send(['sms'])}
          testID="send-by-text"
        >
          {phone ? `Text · ${phone}` : 'Text · no mobile on file'}
        </Button>
        <Button variant="ghost" onPress={onClose}>
          Not yet
        </Button>
      </View>
    </Sheet>
  );
}
