import {
  DOCUMENT_SCREEN_WORDS as W,
  DOCUMENT_STATUS_LABELS,
  documentBadge,
  documentStepText,
  formatDate,
  PHONE_HAND_BACK,
  sendAgainQuery,
  SIGNER_STATUS_TONES,
  signerIsUp,
  signerStatusLabel,
  type DocumentStatus,
} from '@hfos/core';
import { File, Paths } from 'expo-file-system';
import { router, type Href } from 'expo-router';
import * as Sharing from 'expo-sharing';
import * as WebBrowser from 'expo-web-browser';
import * as React from 'react';
import { Pressable, ScrollView, Share, View } from 'react-native';

import {
  Ban,
  BellRing,
  ExternalLink,
  FilePenLine,
  RotateCcw,
  Send,
  Share as ShareIcon,
  Signature,
} from '@/components/icons';
import { businessHref, useBusiness } from '@/components/shell/business-context';
import { List, ListLabel, ListRow } from '@/components/shell/list';
import { Screen } from '@/components/shell/screen';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { FilterChip } from '@/components/ui/filter-chip';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { signedUrl } from '@/inbox/storage';
import { errorMessage } from '@/lib/api';
import { lockIfEnabled } from '@/lib/app-start';
import { useLiveAnswer } from '@/lib/live-answer';
import { openWeb } from '@/lib/open-web';

import {
  documentCalls,
  useSendsDocuments,
  type DocumentGetOut,
  type DocumentRow,
  type DocumentSignerRow,
} from './calls';

/**
 * Documents on the phone (docs/documents.md, part 3), in the web's words: what's been sent and where each one is, and
 * one document, where the team reminds, voids with a reason, sends a signer their link, hands the phone to a signer
 * who's with them (Sign now, answer 13a), sends a corrected one again (answer 15a) and opens or shares the signed
 * copy. It all needs signal; nothing of it is kept on the phone.
 */

const documentHref = (workspaceId: string, documentId: string) =>
  businessHref(workspaceId, `documents/${documentId}`) as Href;

/** Where a document's "About" goes on the phone: the customer, company or lead; a record of the business's own kinds opens the web. */
function aboutPath(about: NonNullable<DocumentRow['about']>): string | null {
  switch (about.kind) {
    case 'person':
      return `customers/people/${about.id}`;
    case 'company':
      return `customers/companies/${about.id}`;
    case 'lead':
      return `leads/${about.id}`;
    default:
      return null;
  }
}

function Missing({ words, testID }: { words: string | null; testID: string }) {
  return words ? (
    <Text className="py-10 text-center text-[13px] text-text-3" testID={testID}>
      {words}
    </Text>
  ) : null;
}

/** Who signs and how far each has got, in a line: "Dana Smith: signed, Sam Lee: their turn". */
export function signersLine(row: Pick<DocumentRow, 'signers'>): string {
  const signers = row.signers.filter((s) => s.kind === 'signer');
  return signers.map((s) => `${s.name}: ${signerStatusLabel(s, signers).toLowerCase()}`).join(', ');
}

/** One sent document in a list: its name, who it's about and who signs, and where it is. */
export function DocumentListRow({
  workspaceId,
  row,
  about = true,
}: {
  workspaceId: string;
  row: DocumentRow;
  about?: boolean;
}) {
  const badge = documentBadge(row.status, row.finishing);
  return (
    <ListRow
      icon={FilePenLine}
      label={row.name}
      detail={[about ? row.about?.name : null, signersLine(row), formatDate(row.sentAt)]
        .filter(Boolean)
        .join(' · ')}
      end={<Badge variant={badge.tone}>{badge.label}</Badge>}
      onPress={() => router.push(documentHref(workspaceId, row.id))}
      testID="document-row"
    />
  );
}

type Filter = 'all' | DocumentStatus;
const FILTERS: readonly Filter[] = ['all', 'out', 'completed', 'declined', 'voided', 'expired'];

export function DocumentsScreen() {
  const { business } = useBusiness();
  const canSend = useSendsDocuments();
  const calls = React.useMemo(() => documentCalls(business.id), [business.id]);
  const [filter, setFilter] = React.useState<Filter>('all');
  const key = `${business.id}:${filter}`;
  const load = React.useCallback(async () => {
    const [list, templates] = await Promise.all([
      calls.list(filter === 'all' ? {} : { status: filter }),
      calls.templates(),
    ]);
    return { list, templates };
  }, [calls, filter]);
  const answer = useLiveAnswer(load, key, W.phone.needsSignal);
  // Older ones shown on this filter, after the first page.
  const [older, setOlder] = React.useState<{
    key: string;
    rows: DocumentRow[];
    more: boolean;
  } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const data = answer.data;
  const first = data?.list.documents ?? [];
  const extra =
    older?.key === key ? older.rows.filter((r) => !first.some((f) => f.id === r.id)) : [];
  const rows = [...first, ...extra];
  const more = older?.key === key ? older.more : (data?.list.more ?? false);

  async function showOlder() {
    const last = rows[rows.length - 1];
    if (!last) return;
    setBusy(true);
    try {
      const got = await calls.list({
        ...(filter === 'all' ? {} : { status: filter }),
        before: last.sentAt,
      });
      setOlder({ key, rows: [...extra, ...got.documents], more: got.more });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const templates = data?.templates ?? [];
  return (
    <Screen title={W.title} leading="back" testID="documents" contentClassName="gap-3">
      {canSend && data ? (
        templates.length ? (
          <Button
            icon={Send}
            onPress={() => router.push(businessHref(business.id, 'documents/send') as Href)}
            testID="documents-send"
          >
            {W.send}
          </Button>
        ) : (
          <Text className="px-1 text-[13px] text-text-2" testID="documents-no-template">
            {W.noTemplateReady}
          </Text>
        )
      ) : null}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerClassName="gap-1.5 px-0.5"
        testID="documents-filter"
      >
        {FILTERS.map((f) => (
          <FilterChip
            key={f}
            label={f === 'all' ? W.allStates : DOCUMENT_STATUS_LABELS[f]}
            on={filter === f}
            onPress={() => setFilter(f)}
            testID={`documents-filter-${f}`}
          />
        ))}
      </ScrollView>
      {data ? (
        rows.length ? (
          <>
            <List testID="documents-sent">
              {rows.map((r) => (
                <DocumentListRow key={r.id} workspaceId={business.id} row={r} />
              ))}
            </List>
            {more ? (
              <Button
                variant="secondary"
                size="md"
                loading={busy}
                onPress={() => void showOlder()}
                testID="documents-older"
              >
                {W.older}
              </Button>
            ) : null}
          </>
        ) : (
          <View className="gap-1 px-1 py-6" testID="documents-empty">
            <Text className="text-[15px] font-medium">
              {filter === 'all' ? W.nothingSent : W.noneHere}
            </Text>
            <Text className="text-[13px] text-text-2">
              {filter === 'all' ? W.nothingSentBody : W.noneHereBody}
            </Text>
          </View>
        )
      ) : (
        <Missing words={answer.loading ? null : answer.error} testID="documents-missing" />
      )}
      <ListLabel>{W.templates}</ListLabel>
      <List>
        <ListRow
          icon={FilePenLine}
          label={W.templates}
          detail={W.phone.templatesOnWeb}
          external
          onPress={() => void openWeb(`/app/w/${business.id}/documents?tab=templates`)}
          testID="documents-templates-web"
        />
      </List>
    </Screen>
  );
}

export function DocumentScreen({ documentId }: { documentId: string }) {
  const { business } = useBusiness();
  const calls = React.useMemo(() => documentCalls(business.id), [business.id]);
  const load = React.useCallback(() => calls.get(documentId), [calls, documentId]);
  const answer = useLiveAnswer(load, `${business.id}:${documentId}`, W.phone.needsSignal);
  return (
    <Screen
      title={answer.data?.name ?? W.title}
      leading="back"
      back={businessHref(business.id, 'documents') as Href}
      testID="document"
      contentClassName="gap-3"
    >
      {answer.data ? (
        <DocumentBody workspaceId={business.id} doc={answer.data} onChanged={answer.reload} />
      ) : (
        <Missing words={answer.loading ? null : answer.error} testID="document-missing" />
      )}
    </Screen>
  );
}

export function DocumentBody({
  workspaceId,
  doc,
  onChanged,
}: {
  workspaceId: string;
  doc: DocumentGetOut;
  onChanged: () => void;
}) {
  const calls = React.useMemo(() => documentCalls(workspaceId), [workspaceId]);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [voiding, setVoiding] = React.useState(false);
  const [reason, setReason] = React.useState('');
  const [handing, setHanding] = React.useState<DocumentSignerRow | null>(null);
  const badge = documentBadge(doc.status, doc.finishing);
  const names = new Map(doc.signers.map((s) => [s.id, s.name]));
  const signers = doc.signers.filter((s) => s.kind === 'signer');
  const out = doc.status === 'out' && doc.canSend && !doc.finishing;
  const againQuery = doc.canSend ? sendAgainQuery(doc) : null;
  const aboutAt = doc.about ? aboutPath(doc.about) : null;

  async function act(what: string, run: () => Promise<unknown>, done: string) {
    setBusy(what);
    try {
      await run();
      toast.show(done);
      onChanged();
      return true;
    } catch (e) {
      toast.error(errorMessage(e));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function shareLink(signer: DocumentSignerRow) {
    setBusy(signer.id);
    try {
      const url = await calls.link(signer.id);
      await Share.share({ message: url, url, title: W.shareLink });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  /**
   * Sign now (answer 13a): noted as handed over by this person, then their signing page opens in the phone's own
   * browser, saying whose turn it is first. Its way back (`PHONE_HAND_BACK`) closes it, and the app locks again, so
   * the customer holding the phone never lands in the business's app.
   */
  async function signNow(signer: DocumentSignerRow) {
    setHanding(null);
    setBusy(`now:${signer.id}`);
    let opened = false;
    try {
      await calls.signNow(signer.id);
      const url = await calls.link(signer.id);
      const first = signer.name.split(' ')[0] || signer.name;
      const hand = `with=${encodeURIComponent(first)}&back=${encodeURIComponent(PHONE_HAND_BACK)}`;
      opened = true;
      await WebBrowser.openAuthSessionAsync(`${url}#${hand}`, PHONE_HAND_BACK, {
        preferEphemeralSession: true,
      });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      if (opened) await lockIfEnabled();
      setBusy(null);
      onChanged();
    }
  }

  async function signedLink(): Promise<string | null> {
    if (!doc.signed) return null;
    const url = await signedUrl(doc.signed.bucket, doc.signed.objectPath);
    if (!url) toast.error(W.phone.needsSignal);
    return url;
  }

  async function openSigned() {
    const url = await signedLink();
    if (url) await WebBrowser.openBrowserAsync(url);
  }

  /** The signed PDF into the phone's cache and on to its share sheet: Save to Files, Mail, Messages. */
  async function shareSigned() {
    if (!doc.signed) return;
    setBusy('share');
    try {
      if (!(await Sharing.isAvailableAsync())) throw new Error(W.phone.fileShareFailed);
      const url = await signedLink();
      if (!url) return;
      const base = doc.signed.name.replace(/[^\w.-]+/g, '-').replace(/^[-.]+/, '') || 'signed';
      const name = /\.pdf$/i.test(base) ? base : `${base}.pdf`;
      const file = await File.downloadFileAsync(url, new File(Paths.cache, name), {
        idempotent: true,
      });
      await Sharing.shareAsync(file.uri, { mimeType: 'application/pdf', dialogTitle: doc.name });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const declined = doc.signers.find((s) => s.status === 'declined');
  const note =
    doc.status === 'voided'
      ? W.voidedNote(formatDate(doc.voidedAt, { time: true }), doc.voidReason)
      : doc.status === 'declined'
        ? W.declinedNote(
            declined?.name ?? null,
            formatDate(doc.declinedAt, { time: true }),
            declined?.declineReason ?? null,
          )
        : doc.status === 'expired'
          ? W.expiredNote(formatDate(doc.expiredAt, { time: true }))
          : doc.status === 'completed'
            ? W.completedNote
            : null;

  return (
    <>
      <Card className="gap-2 p-4" testID="document-head">
        <View className="flex-row flex-wrap items-center gap-2">
          <Badge variant={badge.tone} testID="document-status">
            {badge.label}
          </Badge>
        </View>
        {doc.about ? (
          <Pressable
            role={aboutAt ? 'link' : undefined}
            disabled={!aboutAt}
            onPress={() => aboutAt && router.push(businessHref(workspaceId, aboutAt) as Href)}
            testID="document-about"
          >
            <Text className="text-[13.5px] text-text-2">
              {`${W.about} `}
              <Text className="text-[13.5px] font-medium text-text">{doc.about.name}</Text>
            </Text>
          </Pressable>
        ) : null}
        <Text className="text-[12.5px] text-text-3">
          {[
            W.sentAt(formatDate(doc.sentAt, { time: true }), doc.sentBy?.fullName ?? null),
            doc.status === 'out' ? W.outOfTimeOn(formatDate(doc.expiresAt)) : null,
            doc.completedAt ? W.everyoneSigned(formatDate(doc.completedAt, { time: true })) : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </Text>
        {note ? (
          <Text
            className="rounded-menu bg-card-2 px-3 py-2 text-[13px] text-text-2"
            testID="document-note"
          >
            {note}
          </Text>
        ) : null}
        {out || doc.signed || againQuery ? (
          <View className="flex-row flex-wrap gap-2 pt-1">
            {out ? (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={BellRing}
                  loading={busy === 'remind'}
                  onPress={() => void act('remind', () => calls.remind(doc.id), W.reminded)}
                  testID="document-remind"
                >
                  {W.remind}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={Ban}
                  onPress={() => setVoiding(true)}
                  testID="document-void-open"
                >
                  {W.void}
                </Button>
              </>
            ) : null}
            {doc.signed ? (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={ExternalLink}
                  onPress={() => void openSigned()}
                  testID="document-open-signed"
                >
                  {W.openSigned}
                </Button>
                <Button
                  size="sm"
                  icon={ShareIcon}
                  loading={busy === 'share'}
                  onPress={() => void shareSigned()}
                  testID="document-share-signed"
                >
                  {W.phone.share}
                </Button>
              </>
            ) : null}
            {againQuery ? (
              <Button
                size="sm"
                icon={RotateCcw}
                onPress={() =>
                  router.push(businessHref(workspaceId, `documents/send?${againQuery}`) as Href)
                }
                testID="document-send-again"
              >
                {W.sendAgain}
              </Button>
            ) : null}
          </View>
        ) : null}
      </Card>

      <ListLabel>{W.whoSigns}</ListLabel>
      <Card className="gap-0 px-4 py-1">
        {doc.signers.map((s, i) => (
          <View
            key={s.id}
            className={i ? 'gap-1 border-t border-border py-3' : 'gap-1 py-3'}
            testID="document-signer"
          >
            <View className="flex-row items-center gap-2">
              <Text className="min-w-0 flex-1 text-[14px] font-medium" numberOfLines={1}>
                {s.name}
              </Text>
              <Badge variant={s.kind === 'copy' ? 'gray' : SIGNER_STATUS_TONES[s.status]}>
                {s.kind === 'copy' ? W.getsCopy : signerStatusLabel(s, signers)}
              </Badge>
            </View>
            <Text className="text-[12px] text-text-3">
              {[s.roleLabel, s.email, s.phone].filter(Boolean).join(' · ')}
            </Text>
            {s.signedAt ? (
              <Text className="text-[12px] text-text-2">
                {W.signedAt(formatDate(s.signedAt, { time: true }))}
              </Text>
            ) : s.openedAt ? (
              <Text className="text-[12px] text-text-2">
                {W.openedAt(formatDate(s.openedAt, { time: true }))}
              </Text>
            ) : s.lastSentAt ? (
              <Text className="text-[12px] text-text-2">
                {W.linkSentAt(formatDate(s.lastSentAt, { time: true }), s.reminders)}
              </Text>
            ) : null}
            {doc.canSend && (doc.status === 'out' || doc.status === 'completed') ? (
              <View className="flex-row flex-wrap gap-1.5 pt-1">
                {out && signerIsUp(s, doc.signers) ? (
                  <Button
                    variant={s.inPerson ? 'primary' : 'secondary'}
                    size="sm"
                    icon={Signature}
                    loading={busy === `now:${s.id}`}
                    onPress={() => setHanding(s)}
                    testID="document-sign-now"
                  >
                    {W.signNow}
                  </Button>
                ) : null}
                <Button
                  variant="ghost"
                  size="sm"
                  icon={Send}
                  loading={busy === s.id}
                  onPress={() => void shareLink(s)}
                  testID="document-share-link"
                >
                  {W.shareLink}
                </Button>
              </View>
            ) : null}
          </View>
        ))}
      </Card>

      <List>
        <ListRow
          icon={FilePenLine}
          label={W.phone.pagesOnWeb}
          external
          onPress={() => void openWeb(`/app/w/${workspaceId}/documents/${doc.id}`)}
          testID="document-pages-web"
        />
      </List>

      <ListLabel>{W.whatHappened}</ListLabel>
      <Card className="gap-2.5 p-4" testID="document-steps">
        {[...doc.steps].reverse().map((st) => (
          <View key={st.id} className="gap-0.5">
            <Text className="text-[13px]">
              {documentStepText({
                kind: st.kind,
                channel: st.channel,
                detail: st.detail as Record<string, unknown> | null,
              })}
              {st.signerId && names.get(st.signerId) ? `: ${names.get(st.signerId)}` : ''}
            </Text>
            <Text className="text-[12px] text-text-3">
              {formatDate(st.at, { time: true })}
              {st.ip ? ` · ${st.ip}` : ''}
            </Text>
          </View>
        ))}
      </Card>

      <Sheet
        open={voiding}
        onClose={() => busy !== 'void' && setVoiding(false)}
        title={W.voidTitle(doc.name)}
        description={W.voidBody}
        testID="document-void-sheet"
      >
        <View className="gap-3">
          <View className="gap-1.5">
            <Label>{W.voidReason}</Label>
            <Input
              value={reason}
              onChangeText={setReason}
              placeholder={W.voidReasonExample}
              maxLength={500}
              multiline
              className="h-24 py-3"
              testID="document-void-reason"
            />
          </View>
          <Button
            variant="danger"
            loading={busy === 'void'}
            onPress={() =>
              void act('void', () => calls.void(doc.id, reason.trim()), W.voided).then(
                (ok) => ok && setVoiding(false),
              )
            }
            testID="document-void"
          >
            {W.voidIt}
          </Button>
          <Button variant="ghost" onPress={() => setVoiding(false)}>
            {W.keepOut}
          </Button>
        </View>
      </Sheet>

      <Sheet
        open={!!handing}
        onClose={() => setHanding(null)}
        title={handing ? W.phone.signNowTitle(handing.name) : undefined}
        description={W.phone.signNowBody}
        testID="document-sign-now-sheet"
      >
        <View className="gap-3">
          <Text className="text-[13px] text-text-2">{W.phone.signNowLocks}</Text>
          <Button
            icon={Signature}
            onPress={() => handing && void signNow(handing)}
            testID="document-sign-now-go"
          >
            {W.phone.signNowGo}
          </Button>
        </View>
      </Sheet>
    </>
  );
}
