import { wheelsWords, type WheelsListOutput } from '@hfos/core/addons/outreach/automation';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import {
  TODAY_KIND_KEYS,
  TODAY_KINDS,
  TODAY_LIMIT,
  type TodayItem,
  type TodayKind,
  type TodayOutput,
} from '@hfos/core/addons/outreach/today';
import { warningNote } from '@hfos/core/addons/outreach/tidy';
import { messengerChatUrl } from '@hfos/core/addons/outreach/waiting-words';
import * as React from 'react';
import { View } from 'react-native';

import { change, ChangeError } from '@/changes';
import { Check, ExternalLink, X } from '@/components/icons';
import { Screen } from '@/components/shell/screen';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { api, errorMessage, unwrap } from '@/lib/api';

import { okSend, skipPost, skipSend } from './actions';
import { NeedsSignal, Note, openOutside, Part, useOutreachAnswer, useOutreachContext } from './kit';
import { PersonMenu } from './person-menu';

/**
 * Today on the phone (decision 44): the person's list for today, kind by kind, what the extension does on its own,
 * and each message it drafted, to OK or skip; each person's menu (Add to Contacts, Demo booked, Don't pitch, as the
 * web's); for owners and admins, who is on training wheels, with End now. Drafting
 * a message, copying an opener and the AI's drafts stay on the computer, beside Facebook. It needs signal.
 */

const failed = (e: unknown) => toast.error(e instanceof ChangeError ? e.message : errorMessage(e));

export function TodayScreen() {
  const ctx = useOutreachContext();
  const ws = ctx.workspaceId;
  const today = useOutreachAnswer(
    async () => unwrap(await api.POST('/v1/queries/outreach.today', { body: { workspaceId: ws } })),
    `today:${ws}`,
    W.rows.today,
  );
  const wheels = useOutreachAnswer(
    ctx.manages
      ? async () =>
          unwrap(await api.POST('/v1/queries/outreach.wheels', { body: { workspaceId: ws } }))
      : null,
    `wheels:${ws}`,
    W.wheelsTitle,
  );
  const after = (said: string) => {
    toast.show(said);
    today.reload();
  };
  return (
    <TodayBody
      today={today.data}
      error={today.error}
      wheels={ctx.manages ? wheels.data : null}
      onRetry={today.reload}
      menu={(item) => (
        <PersonMenu workspaceId={ws} who={item} online={ctx.online} onChanged={today.reload} />
      )}
      onOk={async (sendId) => {
        try {
          await okSend(ws, sendId);
          after(ctx.online ? W.okd : W.okdQueued);
        } catch (e) {
          failed(e);
        }
      }}
      onSkip={async (sendId) => {
        try {
          await skipSend(ws, sendId);
          after(ctx.online ? W.skipped : W.skippedQueued);
        } catch (e) {
          failed(e);
        }
      }}
      onNotForMe={async (postId) => {
        try {
          await skipPost(ws, postId);
          after(ctx.online ? W.notForMeDone : W.queued);
        } catch (e) {
          failed(e);
        }
      }}
      onEndWheels={async (userId, name) => {
        try {
          await change('outreach.wheels.end', { workspaceId: ws, userId });
          toast.show(W.wheelsEnded(name));
          wheels.reload();
        } catch (e) {
          failed(e);
        }
      }}
    />
  );
}

export function TodayBody({
  today,
  error,
  wheels,
  onRetry,
  menu,
  onOk,
  onSkip,
  onNotForMe,
  onEndWheels,
}: {
  today: TodayOutput | null;
  error: string | null;
  wheels: WheelsListOutput | null;
  onRetry: () => void;
  /** Each item's person menu (./person-menu.tsx): Add to Contacts, Demo booked, Don't pitch. */
  menu?: (item: TodayItem) => React.ReactNode;
  onOk: (sendId: string) => void;
  onSkip: (sendId: string) => void;
  onNotForMe: (postId: string) => void;
  onEndWheels: (userId: string, name: string) => void;
}) {
  if (!today)
    return (
      <Screen title={W.rows.today} leading="back" testID="outreach-today">
        {error ? <NeedsSignal words={error} onRetry={onRetry} testID="today-needs-signal" /> : null}
      </Screen>
    );
  const kinds = TODAY_KIND_KEYS.filter((k) => today.items.some((i) => i.kind === k));
  return (
    <Screen title={W.rows.today} leading="back" testID="outreach-today">
      {today.warning ? (
        <Card className="border-danger px-4 py-3" testID="today-warning">
          <Text className="text-[14px] leading-[20px] text-danger">
            {warningNote(today.warning)}
          </Text>
        </Card>
      ) : null}
      {today.wheels.on ? <Note testID="today-wheels">{wheelsWords(today.wheels)}</Note> : null}
      {kinds.length ? (
        kinds.map((kind) => (
          <KindPart
            key={kind}
            kind={kind}
            today={today}
            menu={menu}
            onOk={onOk}
            onSkip={onSkip}
            onNotForMe={onNotForMe}
          />
        ))
      ) : (
        <Card className="px-5 py-6" testID="today-empty">
          <Note>{W.todayEmpty}</Note>
        </Card>
      )}
      <Note>{W.todayComputerOnly}</Note>
      {wheels ? (
        <Part title={W.wheelsTitle} testID="today-wheels-team">
          {wheels.people.length ? (
            wheels.people.map((p) => (
              <Card key={p.userId} className="gap-2 px-4 py-3.5">
                <Text className="text-[15px] font-semibold">{p.name}</Text>
                <Note>{wheelsWords(p.wheels)}</Note>
                <Button
                  size="md"
                  variant="secondary"
                  className="self-start"
                  onPress={() => onEndWheels(p.userId, p.name)}
                  testID="today-wheels-end"
                >
                  {W.endNow}
                </Button>
              </Card>
            ))
          ) : (
            <Note>{W.wheelsNone}</Note>
          )}
        </Part>
      ) : null}
    </Screen>
  );
}

function limitWords(today: TodayOutput, kind: TodayKind): string | null {
  const step = TODAY_LIMIT[kind];
  if (!step) return null;
  const { done, most } = today.limits[step];
  return W.countOf(done, most);
}

function KindPart({
  kind,
  today,
  menu,
  onOk,
  onSkip,
  onNotForMe,
}: {
  kind: TodayKind;
  today: TodayOutput;
  menu?: (item: TodayItem) => React.ReactNode;
  onOk: (sendId: string) => void;
  onSkip: (sendId: string) => void;
  onNotForMe: (postId: string) => void;
}) {
  const items = today.items.filter((i) => i.kind === kind);
  const auto = today.auto.includes(kind);
  return (
    <Part
      title={`${TODAY_KINDS[kind]} · ${items.length.toLocaleString('en-US')}`}
      about={[limitWords(today, kind), auto ? W.doneOnItsOwn : null].filter(Boolean).join(' · ')}
      testID={`today-${kind}`}
    >
      {items.map((item, i) => (
        <ItemCard
          key={`${item.profileId ?? item.postId ?? i}:${i}`}
          item={item}
          menu={menu}
          onOk={onOk}
          onSkip={onSkip}
          onNotForMe={onNotForMe}
        />
      ))}
    </Part>
  );
}

function ItemCard({
  item,
  menu,
  onOk,
  onSkip,
  onNotForMe,
}: {
  item: TodayItem;
  menu?: (item: TodayItem) => React.ReactNode;
  onOk: (sendId: string) => void;
  onSkip: (sendId: string) => void;
  onNotForMe: (postId: string) => void;
}) {
  const chat = messengerChatUrl(item.threadKey);
  const page = item.kind === 'comment' ? item.postUrl : (chat ?? item.profileUrl);
  return (
    <Card className="gap-2 px-4 py-3.5" testID="today-item">
      <View className="flex-row items-center gap-2">
        <View className="min-w-0 flex-1 flex-row flex-wrap items-center gap-2">
          <Text className="text-[15px] font-semibold">{item.name}</Text>
          {item.playbookName ? (
            <Badge variant="gray">
              <Text>{item.playbookName}</Text>
            </Badge>
          ) : null}
        </View>
        {menu?.(item)}
      </View>
      {item.why.length ? <Note>{item.why.join(' · ')}</Note> : null}
      {item.summary ? <Text className="text-[14px] leading-[20px]">{item.summary}</Text> : null}
      {item.nextStep ? <Note>{`${W.nextStepLabel}: ${item.nextStep}`}</Note> : null}
      {item.post ? (
        <Text className="rounded-control bg-card-2 px-3 py-2 text-[14px] leading-[20px]">
          {item.post}
        </Text>
      ) : null}
      {item.send ? (
        <View className="gap-2" testID="today-send">
          <Note>{item.send.state === 'waiting' ? W.sentWaiting : W.sentOkd}</Note>
          <Text
            selectable
            className="rounded-control bg-card-2 px-3 py-2 text-[14.5px] leading-[21px]"
          >
            {item.send.text}
          </Text>
        </View>
      ) : null}
      <View className="flex-row flex-wrap gap-2">
        {item.send?.state === 'waiting' ? (
          <>
            <Button
              size="md"
              icon={Check}
              onPress={() => onOk(item.send!.sendId)}
              testID="today-ok"
            >
              {W.ok}
            </Button>
            <Button
              size="md"
              variant="ghost"
              icon={X}
              onPress={() => onSkip(item.send!.sendId)}
              testID="today-skip"
            >
              {W.skip}
            </Button>
          </>
        ) : null}
        {item.kind === 'comment' && item.postId ? (
          <Button
            size="md"
            variant="ghost"
            icon={X}
            onPress={() => onNotForMe(item.postId!)}
            testID="today-not-for-me"
          >
            {W.notForMe}
          </Button>
        ) : null}
        {page ? (
          <Button size="md" variant="ghost" icon={ExternalLink} onPress={() => openOutside(page)}>
            {chat && item.kind !== 'comment' ? W.openInMessenger : W.openOnFacebook}
          </Button>
        ) : null}
      </View>
    </Card>
  );
}
