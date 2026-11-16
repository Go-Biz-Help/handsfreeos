import { REFER_WORDS as RW, type Referral } from '@hfos/core/addons/outreach/referrals';
import * as React from 'react';
import { View } from 'react-native';

import { Check, ExternalLink, X } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';

import { Note, openOutside, Part } from './kit';
import { PostQuote } from './post-quote';

/**
 * Refer someone you've talked with on the phone (docs/outreach.md, decision 174), as the web's Today has it
 * (apps/web's referral-card.tsx): the post asking for a recommendation, who and why, the comment naming them and the
 * heads-up to them, each held to copy, with **Open the post** and **Open their chat**; then **I did both** or **Not
 * this one**. Both wait for the person (the owner's 9a). It needs signal. The words are core's (`REFER_WORDS`).
 */

/** What the person does with a referral. */
export interface ReferralActions {
  done: (referralId: string, name: string) => void;
  skip: (referralId: string) => void;
}

export function ReferralsPart({
  referrals,
  on,
}: {
  referrals: readonly Referral[];
  on: ReferralActions;
}) {
  if (!referrals.length) return null;
  return (
    <Part
      title={`${RW.title} · ${referrals.length.toLocaleString('en-US')}`}
      about={RW.blurb}
      testID="today-refer"
    >
      {referrals.map((r) => (
        <Card
          key={r.referralId}
          className="gap-2.5 px-4 py-3.5"
          testID={`today-refer-${r.referralId}`}
        >
          <Text className="text-[15px] font-semibold">{RW.refer(r.name)}</Text>
          {r.why ? <Note>{r.why}</Note> : null}
          <View className="gap-1 rounded-control bg-card-2 px-3 py-2">
            <Text className="text-[13px] font-medium">
              {r.asks ? `${r.writer} · ${RW.asks(r.asks)}` : r.writer}
            </Text>
            <PostQuote
              post={r.post}
              whole={r.postWhole}
              className="text-[14px] leading-[20px] text-text-2"
              testID="today-refer-post"
            />
          </View>
          <Text className="text-[13px] font-semibold text-text-2">{RW.comment}</Text>
          <Text
            selectable
            className="rounded-control bg-card-2 px-3 py-2 text-[14.5px] leading-[21px]"
            testID="today-refer-comment"
          >
            {r.comment}
          </Text>
          <Note>{`${RW.tag} ${RW.hold}`}</Note>
          <Button
            size="md"
            variant="secondary"
            icon={ExternalLink}
            className="self-start"
            onPress={() => openOutside(r.postUrl)}
            testID="today-refer-open-post"
          >
            {RW.openPost}
          </Button>
          <Text className="text-[13px] font-semibold text-text-2">{RW.note(r.name)}</Text>
          <Text
            selectable
            className="rounded-control bg-card-2 px-3 py-2 text-[14.5px] leading-[21px]"
            testID="today-refer-note"
          >
            {r.note}
          </Text>
          <Button
            size="md"
            variant="secondary"
            icon={ExternalLink}
            className="self-start"
            onPress={() => openOutside(r.profileUrl)}
            testID="today-refer-open-chat"
          >
            {RW.openChat}
          </Button>
          <View className="flex-row flex-wrap gap-2 pt-1">
            <Button
              size="md"
              icon={Check}
              onPress={() => on.done(r.referralId, r.name)}
              testID="today-refer-done"
            >
              {RW.done}
            </Button>
            <Button
              size="md"
              variant="ghost"
              icon={X}
              onPress={() => on.skip(r.referralId)}
              testID="today-refer-skip"
            >
              {RW.skip}
            </Button>
          </View>
        </Card>
      ))}
    </Part>
  );
}
