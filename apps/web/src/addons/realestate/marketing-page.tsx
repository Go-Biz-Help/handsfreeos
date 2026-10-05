'use client';
/**
 * A listing's marketing (boards 36 and 37, design/realestate/MlsLive.dc.html and Marketing.dc.html). Chris decided
 * (2026-10-01): nothing public goes before the listing is live on the MLS. Until the agent marks it live, the page,
 * the flyer, the email or text to contacts and copying the social posts all wait, and the page says why. Once it is:
 * the public page with its QR code, a campaign with exact words from the signed-off description, and the AI's social
 * posts to copy. HandsFreeOS posts nothing to anyone's social accounts itself.
 */
import { fmtMonthDay, localDayOf, money } from '@hfos/core';
import { listingEmailWords, listingTextWords } from '@hfos/core/addons/realestate/listing';
import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { people, skipWords } from '@/components/campaigns/words';
import { Callout } from '@/components/crm/chips';
import { TagPicker } from '@/components/crm/tag-picker';
import { uploadFile } from '@/components/files/upload-zone';
import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, unwrap } from '@/lib/api/client';
import type { CampaignPreview, PipelineList, Tag } from '@/lib/api/types';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { usePublicOrigin } from '@/lib/use-origin';
import { CardHead, dealHref } from './bits';
import { DealCrumb } from './buyer-bits';
import { Marked } from './listing-bits';
import type { DealDocument, ListingView, Marketing } from './types';
import { useAct } from './use-act';
import { useQueryState } from './use-query-state';

const thisYear = () => new Date().getFullYear();
type Post = Marketing['posts']['items'][number];

/** What the page still needs before it can go up, or what it'll show. */
function readyWords(m: Marketing): { ok: boolean; words: string } {
  const missing = [
    !m.ready.facts ? 'the home’s confirmed facts' : null,
    !m.ready.description ? 'a description the seller signed off' : null,
  ].filter((x): x is string => !!x);
  if (missing.length) return { ok: false, words: `It still needs ${missing.join(' and ')}.` };
  const photos = m.ready.photos;
  return {
    ok: true,
    words: `Ready: ${photos ? `${photos} ${photos === 1 ? 'photo' : 'photos'}` : 'no photos yet'}, the confirmed facts and the signed-off description.`,
  };
}

export function MarketingPage({
  workspaceId,
  dealId,
  dealName,
  timeZone,
  listing: l,
  marketing: m,
  mlsDocuments,
  tags,
  pipelines,
  brandedOrigin,
  live,
}: {
  workspaceId: string;
  dealId: string;
  dealName: string;
  timeZone: string;
  listing: ListingView;
  marketing: Marketing;
  /** The deal's MLS listing documents, to keep one as proof when it's marked live. */
  mlsDocuments: readonly DealDocument[];
  tags: Tag[];
  pipelines: PipelineList['pipelines'];
  /** The business's own domain when one is serving: the page's link and its QR code use it. */
  brandedOrigin: string | null;
  live: boolean;
}) {
  const router = useRouter();
  useLiveRefresh(['custom_record']);
  const [marking, setMarking] = useQueryState('live');
  const street = l.street ?? dealName;
  const onMls = m.mls;
  const origin = usePublicOrigin(brandedOrigin);
  const link = origin && m.page.path ? `${origin}${m.page.path}` : null;
  const ready = readyWords(m);

  // The AI drafts the posts and the model reads each a moment later; neither broadcasts, so look again until done.
  const postsBusy =
    m.posts.state === 'drafting' ||
    m.posts.items.some((p) => !(p.checked.words && p.checked.model));
  useEffect(() => {
    if (!postsBusy) return;
    const t = setInterval(() => router.refresh(), 2500);
    return () => clearInterval(t);
  }, [postsBusy, router]);

  return (
    <div data-testid="realestate-marketing">
      <DealCrumb workspaceId={workspaceId} dealId={dealId} dealName={dealName} here="Marketing" />
      <PageHeader
        title="Marketing"
        description={
          onMls
            ? `${street} · live on the MLS since ${fmtMonthDay(onMls.liveOn, thisYear())} · #${onMls.number}`
            : `${street}${l.listPriceCents !== null ? ` · ${money(l.listPriceCents)}` : ''}`
        }
        actions={
          onMls ? (
            <ButtonLink
              href={dealHref(workspaceId, dealId, 'flyer')}
              variant="secondary"
              data-testid="marketing-flyer"
            >
              Print the flyer
            </ButtonLink>
          ) : live ? (
            <Button onClick={() => setMarking('1')} data-testid="marketing-mark-live">
              Mark it live on the MLS
            </Button>
          ) : null
        }
      />
      {!onMls ? (
        <Callout tone="danger" className="mb-4" data-testid="marketing-hold">
          <div>
            <div className="font-semibold text-text">
              {street} isn’t live on the MLS yet, so it can’t be shared outside your office.
            </div>
            <div>
              The public page, the flyer, emails and texts to your contacts, copying the social
              posts, the open house sign-in and matching to buyers all wait until it is. Mark it
              live once it is.
            </div>
          </div>
        </Callout>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-2 lg:gap-5">
        <div className="min-w-0 space-y-4">
          {onMls ? (
            <>
              <PageCard
                workspaceId={workspaceId}
                dealId={dealId}
                timeZone={timeZone}
                listing={l}
                marketing={m}
                link={link}
                ready={ready}
                live={live}
              />
              <CampaignCard
                workspaceId={workspaceId}
                dealId={dealId}
                listing={l}
                marketing={m}
                link={link}
                tags={tags}
                pipelines={pipelines}
                live={live}
              />
            </>
          ) : (
            <>
              <HeldCard title="Public page" words={ready.words} button="Publish" />
              <HeldCard
                title="Flyer"
                words="Ready to print once it’s live, with a QR code to the page."
                button="Print"
              />
              <HeldCard
                title="Email or text to your contacts"
                words="Words from the signed-off description, to the tags or stages you pick."
                button="Start a campaign"
              />
            </>
          )}
        </div>
        <PostsCard
          workspaceId={workspaceId}
          dealId={dealId}
          marketing={m}
          factsReady={m.ready.facts}
          onMls={!!onMls}
          live={live}
        />
      </div>
      <MarkLiveDialog
        open={marking !== null && !onMls}
        onClose={() => setMarking(null)}
        workspaceId={workspaceId}
        dealId={dealId}
        timeZone={timeZone}
        documents={mlsDocuments}
      />
    </div>
  );
}

/** One of the things that waits for the MLS, with its button off. */
function HeldCard({ title, words, button }: { title: string; words: string; button: string }) {
  return (
    <Card className="p-4 md:p-5">
      <CardHead title={title} />
      <p className="text-[13.5px] text-text-2">{words}</p>
      <Button size="sm" variant="secondary" className="mt-3" disabled>
        {button}
      </Button>
    </Card>
  );
}

function PageCard({
  workspaceId,
  dealId,
  timeZone,
  listing: l,
  marketing: m,
  link,
  ready,
  live,
}: {
  workspaceId: string;
  dealId: string;
  timeZone: string;
  listing: ListingView;
  marketing: Marketing;
  link: string | null;
  ready: { ok: boolean; words: string };
  live: boolean;
}) {
  const { busy, act } = useAct();
  const [qr, setQr] = useState<string | null>(null);
  const published = m.page.state === 'published' && !!link;
  useEffect(() => {
    // Wait for the real origin: a QR code made from a relative path sends whoever scans it nowhere.
    if (!published || !link) return;
    let stale = false;
    void QRCode.toDataURL(link, { margin: 1, width: 512 })
      .then((d) => !stale && setQr(d))
      .catch(() => !stale && setQr(null));
    return () => {
      stale = true;
    };
  }, [published, link]);
  const at = l.page.publishedAt;
  const run = (name: 'page_publish' | 'page_take_down', done: string) =>
    act(
      name,
      async () =>
        unwrap(
          name === 'page_publish'
            ? await apiBrowser().POST('/v1/commands/realestate.listing.page_publish', {
                body: { workspaceId, dealId },
              })
            : await apiBrowser().POST('/v1/commands/realestate.listing.page_take_down', {
                body: { workspaceId, dealId },
              }),
        ),
      done,
    );
  return (
    <Card className="p-4 md:p-5" data-testid="marketing-page-card">
      <CardHead
        title="Public page"
        action={
          published ? (
            <Badge variant="ok">
              Published{at ? ` ${fmtMonthDay(localDayOf(at, timeZone), thisYear())}` : ''}
            </Badge>
          ) : m.page.state === 'down' ? (
            <Badge variant="gray">Taken down</Badge>
          ) : null
        }
      />
      {published ? (
        <div className="flex items-start gap-4">
          {qr ? (
            // A data: URL made in this browser: no loader, no request.
            <img
              src={qr}
              alt="QR code for the listing’s page"
              className="h-24 w-24 shrink-0 rounded-menu border border-border"
              data-testid="marketing-qr"
            />
          ) : (
            <div className="h-24 w-24 shrink-0 rounded-menu bg-card-2" />
          )}
          <div className="min-w-0">
            <a
              href={link!}
              target="_blank"
              rel="noreferrer"
              className="break-all text-[13.5px] text-accent-text hover:underline"
              data-testid="marketing-page-link"
            >
              {link!.replace(/^https?:\/\//, '')}
            </a>
            <p className="mt-1 text-[12.5px] text-text-2">
              Anyone who asks about the home on it comes to you as a lead.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(link!)
                    .then(() => toast.success('Copied the link.'))
                    .catch(() => toast.error('It couldn’t be copied. Select the link and copy it.'))
                }
              >
                Copy link
              </Button>
              {live ? (
                <Button
                  size="sm"
                  variant="ghost"
                  loading={busy === 'page_take_down'}
                  onClick={() =>
                    void run('page_take_down', 'It’s down. It goes back up at the same address.')
                  }
                  data-testid="marketing-take-down"
                >
                  Take it down
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      ) : (
        <>
          <p className="text-[13.5px] text-text-2">
            {m.page.state === 'down'
              ? 'It’s down. Put it back up and it’s at the same address.'
              : 'It shows the confirmed facts, the photos marked for the page, the signed-off description and the open houses.'}{' '}
            {ready.words}
          </p>
          {live ? (
            <Button
              size="sm"
              className="mt-3"
              disabled={!ready.ok}
              loading={busy === 'page_publish'}
              onClick={() => void run('page_publish', 'It’s up.')}
              data-testid="marketing-publish"
            >
              {m.page.state === 'down' ? 'Put it back up' : 'Publish'}
            </Button>
          ) : null}
        </>
      )}
    </Card>
  );
}

function CampaignCard({
  workspaceId,
  dealId,
  listing: l,
  marketing: m,
  link,
  tags,
  pipelines,
  live,
}: {
  workspaceId: string;
  dealId: string;
  listing: ListingView;
  marketing: Marketing;
  link: string | null;
  tags: Tag[];
  pipelines: PipelineList['pipelines'];
  live: boolean;
}) {
  const router = useRouter();
  const [channel, setChannel] = useState<'email' | 'sms'>('email');
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [stageIds, setStageIds] = useState<string[]>([]);
  const [preview, setPreview] = useState<CampaignPreview | null>(null);
  const { busy, act } = useAct();
  const picked = tagIds.length + stageIds.length > 0;
  const email = channel === 'email';

  // Who it would reach, as the picks change.
  useEffect(() => {
    if (!picked) {
      setPreview(null);
      return;
    }
    let stale = false;
    const t = setTimeout(async () => {
      try {
        const out = unwrap(
          await apiBrowser().POST('/v1/queries/campaign.preview_audience', {
            body: { workspaceId, audience: { tagIds, stageIds }, channel },
          }),
        );
        if (!stale) setPreview(out);
      } catch {
        if (!stale) setPreview(null);
      }
    }, 300);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [workspaceId, tagIds, stageIds, picked, channel]);

  const published = m.page.state === 'published' && !!link;
  const description = l.description.inUse?.words ?? null;
  const street = l.street ?? '';
  const priceWords = l.listPriceCents !== null ? money(l.listPriceCents) : null;
  const rooms =
    l.facts.beds && l.facts.baths ? `${l.facts.beds} beds, ${l.facts.baths} baths` : null;
  // The same words the campaign is made with (core's), so what's shown is what's sent.
  const words =
    published && description
      ? email
        ? listingEmailWords({ street, priceWords, description, pageUrl: link! })
        : { text: listingTextWords({ street, priceWords, rooms, pageUrl: link! }) }
      : null;
  const skipped = Object.entries(preview?.skipped ?? {}).filter(([, n]) => n > 0);
  const left = skipped.reduce((a, [, n]) => a + n, 0);
  const openPipelines = pipelines
    .filter((p) => !p.archivedAt)
    .map((p) => ({ ...p, stages: p.stages.filter((s) => s.kind === 'open') }))
    .filter((p) => p.stages.length > 0);
  const blocked = !published
    ? 'Put the page up first: the email and the text link to it.'
    : !description
      ? 'It needs a description the seller signed off. Send one to them from Description.'
      : null;

  return (
    <Card className="p-4 md:p-5" data-testid="marketing-campaign">
      <CardHead title="Email or text to your contacts" />
      <Segmented<'email' | 'sms'>
        value={channel}
        onChange={setChannel}
        ariaLabel="Send as"
        options={[
          { value: 'email', label: 'Email', testId: 'marketing-channel-email' },
          { value: 'sms', label: 'Text', testId: 'marketing-channel-sms' },
        ]}
      />
      <div className="mt-3 flex flex-col gap-2">
        <span className="text-[13px] font-medium text-text">Who gets it</span>
        <TagPicker
          workspaceId={workspaceId}
          tags={tags}
          selected={tagIds}
          onChange={setTagIds}
          compact
        />
        {openPipelines.length ? (
          <details className="text-[13px]">
            <summary className="cursor-pointer text-text-2">
              Or people with a deal in a stage
            </summary>
            {openPipelines.map((p) => (
              <div key={p.id} className="mt-2 flex flex-col gap-1.5">
                {openPipelines.length > 1 ? (
                  <span className="text-[12px] font-medium text-text-3">{p.name}</span>
                ) : null}
                <div className="flex flex-wrap gap-x-5 gap-y-2">
                  {p.stages.map((s) => (
                    <Checkbox
                      key={s.id}
                      label={s.name}
                      checked={stageIds.includes(s.id)}
                      onChange={(e) =>
                        setStageIds((ids) =>
                          e.target.checked ? [...ids, s.id] : ids.filter((id) => id !== s.id),
                        )
                      }
                    />
                  ))}
                </div>
              </div>
            ))}
          </details>
        ) : null}
        {preview ? (
          <p className="text-[12.5px] text-text-2" data-testid="marketing-audience">
            {people(preview.recipients)}
            {left
              ? ` · ${left} left out (${skipped.map(([why]) => skipWords(why).toLowerCase()).join(', ')})`
              : ''}
          </p>
        ) : null}
        {email && preview && !preview.postalAddress ? (
          <p className="text-[12.5px] text-warning-text">
            Add your business address in Settings → Payments first. Every campaign email has to show
            it.
          </p>
        ) : null}
      </div>
      {words ? (
        <div className="mt-3 flex flex-col gap-2" data-testid="marketing-words">
          {'subject' in words ? (
            <>
              <span className="text-[13px] font-medium text-text">Subject</span>
              <div className="rounded-control border border-border bg-card-2 px-3 py-2 text-[14px]">
                {words.subject}
              </div>
              <div className="whitespace-pre-wrap rounded-control border border-border bg-card-2 px-3 py-2 text-[13.5px] leading-relaxed">
                {words.body.replace('{first_name}', '(their first name)')}
              </div>
            </>
          ) : (
            <div className="whitespace-pre-wrap rounded-control border border-border bg-card-2 px-3 py-2 text-[13.5px] leading-relaxed">
              {words.text}
            </div>
          )}
        </div>
      ) : blocked ? (
        <Callout tone="neutral" className="mt-3">
          {blocked}
        </Callout>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <span className="text-[12.5px] text-text-2">
          You approve it in Campaigns before anything is sent.
        </span>
        {live ? (
          <Button
            disabled={
              !words ||
              !picked ||
              preview?.recipients === 0 ||
              (email && preview !== null && !preview.postalAddress)
            }
            loading={busy === 'campaign'}
            onClick={() =>
              void act(
                'campaign',
                async () => {
                  const out = unwrap(
                    await apiBrowser().POST('/v1/commands/realestate.listing.campaign', {
                      body: {
                        workspaceId,
                        dealId,
                        channel,
                        audience: { tagIds, stageIds },
                        pageUrl: link!,
                      },
                    }),
                  );
                  router.push(`/app/w/${workspaceId}/campaigns/${out.campaignId}`);
                },
                'Started. Read it and approve it in Campaigns.',
              )
            }
            data-testid="marketing-campaign-start"
          >
            Start the campaign
          </Button>
        ) : null}
      </div>
    </Card>
  );
}

function PostsCard({
  workspaceId,
  dealId,
  marketing: m,
  factsReady,
  onMls,
  live,
}: {
  workspaceId: string;
  dealId: string;
  marketing: Marketing;
  factsReady: boolean;
  onMls: boolean;
  live: boolean;
}) {
  const { busy, act } = useAct();
  const items = [...m.posts.items].sort((a, b) => a.position - b.position);
  const drafting = m.posts.state === 'drafting';
  return (
    <Card className="self-start p-4 md:p-5" data-testid="marketing-posts">
      <CardHead
        title="Social posts"
        action={
          live ? (
            <Button
              size="sm"
              variant="secondary"
              disabled={!factsReady || drafting}
              loading={busy === 'draft'}
              onClick={() =>
                void act('draft', async () =>
                  unwrap(
                    await apiBrowser().POST('/v1/commands/realestate.listing.posts_request', {
                      body: { workspaceId, dealId },
                    }),
                  ),
                )
              }
              data-testid="marketing-posts-draft"
            >
              {m.posts.state === 'none' ? 'Draft them' : 'Draft again'}
            </Button>
          ) : null
        }
      />
      {drafting ? (
        <p className="flex items-center gap-2 text-[13.5px] text-text-2" role="status">
          <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} />
          Drafting three posts from the home’s confirmed facts…
        </p>
      ) : m.posts.state === 'failed' ? (
        <p className="text-[13.5px] text-text-2">
          {m.posts.failure ?? 'They couldn’t be written. Ask again.'}
        </p>
      ) : m.posts.state === 'none' ? (
        <p className="text-[13.5px] text-text-2">
          {factsReady
            ? 'None yet. The AI drafts three from the confirmed facts, the price, the signed-off description and the open houses, and both fair housing checks read each one.'
            : 'Confirm the home’s facts first: the posts are written from them.'}
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {items.map((p) => (
            <PostItem key={p.id} workspaceId={workspaceId} post={p} onMls={onMls} live={live} />
          ))}
        </ul>
      )}
      <p className="mt-3 text-[12.5px] text-text-3">
        {onMls
          ? 'HandsFreeOS doesn’t post them for you. Copy one into your own account.'
          : 'You can draft and edit them now, and copy them once it’s live on the MLS.'}
      </p>
    </Card>
  );
}

function PostItem({
  workspaceId,
  post: p,
  onMls,
  live,
}: {
  workspaceId: string;
  post: Post;
  onMls: boolean;
  live: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(p.words ?? '');
  const { busy, errors, act } = useAct(() => setEditing(false));
  const checking = !(p.checked.words && p.checked.model);
  const flagged = p.flags.length > 0;
  return (
    <li className="py-3 first:pt-0" data-testid="marketing-post">
      {editing ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              'save',
              async () =>
                unwrap(
                  await apiBrowser().POST('/v1/commands/realestate.listing.post_save', {
                    body: { workspaceId, postId: p.id, words: text },
                  }),
                ),
              'Saved. It’s checked again.',
            );
          }}
        >
          <Textarea
            aria-label="The post"
            rows={4}
            maxLength={1000}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          {errors.words ? (
            <p className="mt-1 text-[12.5px] text-danger-text">{errors.words}</p>
          ) : null}
          <div className="mt-2 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button size="sm" type="submit" loading={busy === 'save'}>
              Save
            </Button>
          </div>
        </form>
      ) : (
        <p className="whitespace-pre-wrap text-[14px] leading-relaxed">
          <Marked words={p.words ?? ''} phrases={p.flags.map((f) => f.phrase)} />
        </p>
      )}
      {flagged && !editing ? (
        <ul className="mt-2 space-y-1.5">
          {p.flags.map((f, i) => (
            <li
              key={i}
              className="rounded-menu border-l-[3px] border-danger bg-danger-soft px-3 py-2 text-[13px] text-danger-text"
            >
              <span className="font-semibold">Fair housing: “{f.phrase}”.</span> {f.reason}{' '}
              {f.safer} Change the words before you copy it.
            </li>
          ))}
        </ul>
      ) : null}
      {!editing ? (
        <div className="mt-2 flex items-center justify-between gap-2">
          {checking ? (
            <Badge variant="pending">Checking…</Badge>
          ) : flagged ? (
            <Badge variant="danger">
              {p.flags.length} {p.flags.length === 1 ? 'flag' : 'flags'}
            </Badge>
          ) : (
            <Badge variant="ok">Checks clear</Badge>
          )}
          <div className="flex gap-1.5">
            {live ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setText(p.words ?? '');
                  setEditing(true);
                }}
              >
                Edit
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="secondary"
              disabled={!onMls || checking || flagged || !p.words}
              onClick={() =>
                void navigator.clipboard
                  .writeText(p.words ?? '')
                  .then(() => toast.success('Copied. Paste it into your own account.'))
                  .catch(() =>
                    toast.error('It couldn’t be copied. Select the words and copy them.'),
                  )
              }
              data-testid="marketing-post-copy"
            >
              Copy
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

/** "Mark it live on the MLS" (board 36): its number, the day, and the MLS page as proof if there is one. */
function MarkLiveDialog({
  open,
  onClose,
  workspaceId,
  dealId,
  timeZone,
  documents,
}: {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  dealId: string;
  timeZone: string;
  documents: readonly DealDocument[];
}) {
  const today = localDayOf(Date.now(), timeZone);
  const [number, setNumber] = useState('');
  const [liveOn, setLiveOn] = useState(today);
  const [documentId, setDocumentId] = useState(documents[0]?.documentId ?? '');
  const [file, setFile] = useState<File | null>(null);
  const { busy, errors, act } = useAct(() => {
    setNumber('');
    setFile(null);
    onClose();
  });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Mark it live on the MLS">
        <form
          className="mt-4 flex flex-col gap-3.5"
          onSubmit={(e) => {
            e.preventDefault();
            void act('live', async () => {
              let proof = documentId || undefined;
              if (!proof && file) {
                const fileId = await uploadFile(workspaceId, 'custom_record', dealId, file);
                proof = unwrap(
                  await apiBrowser().POST('/v1/commands/realestate.document.add', {
                    body: {
                      workspaceId,
                      dealId,
                      fileId,
                      kind: 'mls_listing',
                      status: 'draft',
                      title: `MLS listing #${number.trim()}`,
                    },
                  }),
                ).documentId;
              }
              const out = unwrap(
                await apiBrowser().POST('/v1/commands/realestate.listing.mark_live', {
                  body: {
                    workspaceId,
                    dealId,
                    mlsNumber: number.trim(),
                    liveOn,
                    ...(proof ? { documentId: proof } : {}),
                  },
                }),
              );
              toast.success(
                out.movedTo
                  ? 'It’s live, and the deal moved to Active. The page, the flyer and the rest are open now.'
                  : 'It’s live. The page, the flyer and the rest are open now.',
              );
            });
          }}
        >
          <Field label="MLS number" htmlFor="mls-number" error={errors.mlsNumber}>
            <Input
              id="mls-number"
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              placeholder="4821937"
              autoComplete="off"
              data-testid="mark-live-number"
            />
          </Field>
          <Field label="Live since" htmlFor="mls-live-on" error={errors.liveOn}>
            <Input
              id="mls-live-on"
              type="date"
              max={today}
              value={liveOn}
              onChange={(e) => setLiveOn(e.target.value)}
            />
          </Field>
          <Field
            label="The MLS page (optional)"
            htmlFor="mls-page"
            hint="Kept as proof for “Enter listing into MLS”."
            error={errors.documentId}
          >
            <div className="flex flex-col gap-2">
              {documents.length ? (
                <Select
                  id="mls-page"
                  value={documentId}
                  onChange={(e) => setDocumentId(e.target.value)}
                >
                  {documents.map((d) => (
                    <option key={d.documentId} value={d.documentId}>
                      {d.title} · {d.fileName}
                    </option>
                  ))}
                  <option value="">Upload another, or none</option>
                </Select>
              ) : null}
              {!documentId ? (
                <input
                  id={documents.length ? undefined : 'mls-page'}
                  type="file"
                  accept="application/pdf,image/*"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  className="block w-full text-[13.5px] text-text-2 file:mr-3 file:rounded-control file:border file:border-border-strong file:bg-card file:px-3 file:py-1.5 file:text-[13px] file:font-medium file:text-text"
                  data-testid="mark-live-file"
                />
              ) : null}
            </div>
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              loading={busy === 'live'}
              disabled={!number.trim() || !liveOn}
              data-testid="mark-live-submit"
            >
              Mark it live
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
