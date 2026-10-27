import {
  PARTNER_FITS,
  PARTNER_KINDS,
  PARTNER_MARKS,
  PARTNER_STAGE_KEYS,
  PARTNER_VIEW_KEYS,
  PARTNER_VIEWS,
  PARTNER_WORDS as P,
  partnerMarksFor,
  type PartnerMark,
  type PartnersOutput,
  type PartnerView,
} from '@hfos/core/addons/outreach/partners';
import { openPageWords } from '@hfos/core/addons/outreach/network-words';
import type { Platform } from '@hfos/core/addons/outreach/networks';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import * as React from 'react';
import { ScrollView, View } from 'react-native';

import { change, ChangeError } from '@/changes';
import { ExternalLink } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { api, errorMessage, unwrap } from '@/lib/api';

import { OutreachFrame } from './frame';
import { NeedsSignal, Note, openOutside, useOutreachAnswer, useOutreachContext } from './kit';
import { NetworkFilter, NetworkName } from './networks';

/**
 * The Partners list on the phone's People tab (`?view=partners`, docs/outreach.md decision 81), as the web's: everyone
 * the AI found could send the business its customers, everyone or one stage at a time, with how many are at each, a
 * network or every one. Each row has their kind, network and audience, when they reached their stage, why they fit,
 * the AI's first warm-up while they're still to be asked, and the marks their stage offers (`partnerMarksFor`,
 * `outreach.partner.mark`). Show more brings the next page. It needs signal. The words are core's (`PARTNER_WORDS`).
 */

export const partnerViewOf = (show: string | undefined): PartnerView =>
  PARTNER_VIEW_KEYS.find((k) => k === show) ?? 'all';

type Partner = PartnersOutput['partners'][number];

export function PartnersScreen({
  show,
  net: first = null,
}: {
  show?: string;
  net?: Platform | null;
}) {
  const ctx = useOutreachContext();
  const ws = ctx.workspaceId;
  const [view, setView] = React.useState<PartnerView>(partnerViewOf(show));
  const [net, setNet] = React.useState<Platform | null>(first);
  const [pages, setPages] = React.useState(1);
  React.useEffect(() => setPages(1), [view, net]);
  const answer = useOutreachAnswer(
    async () => {
      const all: PartnersOutput[] = [];
      for (let page = 1; page <= pages; page++)
        all.push(
          unwrap(
            await api.POST('/v1/queries/outreach.partners', {
              body: { workspaceId: ws, view, page, ...(net ? { platform: net } : {}) },
            }),
          ),
        );
      const last = all[all.length - 1]!;
      return { ...last, partners: all.flatMap((a) => a.partners) };
    },
    `partners:${ws}:${view}:${pages}:${net ?? 'all'}`,
    W.rows.partners,
  );
  const [busy, setBusy] = React.useState<string | null>(null);
  const mark = async (p: Partner, m: PartnerMark) => {
    setBusy(`${p.partnerId}:${m}`);
    try {
      await change('outreach.partner.mark', { workspaceId: ws, partnerId: p.partnerId, mark: m });
      toast.show(P.marked(m, p.name));
      answer.reload();
    } catch (e) {
      toast.error(e instanceof ChangeError ? e.message : errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <PartnersBody
      view={view}
      onView={setView}
      net={net}
      onNet={setNet}
      list={answer.data}
      error={answer.error}
      onRetry={answer.reload}
      onMore={() => setPages((p) => p + 1)}
      online={ctx.online}
      makesPartners={ctx.makesPartners}
      busy={busy}
      onMark={(p, m) => void mark(p, m)}
    />
  );
}

export function PartnersBody({
  view,
  onView,
  net = null,
  onNet,
  list,
  error,
  onRetry,
  onMore,
  online = true,
  makesPartners = true,
  busy = null,
  onMark,
}: {
  view: PartnerView;
  onView: (v: PartnerView) => void;
  /** The network it's narrowed to: null for every network. */
  net?: Platform | null;
  onNet?: (net: Platform | null) => void;
  list: PartnersOutput | null;
  error: string | null;
  onRetry: () => void;
  onMore: () => void;
  online?: boolean;
  /** Whether they hold Manage partners: Make partner shows only then. */
  makesPartners?: boolean;
  busy?: string | null;
  onMark: (p: Partner, m: PartnerMark) => void;
}) {
  const everyone = list ? PARTNER_STAGE_KEYS.reduce((n, s) => n + list.counts[s], 0) : 0;
  return (
    <OutreachFrame tab="people" people="partners" testID="outreach-partners">
      <Note>{P.about}</Note>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View className="flex-row gap-1.5">
          {PARTNER_VIEW_KEYS.map((k) => (
            <Button
              key={k}
              size="sm"
              variant={view === k ? 'secondary' : 'ghost'}
              onPress={() => onView(k)}
              testID={`partners-show-${k}`}
            >
              {list
                ? `${PARTNER_VIEWS[k]} ${(k === 'all' ? everyone : list.counts[k]).toLocaleString('en-US')}`
                : PARTNER_VIEWS[k]}
            </Button>
          ))}
        </View>
      </ScrollView>
      {onNet ? <NetworkFilter value={net} onChange={onNet} /> : null}
      {list ? (
        list.partners.length ? (
          <>
            {list.partners.map((p) => (
              <PartnerCard
                key={p.partnerId}
                partner={p}
                online={online}
                makesPartners={makesPartners}
                busy={busy}
                onMark={onMark}
              />
            ))}
            {list.more ? (
              <Button variant="secondary" onPress={onMore} testID="partners-more">
                {W.more}
              </Button>
            ) : null}
            {!online ? <Note>{P.needsSignal}</Note> : null}
          </>
        ) : (
          <Card className="gap-1.5 px-5 py-6" testID="partners-empty">
            <Text className="text-[16px] font-semibold">
              {view === 'all' ? P.emptyTitle : P.emptyStage(view)}
            </Text>
            {view === 'all' ? <Note>{P.empty}</Note> : null}
          </Card>
        )
      ) : error ? (
        <NeedsSignal words={error} onRetry={onRetry} testID="partners-needs-signal" />
      ) : null}
    </OutreachFrame>
  );
}

/** Someone on the list: who they are and their audience, why they fit, and the marks their stage offers. */
function PartnerCard({
  partner: p,
  online,
  makesPartners,
  busy,
  onMark,
}: {
  partner: Partner;
  online: boolean;
  makesPartners: boolean;
  busy: string | null;
  onMark: (p: Partner, m: PartnerMark) => void;
}) {
  const audience = P.audienceLine(p);
  return (
    <Card className="gap-1.5 px-4 py-3.5" testID="partner">
      <View className="flex-row flex-wrap items-center gap-2">
        <Text className="text-[15px] font-semibold">{p.name}</Text>
        <NetworkName platform={p.platform} />
        {p.fit === 'maybe' ? (
          <Badge variant="gray">
            <Text>{PARTNER_FITS.maybe}</Text>
          </Badge>
        ) : null}
      </View>
      <Note>{[PARTNER_KINDS[p.kind], audience].filter(Boolean).join(' · ')}</Note>
      <Text className="text-[13px] text-text-2" testID="partner-stage">
        {P.since(p.stage, p.stageAt)}
      </Text>
      {p.why.length ? (
        <Text className="text-[14px]" testID="partner-why">
          {p.why.join(' · ')}
        </Text>
      ) : null}
      {p.nextStep && (p.stage === 'found' || p.stage === 'warming') ? (
        <Note>{P.next(p.nextStep)}</Note>
      ) : null}
      <View className="flex-row flex-wrap gap-2">
        <Button size="sm" variant="ghost" icon={ExternalLink} onPress={() => openOutside(p.url)}>
          {openPageWords(p.platform)}
        </Button>
        {partnerMarksFor(p.stage, { makePartner: makesPartners }).map((m) => (
          <Button
            key={m}
            size="sm"
            variant="ghost"
            disabled={busy !== null || !online}
            onPress={() => onMark(p, m)}
            testID={`partner-mark-${m}`}
          >
            {PARTNER_MARKS[m]}
          </Button>
        ))}
      </View>
    </Card>
  );
}
