import {
  deskSectionLabel,
  STAFF_ROLE_CHOICES,
  STAFF_ROLE_WORDS,
  SUPPORT_TEAM_WORDS,
  supportInvitationLine,
  supportInviteEmailOk,
  supportPersonLine,
  supportPersonName,
  type StaffRole,
} from '@hfos/core';
import * as React from 'react';
import { Pressable, RefreshControl, ScrollView, View } from 'react-native';

import { desk, useLive, type Ok } from '@/admin/live';
import { loadStaff } from '@/admin/staff';
import { TEAM_PHONE_WORDS } from '@/admin/team-words';
import { DeskWaiting, PickSheet, Section } from '@/components/admin/bits';
import { deskHref, useDesk, useDeskCan } from '@/components/admin/staff-context';
import { Check, ChevronDown, UserPlus } from '@/components/icons';
import { useKeyboardHeight } from '@/components/shell/keyboard';
import { Screen } from '@/components/shell/screen';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { FieldError, Label } from '@/components/ui/label';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useColors } from '@/theme';

type StaffList = Ok<'/v1/queries/support.staff.list'>;
type Person = StaffList['staff'][number];
type Invitation = StaffList['invitations'][number];

/** Taking somebody's desk away, for now or for good: asked first. */
type Asking = { readonly kind: 'suspend' | 'remove'; readonly person: Person };

/**
 * Support people (the web's /admin/staff): who answers HandsFreeOS support, with their role and how many open tickets
 * each has; the invitations waiting to be accepted; and how the person reading signs off their replies. A support
 * admin (`platform.staff.manage`) also invites, sends an invitation again or cancels it, changes someone's role, and
 * suspends, lets back in or removes them, asking first before suspending or removing. Nobody changes their own role,
 * so their own row has none of those; the last admin can't be removed or demoted, and the API says so.
 */
export default function SupportPeople() {
  const colors = useColors();
  const { userId } = useDesk();
  const canManage = useDeskCan('platform.staff.manage');
  const list = useLive(() => desk('/v1/queries/support.staff.list', {}), 'staff-list');
  const me = useLive(() => desk('/v1/queries/platform.me', {}), 'platform-me');

  const [busy, setBusy] = React.useState<string | null>(null);
  const [inviting, setInviting] = React.useState(false);
  // The person a sheet is about is kept while it slides away, so its words don't change on the way down.
  const [roleFor, setRoleFor] = React.useState<Person | null>(null);
  const [roleOpen, setRoleOpen] = React.useState(false);
  const [asking, setAsking] = React.useState<Asking | null>(null);
  const [askOpen, setAskOpen] = React.useState(false);

  /** One change to the team, then the list asked for again; the API's words if it can't. */
  const run = async (what: string, fn: () => Promise<unknown>, said: string) => {
    setBusy(what);
    try {
      await fn();
      toast.show(said);
      list.reload();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const setStatus = (p: Person, status: 'active' | 'suspended') =>
    run(
      p.userId,
      () => desk('/v1/commands/support.staff.set_role', { userId: p.userId, status }),
      status === 'active' ? TEAM_PHONE_WORDS.letBackIn : TEAM_PHONE_WORDS.suspended,
    );

  const refresh = () => {
    list.reload();
    me.reload();
  };

  const data = list.data;
  const mine = me.data?.staff ?? null;

  return (
    <Screen
      title={deskSectionLabel('staff')}
      leading="back"
      back={deskHref()}
      scroll={false}
      testID="desk-staff"
    >
      {data ? (
        <ScrollView
          className="flex-1"
          contentContainerClassName="gap-3 p-3 pb-8"
          keyboardShouldPersistTaps="handled"
          refreshControl={
            <RefreshControl
              refreshing={list.refreshing}
              onRefresh={refresh}
              tintColor={colors.accent}
            />
          }
        >
          {canManage ? (
            <Button icon={UserPlus} onPress={() => setInviting(true)} testID="staff-invite-open">
              {SUPPORT_TEAM_WORDS.invite}
            </Button>
          ) : null}

          <View
            className="overflow-hidden rounded-card border border-border bg-card"
            testID="staff-list"
          >
            {data.staff.map((s, i) => (
              <PersonRow
                key={s.userId}
                person={s}
                me={s.userId === userId}
                first={i === 0}
                manage={canManage && s.userId !== userId}
                busy={busy === s.userId}
                onRole={() => {
                  setRoleFor(s);
                  setRoleOpen(true);
                }}
                onSuspend={() => {
                  setAsking({ kind: 'suspend', person: s });
                  setAskOpen(true);
                }}
                onLetBackIn={() => void setStatus(s, 'active')}
                onRemove={() => {
                  setAsking({ kind: 'remove', person: s });
                  setAskOpen(true);
                }}
              />
            ))}
          </View>

          {data.invitations.length ? (
            <Section title={SUPPORT_TEAM_WORDS.waiting} testID="staff-invitations">
              {data.invitations.map((inv, i) => (
                <InvitationRow
                  key={inv.id}
                  invitation={inv}
                  first={i === 0}
                  manage={canManage}
                  busy={busy === inv.id}
                  onResend={() =>
                    void run(
                      inv.id,
                      () =>
                        desk('/v1/commands/support.staff.resend_invitation', {
                          invitationId: inv.id,
                        }),
                      TEAM_PHONE_WORDS.resent,
                    )
                  }
                  onRevoke={() =>
                    void run(
                      inv.id,
                      () =>
                        desk('/v1/commands/support.staff.revoke_invitation', {
                          invitationId: inv.id,
                        }),
                      TEAM_PHONE_WORDS.revoked,
                    )
                  }
                />
              ))}
            </Section>
          ) : null}

          {mine ? (
            <MyProfile
              userId={userId}
              displayName={mine.displayName}
              signature={mine.signature}
              onSaved={list.reload}
            />
          ) : null}
        </ScrollView>
      ) : (
        <DeskWaiting live={list} testID="staff" />
      )}

      {canManage ? (
        <>
          <PickSheet<StaffRole>
            open={roleOpen}
            onClose={() => setRoleOpen(false)}
            title={SUPPORT_TEAM_WORDS.whatTheyMayDo}
            value={roleFor?.role ?? 'agent'}
            options={STAFF_ROLE_CHOICES.map((r) => ({
              value: r.value,
              label: r.label,
              detail: r.help,
            }))}
            onPick={(role) => {
              if (!roleFor) return;
              const p = roleFor;
              void run(
                p.userId,
                () => desk('/v1/commands/support.staff.set_role', { userId: p.userId, role }),
                TEAM_PHONE_WORDS.roleChanged,
              );
            }}
            testID="pick-role"
          />
          <ConfirmSheet
            open={askOpen}
            asking={asking}
            onClose={() => setAskOpen(false)}
            onConfirm={(a) => {
              setAskOpen(false);
              if (a.kind === 'suspend') void setStatus(a.person, 'suspended');
              else
                void run(
                  a.person.userId,
                  () =>
                    desk('/v1/commands/support.staff.remove', {
                      userId: a.person.userId,
                    }),
                  TEAM_PHONE_WORDS.removed,
                );
            }}
          />
          <InviteSheet open={inviting} onClose={() => setInviting(false)} onSent={list.reload} />
        </>
      ) : null}
    </Screen>
  );
}

function PersonRow({
  person: s,
  me,
  first,
  manage,
  busy,
  onRole,
  onSuspend,
  onLetBackIn,
  onRemove,
}: {
  person: Person;
  me: boolean;
  first: boolean;
  manage: boolean;
  busy: boolean;
  onRole: () => void;
  onSuspend: () => void;
  onLetBackIn: () => void;
  onRemove: () => void;
}) {
  const name = supportPersonName(s);
  return (
    <View
      className={cn('gap-2.5 px-4 py-3.5', !first && 'border-t border-border')}
      testID={`staff-row-${s.userId}`}
    >
      <View className="flex-row items-center gap-3">
        <Avatar name={name} seed={s.userId} />
        <View className="min-w-0 flex-1 gap-px">
          <Text className="text-[15px] font-semibold" numberOfLines={1}>
            {name}
            {me ? (
              <Text className="font-normal text-text-3">{SUPPORT_TEAM_WORDS.youTag}</Text>
            ) : null}
          </Text>
          <Text className="text-[13px] text-text-3" numberOfLines={1}>
            {supportPersonLine(s)}
          </Text>
        </View>
        {manage ? null : (
          <Text className="text-[13px] text-text-3" testID={`staff-role-word-${s.userId}`}>
            {STAFF_ROLE_WORDS[s.role]}
          </Text>
        )}
      </View>
      {manage ? (
        <View className="flex-row flex-wrap items-center gap-2 pl-11">
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onPress={onRole}
            accessibilityLabel={SUPPORT_TEAM_WORDS.roleFor(s.email)}
            testID={`staff-role-${s.userId}`}
          >
            <Text>{STAFF_ROLE_WORDS[s.role]}</Text>
            <Icon as={ChevronDown} className="size-4 text-text-3" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onPress={s.status === 'active' ? onSuspend : onLetBackIn}
            testID={`staff-suspend-${s.userId}`}
          >
            {s.status === 'active' ? SUPPORT_TEAM_WORDS.suspend : SUPPORT_TEAM_WORDS.letBackIn}
          </Button>
          <Button
            variant="ghostDanger"
            size="sm"
            disabled={busy}
            onPress={onRemove}
            testID={`staff-remove-${s.userId}`}
          >
            {SUPPORT_TEAM_WORDS.remove}
          </Button>
        </View>
      ) : null}
    </View>
  );
}

function InvitationRow({
  invitation: inv,
  first,
  manage,
  busy,
  onResend,
  onRevoke,
}: {
  invitation: Invitation;
  first: boolean;
  manage: boolean;
  busy: boolean;
  onResend: () => void;
  onRevoke: () => void;
}) {
  return (
    <View
      className={cn('gap-2', !first && 'border-t border-border pt-3')}
      testID={`staff-invitation-${inv.id}`}
    >
      <View className="gap-px">
        <Text className="text-[15px]" numberOfLines={1}>
          {inv.email}
        </Text>
        <Text className="text-[13px] leading-[18px] text-text-3">{supportInvitationLine(inv)}</Text>
      </View>
      {manage ? (
        <View className="flex-row gap-2">
          <Button
            variant="secondary"
            size="sm"
            loading={busy}
            onPress={onResend}
            testID={`invitation-resend-${inv.id}`}
          >
            {SUPPORT_TEAM_WORDS.sendAgain}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onPress={onRevoke}
            testID={`invitation-revoke-${inv.id}`}
          >
            {SUPPORT_TEAM_WORDS.cancel}
          </Button>
        </View>
      ) : null}
    </View>
  );
}

/** Suspending or removing somebody, asked first: both take the support desk away from them. */
function ConfirmSheet({
  open,
  asking,
  onClose,
  onConfirm,
}: {
  open: boolean;
  asking: Asking | null;
  onClose: () => void;
  onConfirm: (asking: Asking) => void;
}) {
  const name = asking ? supportPersonName(asking.person) : '';
  const suspend = asking?.kind === 'suspend';
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={suspend ? TEAM_PHONE_WORDS.suspendTitle(name) : TEAM_PHONE_WORDS.removeTitle(name)}
      description={suspend ? TEAM_PHONE_WORDS.suspendAsk : TEAM_PHONE_WORDS.removeAsk}
      testID={suspend ? 'staff-suspend-sheet' : 'staff-remove-sheet'}
    >
      <View className="mt-4 gap-2">
        <Button
          variant="danger"
          onPress={() => (asking ? onConfirm(asking) : undefined)}
          testID={suspend ? 'staff-suspend-confirm' : 'staff-remove-confirm'}
        >
          {suspend ? TEAM_PHONE_WORDS.suspendConfirm : TEAM_PHONE_WORDS.removeConfirm}
        </Button>
        <Button variant="ghost" onPress={onClose} testID="staff-confirm-keep">
          {TEAM_PHONE_WORDS.keep}
        </Button>
      </View>
    </Sheet>
  );
}

/**
 * What customers see on this person's replies: their name and sign-off. Saving asks HandsFreeOS again who they are,
 * so the desk's front page shows the new name too.
 */
function MyProfile({
  userId,
  displayName,
  signature,
  onSaved,
}: {
  userId: string;
  displayName: string;
  signature: string;
  onSaved: () => void;
}) {
  const [name, setName] = React.useState(displayName);
  const [sign, setSign] = React.useState(signature);
  const [saved, setSaved] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await desk('/v1/commands/support.staff.save_profile', {
        displayName: name.trim(),
        signature: sign,
      });
      setSaved(true);
      void loadStaff(userId).catch(() => undefined);
      onSaved();
    } catch (e) {
      setProblem(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title={SUPPORT_TEAM_WORDS.signOffTitle}
      detail={SUPPORT_TEAM_WORDS.signOffDetail}
      testID="staff-profile"
    >
      <View className="gap-1.5">
        <Label nativeID="staff-name-label">{SUPPORT_TEAM_WORDS.nameLabel}</Label>
        <Input
          value={name}
          onChangeText={(v) => {
            setName(v);
            setSaved(false);
          }}
          placeholder={SUPPORT_TEAM_WORDS.namePlaceholder}
          maxLength={120}
          aria-labelledby="staff-name-label"
          testID="staff-name"
        />
      </View>
      <View className="gap-1.5">
        <Label nativeID="staff-signature-label">{SUPPORT_TEAM_WORDS.signatureLabel}</Label>
        <Input
          value={sign}
          onChangeText={(v) => {
            setSign(v);
            setSaved(false);
          }}
          placeholder={SUPPORT_TEAM_WORDS.signaturePlaceholder}
          maxLength={2000}
          aria-labelledby="staff-signature-label"
          testID="staff-signature"
        />
      </View>
      {problem ? <FieldError>{problem}</FieldError> : null}
      <View className="flex-row items-center gap-3">
        <Button onPress={() => void save()} loading={busy} testID="staff-profile-save">
          {SUPPORT_TEAM_WORDS.save}
        </Button>
        {saved ? (
          <Text className="text-[13px] text-success-text" testID="staff-profile-saved">
            {SUPPORT_TEAM_WORDS.saved}
          </Text>
        ) : null}
      </View>
    </Section>
  );
}

/**
 * Inviting someone to answer support: their address and what they may do. They get a link that works once, only for
 * that address; the sheet says so once it has gone.
 */
function InviteSheet({
  open,
  onClose,
  onSent,
}: {
  open: boolean;
  onClose: () => void;
  onSent: () => void;
}) {
  const keyboard = useKeyboardHeight();
  const [email, setEmail] = React.useState('');
  const [role, setRole] = React.useState<StaffRole>('agent');
  const [problem, setProblem] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [sent, setSent] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!open) return;
    setEmail('');
    setRole('agent');
    setProblem(null);
    setSent(null);
  }, [open]);

  const send = async () => {
    if (!supportInviteEmailOk(email)) return setProblem(SUPPORT_TEAM_WORDS.badEmail);
    setBusy(true);
    setProblem(null);
    try {
      await desk('/v1/commands/support.staff.invite', { email: email.trim(), role });
      setSent(email.trim());
      setEmail('');
      onSent();
    } catch (e) {
      setProblem(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={SUPPORT_TEAM_WORDS.inviteTitle}
      description={SUPPORT_TEAM_WORDS.inviteDetail}
      scroll
      testID="staff-invite-sheet"
    >
      {sent ? (
        <View className="mt-4 gap-4" testID="staff-invite-sent">
          <Text className="text-[15px] leading-[22px]">
            {SUPPORT_TEAM_WORDS.sentTo} <Text className="font-semibold">{sent}</Text>.{' '}
            {SUPPORT_TEAM_WORDS.sevenDays}
          </Text>
          <Button onPress={onClose} testID="staff-invite-done">
            {SUPPORT_TEAM_WORDS.done}
          </Button>
        </View>
      ) : (
        <View style={keyboard ? { paddingBottom: keyboard } : undefined} className="mt-4 gap-3">
          <View className="gap-1.5">
            <Label nativeID="staff-email-label">{SUPPORT_TEAM_WORDS.emailLabel}</Label>
            <Input
              value={email}
              onChangeText={setEmail}
              placeholder={SUPPORT_TEAM_WORDS.emailPlaceholder}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="email"
              invalid={problem === SUPPORT_TEAM_WORDS.badEmail}
              aria-labelledby="staff-email-label"
              testID="staff-invite-email"
            />
          </View>
          <View className="gap-1.5">
            <Label>{SUPPORT_TEAM_WORDS.whatTheyMayDo}</Label>
            <View
              role="radiogroup"
              accessibilityLabel={SUPPORT_TEAM_WORDS.whatTheyMayDo}
              className="overflow-hidden rounded-card border border-border bg-card"
            >
              {STAFF_ROLE_CHOICES.map((r, i) => {
                const on = r.value === role;
                return (
                  <Pressable
                    key={r.value}
                    role="radio"
                    accessibilityState={{ checked: on }}
                    onPress={() => setRole(r.value)}
                    testID={`staff-invite-role-${r.value}`}
                    className={cn(
                      'min-h-12 flex-row items-center gap-3 px-4 active:bg-card-2',
                      i > 0 && 'border-t border-border',
                    )}
                  >
                    <View className="min-w-0 flex-1 gap-px py-2">
                      <Text className="text-[15px] font-medium">{r.label}</Text>
                      <Text className="text-[13px] leading-[18px] text-text-3">{r.help}</Text>
                    </View>
                    {on ? <Icon as={Check} className="size-5 text-accent" /> : null}
                  </Pressable>
                );
              })}
            </View>
          </View>
          {problem ? <FieldError>{problem}</FieldError> : null}
          <Button onPress={() => void send()} loading={busy} testID="staff-invite-send">
            {SUPPORT_TEAM_WORDS.sendInvitation}
          </Button>
          <Button variant="ghost" onPress={onClose}>
            {SUPPORT_TEAM_WORDS.cancel}
          </Button>
        </View>
      )}
    </Sheet>
  );
}
