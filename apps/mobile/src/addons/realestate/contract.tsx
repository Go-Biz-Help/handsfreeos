import { RE_CONTRACT_WORDS } from '@hfos/core/addons/realestate/phone-words-deals';
import {
  contractReadOfCopy,
  type ContractReadView,
} from '@hfos/core/addons/realestate/views/contract-read';
import * as React from 'react';
import { View } from 'react-native';

import { TriangleAlert } from '@/components/icons';
import { Screen } from '@/components/shell/screen';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';

import { useRealestateCopy } from './copy';
import { confirmValues } from './deal-actions';
import { Footnote, GroupLabel, KeptStrip } from './deal-bits';
import { NeedsSignalCard, SignalButton, useReContext } from './kit';

/**
 * The contract as HandsFreeOS read it (board 80): each term with its page and clause, and what still needs a person.
 * Reading is offline; confirming or changing a term needs signal, because it moves the deal's dates and duties.
 */

export function ContractScreen({ dealId, readId }: { dealId: string; readId: string }) {
  const ctx = useReContext();
  const copy = useRealestateCopy(ctx.workspaceId, { kind: 'deal', dealId });
  const read = React.useMemo(
    () => contractReadOfCopy(copy, dealId, readId, ctx),
    [copy, dealId, readId, ctx],
  );
  return <ContractView read={read} workspaceId={ctx.workspaceId} />;
}

export function ContractView({
  read,
  workspaceId,
}: {
  read: ContractReadView | null;
  workspaceId: string;
}) {
  if (!read)
    return (
      <Screen title={RE_CONTRACT_WORDS.title} leading="back" testID="re-contract">
        <NeedsSignalCard words={RE_CONTRACT_WORDS.notHere} testID="re-contract-missing" />
      </Screen>
    );
  const decided = read.values.filter((v) => v.state !== 'waiting').length;
  const waiting = read.values.length - decided;
  const confirmed = read.values.filter((v) => v.state === 'confirmed').length;
  return (
    <Screen
      title={RE_CONTRACT_WORDS.title}
      subtitle={RE_CONTRACT_WORDS.subtitle(read.fileName ?? read.documentTitle, read.version)}
      leading="back"
      testID="re-contract"
      header={<KeptStrip inset />}
    >
      {read.state === 'reading' ? (
        <NeedsSignalCard words={RE_CONTRACT_WORDS.reading} />
      ) : read.state === 'failed' ? (
        <NeedsSignalCard words={RE_CONTRACT_WORDS.failed(read.failure)} />
      ) : (
        <>
          <View className="flex-row flex-wrap gap-1.5 px-1">
            <Badge variant={read.scan ? 'pending' : 'gray'}>
              <Text>{read.scan ? RE_CONTRACT_WORDS.scan : RE_CONTRACT_WORDS.text}</Text>
            </Badge>
            <Badge variant={waiting === 0 ? 'ok' : 'gray'} testID="re-contract-count">
              <Text>{RE_CONTRACT_WORDS.confirmed(confirmed, read.values.length)}</Text>
            </Badge>
          </View>
          <View
            className="overflow-hidden rounded-card border border-border bg-card"
            testID="re-contract-values"
          >
            {read.values.map((v, i) => (
              <View
                key={v.id}
                className={cn('flex-row gap-3 px-3.5 py-3', i > 0 && 'border-t border-border')}
                testID={`re-contract-value-${v.key}`}
              >
                <Text className="w-[38%] text-[14.5px] text-text-2">{v.label}</Text>
                <View className="flex-1 items-end gap-0.5">
                  <Text
                    className={cn(
                      'text-right text-[14.5px]',
                      v.state === 'rejected' && 'text-text-3 line-through',
                    )}
                  >
                    {v.worked ? `${v.value} (${v.worked})` : v.value}
                  </Text>
                  <Text className="text-right text-[12.5px] text-text-3">
                    {[
                      RE_CONTRACT_WORDS.page(v.page, v.clause),
                      read.kind === 'amendment' ? RE_CONTRACT_WORDS.amended : null,
                      v.state === 'waiting'
                        ? RE_CONTRACT_WORDS.waiting
                        : v.state === 'rejected'
                          ? RE_CONTRACT_WORDS.rejected
                          : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </Text>
                </View>
              </View>
            ))}
          </View>
          {read.unclear.length ? (
            <>
              <GroupLabel label={RE_CONTRACT_WORDS.needsPerson} count={read.unclear.length} />
              <Card testID="re-contract-unclear">
                {read.unclear.map((u, i) => (
                  <View
                    key={i}
                    className={cn('flex-row gap-3 px-3.5 py-3', i > 0 && 'border-t border-border')}
                  >
                    <Icon as={TriangleAlert} className="mt-0.5 size-[18px] text-warning-text" />
                    <View className="flex-1 gap-px">
                      <Text className="text-[15px]">{u.what}</Text>
                      <Text className="text-[13px] text-text-3">
                        {[u.quote ? `“${u.quote}”` : null, RE_CONTRACT_WORDS.page(u.page, u.clause)]
                          .filter(Boolean)
                          .join(' · ')}
                      </Text>
                    </View>
                  </View>
                ))}
              </Card>
            </>
          ) : null}
          {read.dropped > 0 ? <Footnote>{RE_CONTRACT_WORDS.dropped(read.dropped)}</Footnote> : null}
          {waiting > 0 ? (
            <SignalButton
              label={RE_CONTRACT_WORDS.confirmAll(waiting)}
              why={RE_CONTRACT_WORDS.footer}
              onPress={() =>
                void confirmValues(workspaceId, read.readId)
                  .then(() => toast.show(RE_CONTRACT_WORDS.confirmedDone(waiting)))
                  .catch((e: unknown) => toast.error(errorMessage(e)))
              }
              testID="re-contract-confirm"
            />
          ) : null}
          <Footnote>{RE_CONTRACT_WORDS.footer}</Footnote>
        </>
      )}
    </Screen>
  );
}
