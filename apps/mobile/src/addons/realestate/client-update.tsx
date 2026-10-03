import { localDateOf } from '@hfos/core';
import { RE_UPDATE_WORDS } from '@hfos/core/addons/realestate/phone-words-deals';
import {
  clientUpdateOfCopy,
  type ClientUpdateView,
} from '@hfos/core/addons/realestate/views/drafts';
import * as React from 'react';
import { TextInput, View } from 'react-native';

import { Pencil, Send } from '@/components/icons';
import { Screen } from '@/components/shell/screen';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { changes as queue } from '@/changes';
import { errorMessage } from '@/lib/api';
import { useColors } from '@/theme';

import { useRealestateCopy } from './copy';
import { saveUpdate, sendUpdate } from './deal-actions';
import { changesFor, dayOf, Footnote, useReChanges, WaitStrip, type ReChange } from './deal-bits';
import { NeedsSignalCard, useReContext } from './kit';

/**
 * A client update (board 81's last panel): the AI's draft, checked and OK'd by the person. Checking and OK'ing works
 * anywhere; OK'd with no signal it goes while fresh, and one that waited more than 30 minutes asks "Still send?" before
 * it reaches the client. Writing a draft needs signal (the AI), and so does checking it for fair housing.
 */

export function ClientUpdateScreen({ dealId, draftId }: { dealId: string; draftId: string }) {
  const ctx = useReContext();
  const copy = useRealestateCopy(ctx.workspaceId, { kind: 'deal', dealId });
  const update = React.useMemo(
    () => clientUpdateOfCopy(copy, dealId, draftId, ctx),
    [copy, dealId, draftId, ctx],
  );
  const changes = useReChanges(ctx.workspaceId);
  return (
    <ClientUpdateViewScreen
      dealName={copy.deals.get(dealId)?.name ?? ''}
      update={update}
      changes={changes}
      workspaceId={ctx.workspaceId}
      timeZone={ctx.timeZone}
      now={ctx.now}
    />
  );
}

/** "50 minutes ago", "2 hours ago". */
export function agoWords(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
}

export function ClientUpdateViewScreen({
  dealName,
  update,
  changes,
  workspaceId,
  timeZone,
  now,
}: {
  dealName: string;
  update: ClientUpdateView | null;
  changes: readonly ReChange[];
  workspaceId: string;
  timeZone: string;
  now: number;
}) {
  const [editing, setEditing] = React.useState(false);
  const [subject, setSubject] = React.useState(update?.subject ?? '');
  const [body, setBody] = React.useState(update?.body ?? '');
  const [dismissed, setDismissed] = React.useState<string | null>(null);
  const colors = useColors();
  if (!update)
    return (
      <Screen title={RE_UPDATE_WORDS.title} leading="back" testID="re-update">
        <NeedsSignalCard words={RE_UPDATE_WORDS.notHere} testID="re-update-missing" />
      </Screen>
    );
  const sends = changesFor(changes, 'realestate.status_email.send', 'draftId', update.draftId);
  const saves = changesFor(changes, 'realestate.status_email.save', 'draftId', update.draftId);
  const stale = sends.find((c) => c.state === 'ask' && c.rule === 'stale_action') ?? null;
  const okd = sends.length > 0;
  const status = okd
    ? RE_UPDATE_WORDS.waitingToSend
    : (RE_UPDATE_WORDS.status[update.status] ?? update.status);
  const to = update.to?.name ?? '';

  const ok = async () => {
    try {
      const sent = await sendUpdate(
        workspaceId,
        update.draftId,
        saves.map((c) => c.id),
      );
      toast.show(sent.queued ? RE_UPDATE_WORDS.okWaits : RE_UPDATE_WORDS.sent);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const save = async () => {
    try {
      await saveUpdate(workspaceId, update.draftId, { subject, body });
      setEditing(false);
      toast.show(RE_UPDATE_WORDS.saved);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <Screen
      title={RE_UPDATE_WORDS.title}
      subtitle={RE_UPDATE_WORDS.subtitle(dealName, status)}
      leading="back"
      testID="re-update"
      header={<WaitStrip waiting={sends.length + saves.length} inset />}
    >
      {update.status === 'drafting' ? (
        <NeedsSignalCard words={RE_UPDATE_WORDS.drafting} testID="re-update-drafting" />
      ) : update.status === 'discarded' ? (
        <NeedsSignalCard words={RE_UPDATE_WORDS.discarded} />
      ) : update.status === 'failed' ? (
        <NeedsSignalCard words={RE_UPDATE_WORDS.failed} />
      ) : (
        <>
          {to ? (
            <Text className="px-1 text-[13.5px] text-text-2">{RE_UPDATE_WORDS.to(to)}</Text>
          ) : null}
          {editing ? (
            <View className="gap-2.5">
              <Input
                value={subject}
                onChangeText={setSubject}
                accessibilityLabel={RE_UPDATE_WORDS.subject}
                testID="re-update-subject"
              />
              <TextInput
                value={body}
                onChangeText={setBody}
                multiline
                accessibilityLabel={RE_UPDATE_WORDS.body}
                placeholderTextColor={colors.placeholder}
                className="min-h-40 rounded-menu border border-border-strong bg-card px-3.5 py-3 font-sans text-base text-text"
                testID="re-update-body-input"
              />
              <Button
                disabled={!subject.trim() || !body.trim()}
                onPress={() => void save()}
                testID="re-update-save"
              >
                {RE_UPDATE_WORDS.save}
              </Button>
            </View>
          ) : (
            <Card className="gap-2 px-4 py-3.5">
              {update.subject ? (
                <Text className="text-[15px] font-semibold">{update.subject}</Text>
              ) : null}
              <Text className="text-[15px] leading-[22px]" testID="re-update-body">
                {update.body}
              </Text>
            </Card>
          )}
          <View className="flex-row px-1">
            <Badge variant="gray" testID="re-update-fair-housing">
              <Text>{RE_UPDATE_WORDS.fairHousing}</Text>
            </Badge>
          </View>
          {update.status === 'sent' ? (
            <Text className="px-1 text-[14px] text-text-2">
              {RE_UPDATE_WORDS.sentOn(
                update.sentAt
                  ? (dayOf(localDateOf(Date.parse(update.sentAt), timeZone), timeZone, now) ?? '')
                  : '',
              )}
            </Text>
          ) : !editing && !okd ? (
            <View className="gap-2.5">
              <Button icon={Send} onPress={() => void ok()} testID="re-update-ok">
                {RE_UPDATE_WORDS.ok}
              </Button>
              <Button
                variant="secondary"
                icon={Pencil}
                onPress={() => setEditing(true)}
                testID="re-update-edit"
              >
                {RE_UPDATE_WORDS.edit}
              </Button>
            </View>
          ) : null}
          <Footnote>{RE_UPDATE_WORDS.writeNeedsSignal}</Footnote>
        </>
      )}
      <Sheet
        open={stale !== null && dismissed !== stale.id}
        onClose={() => setDismissed(stale?.id ?? null)}
        title={RE_UPDATE_WORDS.stillSend}
        description={
          stale
            ? RE_UPDATE_WORDS.stillSendAbout(
                to || 'the client',
                agoWords(now - Date.parse(stale.madeAt)),
              )
            : undefined
        }
        testID="re-update-still-send"
      >
        <View className="gap-2.5 pt-3">
          <Card className="bg-card-2 px-3.5 py-3">
            <Text className="text-[14.5px] leading-[21px]" numberOfLines={6}>
              {update.body}
            </Text>
          </Card>
          <View className="flex-row">
            <Badge variant="gray">
              <Text>{RE_UPDATE_WORDS.fairHousing}</Text>
            </Badge>
          </View>
          <Button
            icon={Send}
            onPress={() =>
              void queue
                .stillSend(stale!.id)
                .then(() => setDismissed(stale!.id))
                .catch((e: unknown) => toast.error(errorMessage(e)))
            }
            testID="re-update-send-now"
          >
            {RE_UPDATE_WORDS.sendNow}
          </Button>
          <Button
            variant="secondary"
            icon={Pencil}
            onPress={() =>
              void queue
                .discard([stale!.id])
                .then(() => {
                  setDismissed(stale!.id);
                  setEditing(true);
                  toast.show(RE_UPDATE_WORDS.editInstead);
                })
                .catch((e: unknown) => toast.error(errorMessage(e)))
            }
            testID="re-update-edit-instead"
          >
            {RE_UPDATE_WORDS.edit}
          </Button>
        </View>
      </Sheet>
    </Screen>
  );
}
