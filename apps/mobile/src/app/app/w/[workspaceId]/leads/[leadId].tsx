import {
  formatDate,
  formatDateOnly,
  inStageSince,
  lastContactWords,
  money,
  moveToast,
  PIPELINE_WORDS,
  RECORD_WORDS,
  type StageRef,
} from '@hfos/core';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { moveLead, setNextAction } from '@/pipeline/actions';
import { useLead } from '@/pipeline/use-pipeline';
import { DetailRow, ChangeMark } from '@/components/customers/bits';
import { TimelineEmpty, TimelineRow } from '@/components/customers/timeline';
import { LostSheet, MoveSheet, NextActionBox, StageBadge } from '@/components/pipeline/bits';
import { businessHref, useBusiness } from '@/components/shell/business-context';
import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { useMembers } from '@/customers/names';
import { startCall } from '@/inbox/calls';

/**
 * A lead's own page, as `design/m10/Pipeline.dc.html` draws it: **Move to…** is the main button, Call and Text go
 * straight to the customer, and the next action and what came in last sit underneath. Everything reads from the
 * phone's copy, and a move works with no signal.
 */
export default function LeadScreen() {
  const { leadId } = useLocalSearchParams<{ leadId: string }>();
  const { business, me } = useBusiness();
  const data = useLead(leadId);
  const members = useMembers();
  const lead = data.lead;
  const [moving, setMoving] = React.useState(false);
  const [lost, setLost] = React.useState<StageRef | null>(null);
  const [dismissed, setDismissed] = React.useState<string | null>(null);
  const refused =
    data.state.refused && data.state.refused.row.id !== dismissed ? data.state.refused : null;

  if (!lead)
    return (
      <Screen title="Lead" leading="back" testID="lead">
        <Text className="py-10 text-center text-[13px] text-text-3" testID="lead-missing">
          This lead isn’t on this phone.
        </Text>
      </Screen>
    );

  const who = lead.person?.fullName ?? lead.company?.name ?? '';
  const move = async (stage: StageRef, lostReason?: string) => {
    if (stage.id === lead.stageId) return;
    if (stage.kind === 'lost' && !lostReason) {
      setMoving(false);
      setLost(stage);
      return;
    }
    setMoving(false);
    setLost(null);
    await moveLead(business.id, lead, stage, lostReason);
    toast.show(moveToast(lead.title, stage));
  };

  return (
    <Screen title={lead.title} subtitle={who} leading="back" testID="lead">
      {refused ? (
        <ChangeMark waiting={0} why={refused.why} onClear={() => setDismissed(refused.row.id)} />
      ) : (
        <ChangeMark waiting={data.state.waiting} why={null} />
      )}

      <Card className="gap-3 px-3.5 py-3.5">
        <View className="flex-row items-center justify-between gap-2">
          <StageBadge name={lead.stageName} kind={lead.stageKind} />
          <Text className="text-xl font-semibold" testID="lead-value">
            {money(lead.valueCents)}
          </Text>
        </View>
        <View className="gap-0.5">
          <DetailRow label={PIPELINE_WORDS.customer} value={who || null} />
          <DetailRow
            label={PIPELINE_WORDS.assigned}
            value={lead.assignee?.fullName ?? RECORD_WORDS.unassigned}
          />
          <DetailRow label={PIPELINE_WORDS.source} value={lead.source} />
          <DetailRow
            label={PIPELINE_WORDS.inStageSince}
            value={inStageSince(lead.stageEnteredAt)}
          />
          <DetailRow
            label={PIPELINE_WORDS.lastContact}
            value={lastContactWords(lead.lastContactAt)}
          />
          <DetailRow
            label={PIPELINE_WORDS.expectedClose}
            value={lead.expectedCloseOn ? formatDateOnly(lead.expectedCloseOn) : null}
          />
        </View>
        <Button size="lg" onPress={() => setMoving(true)} className="min-h-11" testID="lead-move">
          {PIPELINE_WORDS.moveTo}
        </Button>
        {lead.person ? (
          <View className="flex-row gap-2">
            <Button
              variant="secondary"
              size="md"
              className="min-h-11 flex-1"
              onPress={() => startCall({ personId: lead.person!.id }, { workspaceId: business.id })}
              testID="lead-call"
            >
              {`Call ${lead.person.fullName.split(' ')[0] ?? ''}`.trim()}
            </Button>
            <Button
              variant="secondary"
              size="md"
              className="min-h-11 flex-1"
              onPress={() =>
                router.push(
                  businessHref(business.id, `customers/people/${lead.person!.id}`) as Href,
                )
              }
              testID="lead-open-customer"
            >
              {lead.person.fullName}
            </Button>
          </View>
        ) : null}
      </Card>

      {lead.status === 'open' ? (
        <NextActionBox
          lead={lead}
          onSet={async (text) => {
            await setNextAction(business.id, lead.id, text, null);
            toast.show(PIPELINE_WORDS.nextActionSet);
          }}
        />
      ) : null}

      {lead.status === 'lost' && lead.lostReason ? (
        <View className="rounded-menu bg-danger-soft px-3.5 py-3" testID="lead-lost-reason">
          <Text className="text-[13.5px] text-danger-text">
            <Text className="font-semibold text-danger-text">{PIPELINE_WORDS.lostPrefix}</Text>{' '}
            {lead.lostReason}
            {lead.lostAt ? ` · ${formatDate(lead.lostAt)}` : ''}
          </Text>
        </View>
      ) : null}
      {lead.status === 'won' ? (
        <View className="rounded-menu bg-success-soft px-3.5 py-3" testID="lead-won">
          <Text className="text-[13.5px] text-success-text">
            <Text className="font-semibold text-success-text">{PIPELINE_WORDS.won}</Text>
            {lead.wonAt ? ` · ${formatDate(lead.wonAt)}` : ''}. {PIPELINE_WORDS.wonNote}
          </Text>
        </View>
      ) : null}

      <Card className="gap-2 px-3.5 py-3.5" testID="lead-latest">
        <Text className="text-[15px] font-semibold">{PIPELINE_WORDS.latest}</Text>
        {data.timeline.length === 0 ? (
          <TimelineEmpty />
        ) : (
          data.timeline
            .slice(0, 12)
            .map((entry) => (
              <TimelineRow
                key={entry.id}
                entry={entry}
                recordType="lead"
                viewerId={me.user.id}
                timeZone={data.timeZone}
                subjectName={lead.person?.fullName}
                members={members}
              />
            ))
        )}
      </Card>

      {lead.tags.length > 0 ? (
        <View className="flex-row flex-wrap gap-1.5 px-1" testID="lead-tags">
          {lead.tags.map((t) => (
            <View
              key={t.id}
              className="h-[26px] flex-row items-center gap-1.5 rounded-full bg-card-2 px-2.5"
            >
              <View className="size-[7px] rounded-full" style={{ backgroundColor: t.color }} />
              <Text className="text-xs font-medium text-text-2">{t.name}</Text>
            </View>
          ))}
        </View>
      ) : null}

      <Pressable
        role="link"
        onPress={() => router.push(businessHref(business.id, 'pipeline') as Href)}
        className="min-h-11 justify-center px-1"
        testID="lead-back-to-pipeline"
      >
        <Text className="text-[13px] text-accent-text">Back to the pipeline</Text>
      </Pressable>

      <MoveSheet
        open={moving}
        lead={lead}
        stages={data.stages}
        pipelineName={data.pipelineName}
        onClose={() => setMoving(false)}
        onMove={(stage) => void move(stage)}
      />
      <LostSheet
        open={lost !== null}
        leadTitle={lead.title}
        onClose={() => setLost(null)}
        onConfirm={(reason) => lost && void move(lost, reason)}
      />
    </Screen>
  );
}
