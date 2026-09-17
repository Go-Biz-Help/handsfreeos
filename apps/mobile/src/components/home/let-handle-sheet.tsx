import {
  ATTENTION_KIND_LABELS,
  ATTENTION_WORDS,
  clockLabel,
  firstNameOr,
  handleButtonOf,
  handToAiBullets,
  handToAiStays,
  itemCustomerOf,
  letHandleAskButton,
  letHandleAutoButton,
  letHandleAutoToast,
  letHandleFootnote,
  letHandleNoneFallback,
  letHandleReplyBy,
  letHandleStops,
  letHandleSubOf,
  letHandleTitleOf,
  letHandleTo,
  type AttentionItemOut,
  type LetHandleChoice,
} from '@hfos/core';
import * as React from 'react';
import { Pressable, TextInput, View } from 'react-native';

import { useAiColors } from '@/components/drafts';
import {
  CalendarPlus,
  Check,
  ChevronRight,
  CircleAlert,
  Info,
  Mail,
  MessageCircle,
  Send,
  Sparkles,
  Zap,
} from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { change, ChangeError } from '@/changes';
import { api, errorMessage, unwrap } from '@/lib/api';
import { useNetwork } from '@/lib/network';
import { cn } from '@/lib/utils';
import type { HandlePreview } from '@/home/api-types';
import { HOME_PHONE_WORDS } from '@/home/words';
import { useColors } from '@/theme';

import { KindTile, ModeChip } from './bits';
import { useHomeEnv } from './home-context';

type Item = AttentionItemOut;
type Preview = HandlePreview;

/** What the preview said for each item this session, so the sheet can still show it with no signal. */
const previews = new Map<string, Preview>();

function InfoRow({ children }: { children: React.ReactNode }) {
  return (
    <View className="flex-row items-start gap-2 rounded-[9px] bg-card-2 px-[11px] py-[9px]">
      <Icon as={Info} className="mt-px size-4 text-text-2" />
      <Text className="min-w-0 flex-1 text-[12.5px] leading-[18px] text-text-2">{children}</Text>
    </View>
  );
}

function WarnRow({ children }: { children: React.ReactNode }) {
  return (
    <View
      role="alert"
      testID="let-handle-blocked"
      className="flex-row items-start gap-2.5 rounded-[10px] bg-warning-soft px-3 py-2.5"
    >
      <Icon as={CircleAlert} strokeWidth={1.75} className="mt-px size-4 text-warning-text" />
      <Text className="min-w-0 flex-1 text-[13px] leading-[19px] text-warning-text">
        {children}
      </Text>
    </View>
  );
}

const SECL = 'text-[11.5px] font-semibold uppercase tracking-[0.5px] text-text-3';

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string | null;
  children: React.ReactNode;
}) {
  return (
    <View className="gap-1.5">
      <Text className="text-[13.5px] font-medium">{label}</Text>
      {children}
      {error ? (
        <Text role="alert" className="text-[12.5px] text-danger-text">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * Let HandsFreeOS Handle on the phone: exactly what will happen, before it does (`attention.preview_handle`, which
 * needs signal), as the web's sheet shows it.
 * - On its own (a confirmation request, a follow-up): the words as they'd go out, the channel, why not if it can't.
 *   With no signal it still goes: the change waits on the phone like any message, fresh for 30 minutes.
 * - Asks first: the choices (hand to the AI teammate, a reply, a next action), each run as this person.
 * - Never (approvals, tasks): why.
 */
export function LetHandleSheet({ item, onClose }: { item: Item | null; onClose: () => void }) {
  const env = useHomeEnv();
  const colors = useColors();
  const ai = useAiColors();
  const { online } = useNetwork();
  const [shown, setShown] = React.useState<Item | null>(item);
  const [preview, setPreview] = React.useState<Preview | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [choice, setChoice] = React.useState<LetHandleChoice | null>(null);
  const [body, setBody] = React.useState('');
  const [subject, setSubject] = React.useState('');
  const [nextText, setNextText] = React.useState('');
  const [formError, setFormError] = React.useState<string | null>(null);

  const apply = React.useCallback((p: Preview) => {
    setPreview(p);
    const first = p.options.find((o) => o.available) ?? p.options[0];
    setChoice(first?.action ?? null);
    setNextText(p.options.find((o) => o.action === 'set_next_action')?.suggestion?.text ?? '');
    // A money card's follow-up comes already written, from the document's own figures.
    setBody(first?.draft?.body ?? '');
    setSubject(first?.draft?.subject ?? '');
  }, []);

  React.useEffect(() => {
    if (!item) return;
    setShown(item);
    setError(null);
    setFormError(null);
    setPreview(null);
    const kept = previews.get(item.id);
    if (kept) apply(kept);
    if (!online) return;
    let cancelled = false;
    api
      .POST('/v1/queries/attention.preview_handle', {
        body: { workspaceId: env.workspaceId, itemId: item.id },
      })
      .then((r) => {
        const p = unwrap(r);
        previews.set(item.id, p);
        if (!cancelled) apply(p);
      })
      .catch((e: unknown) => {
        if (!cancelled && !kept) setError(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
    // `online` is read once, when the sheet opens: signal coming back doesn't redo the preview under a finger.
  }, [item, env.workspaceId, apply]);

  const it = item ?? shown;
  if (!it) return null;

  const name = itemCustomerOf(it) ?? it.title;
  const first = firstNameOr(name);
  const mode = preview?.mode ?? it.letHandleMode;
  const plan = preview?.auto ?? null;
  const option = preview?.options.find((o) => o.action === choice) ?? null;
  const confirm = (plan?.action ?? it.auto.action) === 'confirm_request';
  const clock = (iso: string) => clockLabel(Date.parse(iso), env.timeZone);
  const title = letHandleTitleOf({
    item: it,
    mode,
    choice,
    confirm,
    teammateName: env.teammateName,
  });
  const sub = letHandleSubOf(it, env.now, env.timeZone);
  const scheduledFor = plan?.scheduledFor ?? null;

  async function run(work: () => Promise<void>) {
    setBusy(true);
    try {
      await work();
    } catch (e) {
      toast.error(e instanceof ChangeError || e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const said = (words: string) => (online ? words : HOME_PHONE_WORDS.queued(words));

  const sendAuto = () =>
    run(async () => {
      await change('attention.let_handle', { workspaceId: env.workspaceId, itemId: it.id });
      const at = plan?.sendAt ?? null;
      toast.show(
        said(
          letHandleAutoToast({ confirm, channel: plan?.channel, first, at: at ? clock(at) : null }),
        ),
      );
      onClose();
    });
  const cancelAuto = () => {
    onClose();
    env.act.cancelAuto(it);
  };
  const runAsk = () =>
    run(async () => {
      if (!option?.available) return;
      setFormError(null);
      const base = { workspaceId: env.workspaceId, itemId: it.id };
      if (option.action === 'reply') {
        if (!body.trim()) return setFormError(ATTENTION_WORDS.writeMessage);
        await change('attention.let_handle', {
          ...base,
          action: 'reply',
          body: body.trim(),
          ...(option.channel ? { channel: option.channel } : {}),
          ...(option.channel === 'email' && subject.trim() ? { subject: subject.trim() } : {}),
        });
        toast.show(said(ATTENTION_WORDS.sentToast(first)));
      } else if (option.action === 'set_next_action') {
        if (!nextText.trim()) return setFormError(ATTENTION_WORDS.sayNext);
        await change('attention.let_handle', {
          ...base,
          action: 'set_next_action',
          text: nextText.trim(),
          dueAt: option.suggestion?.dueAt ?? null,
        });
        toast.show(said(ATTENTION_WORDS.nextActionSetToast));
      } else {
        await change('attention.let_handle', { ...base, action: 'hand_to_ai' });
        toast.show(said(ATTENTION_WORDS.handedToast(env.teammateName, first)));
      }
      onClose();
    });
  const doItMyself = () => {
    onClose();
    env.act.handle(it);
  };

  let content: React.ReactNode;
  let footer: React.ReactNode = null;
  if (mode === 'none') {
    content = <InfoRow>{preview?.reason ?? letHandleNoneFallback(it.kind)}</InfoRow>;
  } else if (!preview && error) {
    content = (
      <Text role="alert" className="text-[13px] text-danger-text">
        {error}
      </Text>
    );
  } else if (!preview && online) {
    content = <Text className="text-[13px] text-text-3">{ATTENTION_WORDS.workingOut}</Text>;
  } else if (!preview && mode === 'auto') {
    // No signal and no preview yet: it can still go, as the change waits on the phone.
    content = <InfoRow>{HOME_PHONE_WORDS.previewNeedsSignal}</InfoRow>;
    footer = (
      <Button icon={Zap} loading={busy} onPress={sendAuto} testID="let-handle-confirm">
        {letHandleAutoButton(confirm, null)}
      </Button>
    );
  } else if (!preview) {
    content = <InfoRow>{HOME_PHONE_WORDS.choicesNeedSignal}</InfoRow>;
  } else if (mode === 'auto' && plan) {
    content = (
      <>
        {plan.blocked ? <WarnRow>{plan.blocked.message}</WarnRow> : null}
        {plan.notes.map((n) => (
          <InfoRow key={n}>{n}</InfoRow>
        ))}
        {plan.text ? (
          <View className="gap-2">
            <View className="flex-row items-center gap-2">
              <Text className={cn(SECL, 'flex-1')}>{ATTENTION_WORDS.whatItSends}</Text>
              {plan.to ? (
                <View className="min-w-0 flex-row items-center gap-1.5">
                  <Icon
                    as={plan.channel === 'email' ? Mail : MessageCircle}
                    className="size-3.5 text-text-3"
                  />
                  <Text numberOfLines={1} className="text-xs text-text-3">
                    {letHandleTo(plan.channel, plan.to)}
                  </Text>
                </View>
              ) : null}
            </View>
            {plan.channel === 'email' ? (
              <View className="overflow-hidden rounded-card border border-border bg-card">
                {plan.subject ? (
                  <Text className="border-b border-border px-4 py-2.5 text-[13px] font-medium">
                    {plan.subject}
                  </Text>
                ) : null}
                <Text className="px-4 py-3.5 text-[13.5px] leading-[20px]" testID="let-handle-text">
                  {plan.text}
                </Text>
              </View>
            ) : (
              <View className="rounded-card border border-border bg-card-2 px-4 py-3.5">
                <View className="max-w-[92%] self-end rounded-2xl rounded-br-[5px] bg-accent px-[13px] py-2.5">
                  <Text className="text-sm leading-[20px] text-white" testID="let-handle-text">
                    {plan.text}
                  </Text>
                </View>
              </View>
            )}
            <Text className="text-xs text-text-3">{letHandleFootnote(confirm, plan.channel)}</Text>
          </View>
        ) : null}
        {plan.checks.length ? (
          <View className="gap-1.5">
            <Text className={SECL}>{ATTENTION_WORDS.checkedJustNow}</Text>
            <View className="gap-1.5" testID="let-handle-checks">
              {plan.checks.map((c) => (
                <View key={c.code} className="flex-row items-start gap-2">
                  <Icon
                    as={c.ok ? Check : CircleAlert}
                    strokeWidth={c.ok ? 2 : 1.75}
                    className={cn('mt-px size-4', c.ok ? 'text-success-text' : 'text-warning-text')}
                  />
                  <Text className="min-w-0 flex-1 text-[13px] text-text-2">{c.label}</Text>
                </View>
              ))}
            </View>
          </View>
        ) : null}
        {scheduledFor ? (
          <View
            testID="let-handle-goes"
            className="flex-row items-center gap-2.5 rounded-[10px] bg-accent-soft px-3.5 py-[11px]"
          >
            <Icon as={Zap} strokeWidth={1.75} className="size-4 text-accent-text" />
            <Text className="min-w-0 flex-1 text-[13.5px] font-semibold text-accent-text">
              {ATTENTION_WORDS.goesOutAt(clock(scheduledFor))}
            </Text>
            <Pressable role="button" hitSlop={10} onPress={cancelAuto} testID="let-handle-cancel">
              <Text className="text-[13.5px] font-semibold text-accent-text underline">
                {ATTENTION_WORDS.cancel}
              </Text>
            </Pressable>
          </View>
        ) : null}
        {plan.blocked ? null : (
          <Text className="text-xs text-text-3">{letHandleStops(first, plan.channel)}</Text>
        )}
      </>
    );
    const myself = confirm
      ? it.personId
        ? ATTENTION_WORDS.callInstead(first)
        : null
      : ATTENTION_WORDS.myself(handleButtonOf(it, true).label);
    footer = (
      <>
        {!plan.blocked && !scheduledFor ? (
          <Button icon={Zap} loading={busy} onPress={sendAuto} testID="let-handle-confirm">
            {letHandleAutoButton(confirm, plan.sendAt ? clock(plan.sendAt) : null)}
          </Button>
        ) : null}
        {myself ? (
          <Button
            variant="secondary"
            onPress={
              confirm
                ? () => {
                    onClose();
                    env.act.call(it);
                  }
                : doItMyself
            }
          >
            {myself}
          </Button>
        ) : null}
      </>
    );
  } else {
    const options = preview.options;
    content = (
      <>
        {options.length > 1 && choice ? (
          <Segmented<LetHandleChoice>
            label="What HandsFreeOS does"
            value={choice}
            onChange={(v) => {
              setChoice(v);
              setFormError(null);
            }}
            options={options.map((o) => ({
              value: o.action,
              label: o.label,
              disabled: !o.available,
              testID: `let-handle-option-${o.action}`,
            }))}
          />
        ) : null}
        {option?.action === 'hand_to_ai' ? (
          <>
            <View className="flex-row items-center gap-2.5">
              <View
                className="size-8 items-center justify-center rounded-full"
                style={{ backgroundColor: ai.soft }}
              >
                <Sparkles size={15} color={ai.text} strokeWidth={1.75} />
              </View>
              <View>
                <Text className="text-[13.5px] font-medium">
                  {ATTENTION_WORDS.aiWill(env.teammateName)}
                </Text>
                <Text className="text-xs text-text-3">{ATTENTION_WORDS.asSetUp}</Text>
              </View>
            </View>
            <View className="gap-2 pl-1">
              {handToAiBullets(option.channel, first).map((b) => (
                <View key={b} className="flex-row items-start gap-2">
                  <Icon
                    as={ChevronRight}
                    strokeWidth={1.75}
                    className="mt-0.5 size-4 text-text-3"
                  />
                  <Text className="min-w-0 flex-1 text-[13.5px]">{b}</Text>
                </View>
              ))}
            </View>
            <InfoRow>{handToAiStays(first, it.assignee, env.teammateName)}</InfoRow>
          </>
        ) : option?.action === 'reply' ? (
          <View className="gap-2.5">
            <Text className="text-xs text-text-3">{letHandleReplyBy(option.channel)}</Text>
            {option.channel === 'email' ? (
              <Field label={ATTENTION_WORDS.subject}>
                <Input value={subject} onChangeText={setSubject} />
              </Field>
            ) : null}
            <Field label={ATTENTION_WORDS.message} error={formError}>
              <TextInput
                value={body}
                multiline
                placeholder={ATTENTION_WORDS.replyPlaceholder(first)}
                placeholderTextColor={colors.placeholder}
                selectionColor={colors.accent}
                onChangeText={setBody}
                testID="let-handle-body"
                className={cn(
                  'min-h-[112px] rounded-menu border bg-card px-3.5 py-2.5 font-sans text-base text-text',
                  formError ? 'border-danger' : 'border-border-strong',
                )}
                style={{ textAlignVertical: 'top' }}
              />
            </Field>
          </View>
        ) : option?.action === 'set_next_action' ? (
          <Field label={ATTENTION_WORDS.nextAction} error={formError}>
            <Input
              value={nextText}
              invalid={!!formError}
              onChangeText={setNextText}
              testID="let-handle-next"
            />
          </Field>
        ) : null}
        {option?.note ? <InfoRow>{option.note}</InfoRow> : null}
        {options
          .filter((o) => !o.available && o.reason)
          .map((o) =>
            o.action === 'reply' && options.length === 1 ? (
              <WarnRow key={o.action}>{o.reason}</WarnRow>
            ) : (
              <InfoRow key={o.action}>
                <Text className="text-[12.5px] font-semibold text-text-2">{o.label}:</Text>{' '}
                {o.reason}
              </InfoRow>
            ),
          )}
      </>
    );
    footer = (
      <>
        <Button
          icon={
            option?.action === 'reply'
              ? Send
              : option?.action === 'set_next_action'
                ? CalendarPlus
                : Sparkles
          }
          loading={busy}
          disabled={!option?.available}
          onPress={runAsk}
          testID="let-handle-confirm"
        >
          {letHandleAskButton(option?.action ?? null, env.teammateName)}
        </Button>
        {option?.action === 'hand_to_ai' && it.actions.handle ? (
          <Button variant="secondary" onPress={doItMyself}>
            {it.kind === 'hot_lead'
              ? ATTENTION_WORDS.callMyself(first)
              : ATTENTION_WORDS.replyMyself}
          </Button>
        ) : null}
      </>
    );
  }

  return (
    <Sheet open={!!item} onClose={onClose} testID="let-handle-sheet" scroll>
      <View className="flex-row items-start gap-3 border-b border-border pb-3.5">
        <KindTile kind={it.kind} size="lg" />
        <View className="min-w-0 flex-1 gap-[3px]">
          <Text className={SECL}>{ATTENTION_WORDS.letHandle}</Text>
          <Text
            role="heading"
            className="text-[17px] font-semibold leading-[22px]"
            testID="let-handle-title"
          >
            {mode === 'none' ? `${ATTENTION_KIND_LABELS[it.kind]}: ${name}` : title}
          </Text>
          {sub ? <Text className="text-xs text-text-3">{sub}</Text> : null}
          <View className="mt-1">
            <ModeChip mode={mode} />
          </View>
        </View>
      </View>
      <View className="gap-3.5 py-4">{content}</View>
      <View className="gap-2 border-t border-border pt-3.5">
        {footer}
        <Button variant="ghost" onPress={onClose} testID="let-handle-close">
          {mode === 'ask' ? ATTENTION_WORDS.cancel : ATTENTION_WORDS.close}
        </Button>
      </View>
    </Sheet>
  );
}
