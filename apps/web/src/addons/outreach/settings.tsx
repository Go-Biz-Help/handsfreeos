'use client';
import {
  CONTACTS_FROM_CHATS,
  CONTACTS_FROM_CHATS_WORDS,
  outreachSettings,
  type ContactsFromChats,
} from '@hfos/core/addons/outreach/chat-read';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { RadioCard } from '@/components/ui/radio-card';
import type { AddonSettingsProps } from '../registry';
import { useAct } from './use-act';

/**
 * On the Add-ons page: who from the chats brought in from Facebook goes in Contacts once the AI has read them
 * (docs/outreach.md, decision 3). Anyone already in Contacts gets the tags whatever it says.
 */
export default function OutreachSettings({ settings, saveSettings }: AddonSettingsProps) {
  const saved = outreachSettings(settings).contactsFromChats;
  const [pick, setPick] = useState<ContactsFromChats>(saved);
  const { busy, act } = useAct();
  if (settings === null)
    return (
      <p className="text-[13px] text-text-2">
        Who from your Facebook chats goes in Contacts: {CONTACTS_FROM_CHATS_WORDS[saved]}. An owner
        or admin can change it.
      </p>
    );
  return (
    <div className="space-y-3" data-testid="outreach-settings">
      <div>
        <h3 className="text-[14px] font-semibold">Who from Facebook chats goes in Contacts</h3>
        <p className="text-[13px] text-text-2">
          Each chat brought in from Facebook is read for a summary and your playbooks’ tags, and
          shows on the Chats tab. This says who also goes in Contacts.
        </p>
      </div>
      <div role="radiogroup" aria-label="Who goes in Contacts" className="flex flex-col gap-2">
        {CONTACTS_FROM_CHATS.map((k) => (
          <RadioCard
            key={k}
            selected={pick === k}
            onSelect={() => setPick(k)}
            title={CONTACTS_FROM_CHATS_WORDS[k]}
            description={k === 'tagged' ? 'The usual choice.' : undefined}
            testId={`outreach-contacts-${k}`}
          />
        ))}
      </div>
      <Button
        size="sm"
        disabled={pick === saved || busy !== null}
        onClick={() =>
          void act(
            'save',
            () => saveSettings({ ...settings, contactsFromChats: pick }),
            'Saved. Chats read from now on follow it.',
          )
        }
        data-testid="outreach-settings-save"
      >
        Save
      </Button>
    </div>
  );
}
