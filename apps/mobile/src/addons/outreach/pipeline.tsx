import {
  marksFor,
  markedWords,
  STAGE_MARKS,
  STAGE_VIEW_KEYS,
  STAGE_VIEWS,
  STAGE_WORDS,
  STAGES,
  type StageMark,
  type StagesOutput,
  type StageView,
} from '@hfos/core/addons/outreach/stages';
import { chatUrlOn, openChatWords, openPageWords } from '@hfos/core/addons/outreach/network-words';
import type { Platform } from '@hfos/core/addons/outreach/networks';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import * as React from 'react';
import { ScrollView, View } from 'react-native';

import { change, ChangeError } from '@/changes';
import { ExternalLink } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { api, errorMessage, unwrap } from '@/lib/api';

import { OutreachFrame } from './frame';
import { NeedsSignal, Note, openOutside, useOutreachAnswer, useOutreachContext } from './kit';
import { NetworkFilter, NetworkName } from './networks';
import { PersonMenuScope, PersonName } from './person-menu';

/**
 * The pipeline on the phone (decision 47), as the web's Pipeline tab: everyone the person reached on Facebook by where
 * they stand, everyone still in play first or one stage at a time, searched by name, Show more for the next page. Each
 * opens in Messenger or on Facebook, and has the marks the web has: ready to pitch, pitched, not a fit, back in play
 * (`outreach.stage.mark`); their name opens the person menu (./person-menu.tsx). Every network's people, each naming
 * its network, or one network's. A client in Contacts (decision 91) shows as **Client**, with no moves. It needs
 * signal.
 */

export const stageViewOf = (show: string | undefined): StageView =>
  STAGE_VIEW_KEYS.find((k) => k === show) ?? 'all';

export function PipelineScreen({ show, q }: { show?: string; q?: string }) {
  const ctx = useOutreachContext();
  const ws = ctx.workspaceId;
  const [view, setView] = React.useState<StageView>(stageViewOf(show));
  const [search, setSearch] = React.useState(q ?? '');
  const [asked, setAsked] = React.useState(q ?? '');
  const [pages, setPages] = React.useState(1);
  const [net, setNet] = React.useState<Platform | null>(null);
  React.useEffect(() => {
    const t = setTimeout(() => setAsked(search.trim()), 400);
    return () => clearTimeout(t);
  }, [search]);
  React.useEffect(() => setPages(1), [view, asked, net]);
  const answer = useOutreachAnswer(
    async () => {
      const all: StagesOutput[] = [];
      for (let page = 1; page <= pages; page++)
        all.push(
          unwrap(
            await api.POST('/v1/queries/outreach.stages', {
              body: {
                workspaceId: ws,
                view,
                page,
                ...(asked ? { search: asked } : {}),
                ...(net ? { platform: net } : {}),
              },
            }),
          ),
        );
      const last = all[all.length - 1]!;
      return { ...last, people: all.flatMap((a) => a.people) };
    },
    `pipeline:${ws}:${view}:${asked}:${pages}:${net ?? 'all'}`,
    W.rows.pipeline,
  );
  const [busy, setBusy] = React.useState<string | null>(null);
  const mark = async (profileId: string, name: string, m: StageMark) => {
    setBusy(`${profileId}:${m}`);
    try {
      await change('outreach.stage.mark', { workspaceId: ws, profileId, mark: m });
      toast.show(markedWords(name, m));
      answer.reload();
    } catch (e) {
      toast.error(e instanceof ChangeError ? e.message : errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <PersonMenuScope
      workspaceId={ws}
      online={ctx.online}
      writesContacts={ctx.writesContacts}
      onChanged={answer.reload}
    >
      <PipelineBody
        view={view}
        onView={setView}
        net={net}
        onNet={setNet}
        search={search}
        onSearch={setSearch}
        pipeline={answer.data}
        error={answer.error}
        onRetry={answer.reload}
        onMore={() => setPages((p) => p + 1)}
        busy={busy}
        onMark={(p, m) => void mark(p.profileId, p.name, m)}
      />
    </PersonMenuScope>
  );
}

type Person = StagesOutput['people'][number];

/** A stage's badge where it isn't the accent's: a client in Contacts is good news, Not a fit is grey. */
const STAGE_BADGE: Partial<Record<Person['stage'], 'ok' | 'gray'>> = { client: 'ok', lost: 'gray' };

export function PipelineBody({
  view,
  onView,
  net = null,
  onNet,
  search,
  onSearch,
  pipeline,
  error,
  onRetry,
  onMore,
  busy = null,
  onMark,
}: {
  view: StageView;
  onView: (v: StageView) => void;
  /** The network it's narrowed to: null for every network. */
  net?: Platform | null;
  onNet?: (net: Platform | null) => void;
  search: string;
  onSearch: (s: string) => void;
  pipeline: StagesOutput | null;
  error: string | null;
  onRetry: () => void;
  onMore: () => void;
  busy?: string | null;
  onMark: (p: Person, m: StageMark) => void;
}) {
  return (
    <OutreachFrame page="people" people="pipeline" testID="outreach-pipeline">
      <Note>
        {view === 'lost'
          ? STAGE_WORDS.lostNote
          : view === 'client'
            ? STAGE_WORDS.clientNote
            : STAGE_WORDS.about}
      </Note>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View className="flex-row gap-1.5">
          {STAGE_VIEW_KEYS.map((k) => (
            <Button
              key={k}
              size="sm"
              variant={view === k ? 'secondary' : 'ghost'}
              onPress={() => onView(k)}
              testID={`pipeline-show-${k}`}
            >
              {pipeline ? `${STAGE_VIEWS[k]} ${pipeline.counts[k]}` : STAGE_VIEWS[k]}
            </Button>
          ))}
        </View>
      </ScrollView>
      {onNet ? <NetworkFilter value={net} onChange={onNet} /> : null}
      <Input
        value={search}
        onChangeText={onSearch}
        placeholder={W.search}
        autoCorrect={false}
        testID="pipeline-search"
      />
      {pipeline ? (
        pipeline.people.length ? (
          <>
            {pipeline.people.map((p) => (
              <Card key={p.profileId} className="gap-1.5 px-4 py-3.5" testID="pipeline-person">
                <View className="flex-row flex-wrap items-center gap-2">
                  <PersonName
                    who={{
                      profileId: p.profileId,
                      name: p.name,
                      url: p.url,
                      platform: p.platform,
                      threadKey: p.threadKey,
                      personId: p.personId,
                      demoBooked: p.demoBooked,
                    }}
                  />
                  <NetworkName platform={p.platform} />
                  <Badge variant={STAGE_BADGE[p.stage] ?? 'accent'} testID="pipeline-stage">
                    <Text>{STAGES[p.stage]}</Text>
                  </Badge>
                </View>
                {p.why.length ? <Note>{p.why.join(' · ')}</Note> : null}
                {p.nextStep ? <Note>{`${W.nextStepLabel}: ${p.nextStep}`}</Note> : null}
                <View className="flex-row flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={ExternalLink}
                    onPress={() => openOutside(chatUrlOn(p.platform, p.threadKey) ?? p.url)}
                  >
                    {p.threadKey ? openChatWords(p.platform) : openPageWords(p.platform)}
                  </Button>
                  {marksFor(p.stage).map((m) => (
                    <Button
                      key={m}
                      size="sm"
                      variant="ghost"
                      disabled={busy !== null}
                      onPress={() => onMark(p, m)}
                      testID={`pipeline-mark-${m}`}
                    >
                      {STAGE_MARKS[m]}
                    </Button>
                  ))}
                </View>
              </Card>
            ))}
            {pipeline.page < pipeline.pages ? (
              <Button variant="secondary" onPress={onMore} testID="pipeline-more">
                {W.more}
              </Button>
            ) : null}
          </>
        ) : (
          <Card className="gap-1.5 px-5 py-6" testID="pipeline-empty">
            <Text className="text-[16px] font-semibold">
              {search.trim() ? W.chatsNoMatch.title : STAGE_WORDS.empty.title}
            </Text>
            <Note>{search.trim() ? W.chatsNoMatch.body : STAGE_WORDS.empty.body}</Note>
          </Card>
        )
      ) : error ? (
        <NeedsSignal words={error} onRetry={onRetry} testID="pipeline-needs-signal" />
      ) : null}
    </OutreachFrame>
  );
}
