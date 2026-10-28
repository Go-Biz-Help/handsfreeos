import { relativeTimeAgo } from '@hfos/core';
import { journeyStepWords, type Journey } from '@hfos/core/addons/outreach/journey';
import {
  DEMO_LOST_WHY_MOST,
  DEMO_OUTCOME_WORDS as D,
  type DemoOutcome,
  leadWords,
} from '@hfos/core/addons/outreach/leads';
import { PLATFORMS, type Platform } from '@hfos/core/addons/outreach/networks';
import { STAGES } from '@hfos/core/addons/outreach/stages';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import { router, type Href } from 'expo-router';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { change, ChangeError } from '@/changes';
import { businessHref } from '@/components/shell/business-context';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { api, errorMessage, unwrap } from '@/lib/api';
import { useNetwork } from '@/lib/network';

import { Note, openOutreach, openOutside } from './kit';

/**
 * Social Outreach's card on a customer's page (decision 103), the web's Social panel: each profile the extension saved
 * for them, with where they stand and why, the AI's next step, the groups they were found in (each opens its page),
 * the chat's summary and every step either way, the latest first. None of it is in the phone's copy, so it's asked
 * for while there's signal and stays out of the way without; a customer nobody saved from a network shows nothing.
 * Once their demo is done, their lead waits for the person's won or lost here (decision 106).
 */

/** A profile shows this many of its latest steps until it's opened up. */
const LATEST_STEPS = 5;

interface SocialProfile {
  readonly id: string;
  readonly platform: Platform;
  readonly url: string;
  readonly name: string;
  readonly journey: Journey;
}

export function OutreachSocialCard({
  workspaceId,
  personId,
}: {
  workspaceId: string;
  personId: string;
}) {
  const { online } = useNetwork();
  const [profiles, setProfiles] = React.useState<readonly SocialProfile[] | null>(null);
  const [version, setVersion] = React.useState(0);
  const reload = React.useCallback(() => setVersion((v) => v + 1), []);
  React.useEffect(() => {
    if (!online) return;
    let cancelled = false;
    api
      .POST('/v1/queries/outreach.person', { body: { workspaceId, personId } })
      .then(unwrap)
      .then((got) => {
        if (!cancelled) setProfiles(got.profiles);
      })
      .catch(() => {
        // A side card: what can't load stays out of the way.
      });
    return () => {
      cancelled = true;
    };
  }, [online, workspaceId, personId, version]);
  return <OutreachSocialBody workspaceId={workspaceId} profiles={profiles} onChange={reload} />;
}

export function OutreachSocialBody({
  workspaceId,
  profiles,
  onChange = () => {},
}: {
  workspaceId: string;
  profiles: readonly SocialProfile[] | null;
  /** A lead marked won or lost: the card is asked for again. */
  onChange?: () => void;
}) {
  if (!profiles?.length) return null;
  return (
    <Card className="gap-3 px-4 py-3.5" testID="outreach-social">
      <Text className="text-[15px] font-semibold">Social</Text>
      {profiles.map((p) => (
        <SocialProfileRow key={p.id} workspaceId={workspaceId} profile={p} onChange={onChange} />
      ))}
    </Card>
  );
}

function SocialProfileRow({
  workspaceId,
  profile: p,
  onChange,
}: {
  workspaceId: string;
  profile: SocialProfile;
  onChange: () => void;
}) {
  const [all, setAll] = React.useState(false);
  const j = p.journey;
  const steps = all ? j.steps : j.steps.slice(0, LATEST_STEPS);
  return (
    <View className="gap-1" testID="outreach-social-profile">
      <View className="flex-row flex-wrap items-center gap-2">
        <Pressable
          role="link"
          accessibilityLabel={`${p.name} on ${PLATFORMS[p.platform]}`}
          onPress={() => openOutside(p.url)}
        >
          <Text className="text-[14.5px] font-semibold text-accent-text">
            {`${p.name} on ${PLATFORMS[p.platform]}`}
          </Text>
        </Pressable>
        {j.stage ? (
          <Badge
            variant={j.stage === 'client' ? 'ok' : j.stage === 'lost' ? 'gray' : 'accent'}
            testID="outreach-social-stage"
          >
            <Text>{STAGES[j.stage]}</Text>
          </Badge>
        ) : null}
      </View>
      {j.why.length ? <Note testID="outreach-social-why">{j.why.join(' · ')}</Note> : null}
      {j.nextStep ? <Note>{`${W.nextStepLabel}: ${j.nextStep}`}</Note> : null}
      {j.lead ? (
        <Pressable
          role="link"
          accessibilityLabel={leadWords(j.lead)}
          onPress={() => router.push(businessHref(workspaceId, `leads/${j.lead!.leadId}`) as Href)}
          testID="outreach-social-lead"
        >
          <Text className="text-[13px] leading-[18px] text-accent-text">{leadWords(j.lead)}</Text>
        </Pressable>
      ) : null}
      {j.lead?.afterDemo ? (
        <AfterDemo workspaceId={workspaceId} profileId={p.id} name={p.name} onChange={onChange} />
      ) : null}
      {j.groups.length ? (
        <View className="flex-row flex-wrap items-center gap-x-1" testID="outreach-social-groups">
          <Note>Found in</Note>
          {j.groups.map((g, i) => (
            <Pressable
              key={g.groupId}
              role="link"
              accessibilityLabel={g.name ?? 'A group'}
              onPress={() => openOutreach(workspaceId, 'groups', `group=${g.groupId}`)}
            >
              <Text className="text-[13px] leading-[18px] text-accent-text">
                {`${g.name ?? 'a group'}${i < j.groups.length - 1 ? ',' : ''}`}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {j.chat?.summary ? (
        <Note testID="outreach-social-chat">
          {`Your chat: ${j.chat.summary} ${j.chat.lastFromMe ? 'You wrote last' : 'They wrote last'}, ${relativeTimeAgo(j.chat.lastAt)}.`}
        </Note>
      ) : null}
      {steps.length ? (
        <View className="gap-0.5 border-l border-border pl-3" testID="outreach-social-steps">
          {steps.map((s, i) => (
            <Text key={`${s.at}-${i}`} className="text-[13px] leading-[18px] text-text">
              {journeyStepWords(s, p.platform)}
              <Text className="text-[13px] text-text-3">
                {`${s.group ? ` · from ${s.group.name ?? 'a group'}` : ''} · ${relativeTimeAgo(s.at)}`}
              </Text>
            </Text>
          ))}
        </View>
      ) : null}
      {j.steps.length > LATEST_STEPS ? (
        <Button size="sm" variant="ghost" className="self-start" onPress={() => setAll(!all)}>
          {all ? 'Show the latest only' : `Show all ${j.steps.length} steps`}
        </Button>
      ) : null}
      {all && j.moreSteps ? (
        <Note>{`And ${j.moreSteps.toLocaleString()} older ${j.moreSteps === 1 ? 'step' : 'steps'}.`}</Note>
      ) : null}
    </View>
  );
}

/** Won or lost after their demo (`outreach.demo.outcome`), as the web's panel has it; lost asks why, or not. */
function AfterDemo({
  workspaceId,
  profileId,
  name,
  onChange,
}: {
  workspaceId: string;
  profileId: string;
  name: string;
  onChange: () => void;
}) {
  const [busy, setBusy] = React.useState<DemoOutcome | null>(null);
  const [losing, setLosing] = React.useState(false);
  const [why, setWhy] = React.useState('');
  const decide = async (outcome: DemoOutcome) => {
    setBusy(outcome);
    try {
      await change('outreach.demo.outcome', {
        workspaceId,
        profileId,
        outcome,
        why: outcome === 'lost' && why.trim() ? why.trim() : null,
      });
      toast.show(D.done(name, outcome));
      onChange();
    } catch (e) {
      toast.error(e instanceof ChangeError ? e.message : errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <View className="gap-1.5 rounded-card bg-card-2 p-2.5" testID="outreach-social-after-demo">
      <Note>{D.ask}</Note>
      {losing ? (
        <View className="gap-1.5">
          <Input
            value={why}
            onChangeText={setWhy}
            maxLength={DEMO_LOST_WHY_MOST}
            placeholder={D.why}
            accessibilityLabel={D.why}
            testID="outreach-social-lost-why"
          />
          <View className="flex-row gap-2">
            <Button
              size="sm"
              variant="danger"
              disabled={busy !== null}
              loading={busy === 'lost'}
              onPress={() => void decide('lost')}
              testID="outreach-social-mark-lost"
            >
              {D.markLost}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy !== null}
              onPress={() => setLosing(false)}
            >
              {D.cancel}
            </Button>
          </View>
        </View>
      ) : (
        <View className="flex-row gap-2">
          <Button
            size="sm"
            disabled={busy !== null}
            loading={busy === 'won'}
            onPress={() => void decide('won')}
            testID="outreach-social-won"
          >
            {D.won}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy !== null}
            onPress={() => setLosing(true)}
            testID="outreach-social-lost"
          >
            {D.lost}
          </Button>
        </View>
      )}
    </View>
  );
}
