'use client';
import { hourWords, MORNING_PUSH_HOURS } from '@hfos/core/addons/outreach/alerts';
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

/** The weeks a sent friend request can wait before it's suggested for cancelling. */
const WEEKS = Array.from({ length: 12 }, (_, i) => i + 1);

/**
 * On the Add-ons page: who from the chats brought in from Facebook goes in Contacts once the AI has read them
 * (docs/outreach.md, decision 3), and how long a sent friend request waits before it's suggested for cancelling
 * (decision 12), and the hour of the morning push to each person's phone, in the business's time zone (decision 22).
 * Anyone already in Contacts gets the tags whatever it says.
 */
export default function OutreachSettings({ settings, saveSettings }: AddonSettingsProps) {
  const now = outreachSettings(settings);
  const saved = now.contactsFromChats;
  const [pick, setPick] = useState<ContactsFromChats>(saved);
  const [weeks, setWeeks] = useState(now.cancelRequestsAfterWeeks);
  const [hour, setHour] = useState(now.morningPushHour);
  const { busy, act } = useAct();
  if (settings === null)
    return (
      <p className="text-[13px] text-text-2">
        Who from your Facebook chats goes in Contacts: {CONTACTS_FROM_CHATS_WORDS[saved]}. Friend
        requests are suggested for cancelling after {weeksWords(now.cancelRequestsAfterWeeks)}. The
        morning push{' '}
        {now.morningPushHour === null ? 'is off' : `comes at ${hourWords(now.morningPushHour)}`}. An
        owner or admin can change these.
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
      <label className="block">
        <span className="text-[14px] font-semibold">Suggest cancelling friend requests after</span>
        <span className="block text-[13px] text-text-2">
          Requests nobody has answered by then show under Tidy up on the Friends tab, for you to
          tick.
        </span>
        <select
          className="mt-1.5 h-8 rounded-control border border-border-strong bg-card px-2 text-[13px]"
          value={weeks}
          onChange={(e) => setWeeks(Number(e.target.value))}
          data-testid="outreach-cancel-weeks"
        >
          {WEEKS.map((w) => (
            <option key={w} value={w}>
              {weeksWords(w)}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="text-[14px] font-semibold">Morning push</span>
        <span className="block text-[13px] text-text-2">
          Each person who used the extension lately hears how many are on their list for today, in
          your business’s time zone. Replies the extension spots are pushed as they come.
        </span>
        <select
          className="mt-1.5 h-8 rounded-control border border-border-strong bg-card px-2 text-[13px]"
          value={hour === null ? 'off' : String(hour)}
          onChange={(e) => setHour(e.target.value === 'off' ? null : Number(e.target.value))}
          data-testid="outreach-morning-hour"
        >
          {/* An hour set some other way still shows. */}
          {[...new Set([...MORNING_PUSH_HOURS, ...(hour === null ? [] : [hour])])]
            .sort((a, b) => a - b)
            .map((h) => (
              <option key={h} value={String(h)}>
                {hourWords(h)}
              </option>
            ))}
          <option value="off">Off</option>
        </select>
      </label>
      <Button
        size="sm"
        disabled={
          (pick === saved &&
            weeks === now.cancelRequestsAfterWeeks &&
            hour === now.morningPushHour) ||
          busy !== null
        }
        onClick={() =>
          void act(
            'save',
            () =>
              saveSettings({
                ...settings,
                contactsFromChats: pick,
                cancelRequestsAfterWeeks: weeks,
                morningPushHour: hour,
              }),
            'Saved.',
          )
        }
        data-testid="outreach-settings-save"
      >
        Save
      </Button>
    </div>
  );
}

const weeksWords = (weeks: number) => (weeks === 1 ? '1 week' : `${weeks} weeks`);
