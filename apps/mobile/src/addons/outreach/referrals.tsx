import {
  REFER_WORDS as RW,
  type ReferAsk,
  type Referral,
} from '@hfos/core/addons/outreach/referrals';
import * as React from 'react';
import { View } from 'react-native';

import { Bot, Check, ExternalLink, X } from '@/components/icons';
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
 *
 * Done for the person (decision 185): on Facebook **Do it for me** has their computer post it and send the heads-up;
 * one it does soon under Autopilot says so, with nothing to do; one it couldn't finish says why. Within a week of their
 * last heads-up it's the comment alone. Below, the ask after two, the same way.
 */

/** What the person does with a referral, and with an ask after two. */
export interface ReferralActions {
  done: (referralId: string, name: string) => void;
  skip: (referralId: string) => void;
  forMe: (referralId: string, name: string, note: boolean) => void;
  ask: (askId: string, name: string, answer: 'approve' | 'done' | 'skip') => void;
}

export function ReferralsPart({
  referrals,
  asks = [],
  on,
}: {
  referrals: readonly Referral[];
  asks?: readonly ReferAsk[];
  on: ReferralActions;
}) {
  if (!referrals.length && !asks.length) return null;
  return (
    <>
      {referrals.length ? (
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
              {r.note !== null ? (
                <>
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
                </>
              ) : (
                <Note>{RW.noNote(r.name)}</Note>
              )}
              {r.state === 'approved' ? (
                <Note testID="today-refer-approved">{RW.approved(r.name, r.note !== null)}</Note>
              ) : r.needs ? (
                <Note testID="today-refer-needs">
                  {r.posted ? RW.posted(r.name, r.needs) : RW.needs(r.needs)}
                </Note>
              ) : null}
              <View className="flex-row flex-wrap gap-2 pt-1">
                {r.forYou && r.state === 'waiting' ? (
                  <Button
                    size="md"
                    icon={Bot}
                    onPress={() => on.forMe(r.referralId, r.name, r.note !== null)}
                    testID="today-refer-for-me"
                  >
                    {RW.forYou}
                  </Button>
                ) : null}
                <Button
                  size="md"
                  variant={r.forYou && r.state === 'waiting' ? 'secondary' : 'primary'}
                  icon={Check}
                  onPress={() => on.done(r.referralId, r.name)}
                  testID="today-refer-done"
                >
                  {r.note !== null ? RW.done : RW.doneComment}
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
      ) : null}
      {asks.length ? (
        <Part
          title={`${RW.askTitle} · ${asks.length.toLocaleString('en-US')}`}
          testID="today-refer-asks"
        >
          {asks.map((a) => (
            <Card
              key={a.askId}
              className="gap-2.5 px-4 py-3.5"
              testID={`today-refer-ask-${a.askId}`}
            >
              <Text className="text-[15px] font-semibold">{a.name}</Text>
              <Note>{RW.askBlurb(a.name, a.referred)}</Note>
              <Text className="text-[13px] font-semibold text-text-2">{RW.askText(a.name)}</Text>
              <Text
                selectable
                className="rounded-control bg-card-2 px-3 py-2 text-[14.5px] leading-[21px]"
                testID="today-refer-ask-text"
              >
                {a.text}
              </Text>
              <Note>{RW.hold}</Note>
              <Button
                size="md"
                variant="secondary"
                icon={ExternalLink}
                className="self-start"
                onPress={() => openOutside(a.profileUrl)}
                testID="today-refer-ask-open-chat"
              >
                {RW.openChat}
              </Button>
              {a.state === 'approved' ? (
                <Note testID="today-refer-ask-approved">{RW.askApproved(a.name)}</Note>
              ) : a.needs ? (
                <Note>{RW.askNeeds(a.needs)}</Note>
              ) : null}
              <View className="flex-row flex-wrap gap-2 pt-1">
                {a.forYou && a.state === 'waiting' ? (
                  <Button
                    size="md"
                    icon={Bot}
                    onPress={() => on.ask(a.askId, a.name, 'approve')}
                    testID="today-refer-ask-for-me"
                  >
                    {RW.forYou}
                  </Button>
                ) : null}
                <Button
                  size="md"
                  variant={a.forYou && a.state === 'waiting' ? 'secondary' : 'primary'}
                  icon={Check}
                  onPress={() => on.ask(a.askId, a.name, 'done')}
                  testID="today-refer-ask-done"
                >
                  {RW.askDone}
                </Button>
                <Button
                  size="md"
                  variant="ghost"
                  icon={X}
                  onPress={() => on.ask(a.askId, a.name, 'skip')}
                  testID="today-refer-ask-skip"
                >
                  {RW.askSkip}
                </Button>
              </View>
            </Card>
          ))}
        </Part>
      ) : null}
    </>
  );
}
