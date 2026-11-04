'use client';
/**
 * Settings → Videos (docs/outreach.md, decision 154): the business's video library, for owners and admins. Each video
 * is a name, a link and what it shows and when it helps, which is what the AI picks it by for a follow-up after the
 * demo ask, another time after a missed demo, or a reply. Until it's first saved, the library is the playbooks' short
 * videos (3a), said so above them; any change keeps it as its own. Kept with the business's Social Outreach settings
 * (`videos`) through `addon.save_settings`. A box to type in, so each video keeps its own Save, as the extension's link
 * does (decision 73).
 */
import { outreachSettings, settingsToSave } from '@hfos/core/addons/outreach/chat-read';
import {
  fromPlaybooks,
  LIBRARY_LIMITS,
  libraryOf,
  libraryVideoProblem,
  VIDEO_LIBRARY_WORDS as V,
  type LibraryVideo,
  type PlaybookVideo,
} from '@hfos/core/addons/outreach/video-library';
import { ExternalLink, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { useAct } from './use-act';

/** "loom.com/share/abc" is taken to mean https://loom.com/share/abc, as the playbook's links are. */
const withScheme = (v: string) => {
  const t = v.trim();
  return t && !/^[a-z][a-z0-9+.-]*:/i.test(t) && /^[^\s/]+\.[^\s/]+/.test(t) ? `https://${t}` : t;
};

export function VideoLibrary({
  workspaceId,
  business,
  playbookVideos,
}: {
  workspaceId: string;
  /** The business's Social Outreach settings as saved: the others are kept as they are. */
  business: Readonly<Record<string, unknown>>;
  /** The playbooks' short videos, the library until it's first saved. */
  playbookVideos: readonly PlaybookVideo[];
}) {
  const saved = outreachSettings(business).videos;
  const videos = libraryOf(saved, playbookVideos);
  const folded = fromPlaybooks(saved) && videos.length > 0;
  // Which video's form is open: one in the list, a new one, or none.
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const { busy, act } = useAct();
  const save = (next: LibraryVideo[], key: string, done: string) =>
    act(
      key,
      async () =>
        unwrap(
          await apiBrowser().POST('/v1/commands/addon.save_settings', {
            body: {
              workspaceId,
              addonId: 'outreach',
              settings: settingsToSave(business, { videos: next }),
            },
          }),
        ),
      done,
    );
  const full = videos.length >= LIBRARY_LIMITS.videos;
  return (
    <Card className="space-y-4 p-5" data-testid="outreach-videos">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[15px] font-semibold">{V.row}</h3>
        <span className="text-[13px] text-text-2" data-testid="outreach-videos-count">
          {V.count(videos.length)}
        </span>
      </div>
      {folded ? (
        <p
          className="rounded-menu bg-card-2 p-3 text-[13px] text-text-2"
          data-testid="outreach-videos-from-playbooks"
        >
          {V.fromPlaybooks}
        </p>
      ) : null}
      {videos.length === 0 && editing !== 'new' ? (
        <p className="text-[13.5px] text-text-2" data-testid="outreach-videos-none">
          {V.none}
        </p>
      ) : null}
      {videos.length ? (
        <ul className="divide-y divide-border" data-testid="outreach-videos-list">
          {videos.map((v, i) =>
            editing === i ? (
              <li key={v.link} className="py-3">
                <VideoForm
                  initial={v}
                  others={videos.filter((_, j) => j !== i)}
                  busy={busy === `save-${i}`}
                  onCancel={() => setEditing(null)}
                  onSave={async (changed) => {
                    const ok = await save(
                      videos.map((o, j) => (j === i ? changed : o)),
                      `save-${i}`,
                      'Video saved.',
                    );
                    if (ok) setEditing(null);
                  }}
                />
              </li>
            ) : (
              <li
                key={v.link}
                className="flex flex-wrap items-start justify-between gap-3 py-3"
                data-testid="outreach-video"
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="font-medium" data-testid="outreach-video-name">
                    {v.name}
                  </div>
                  <p className="text-[13.5px] text-text-2" data-testid="outreach-video-about">
                    {v.about}
                  </p>
                  <a
                    href={v.link}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex max-w-full items-center gap-1 text-[13px] text-accent-text hover:underline"
                  >
                    <span className="truncate">{v.link}</span>
                    <ExternalLink className="h-3 w-3 shrink-0" strokeWidth={1.75} />
                  </a>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy !== null}
                    onClick={() => setEditing(i)}
                    data-testid="outreach-video-change"
                  >
                    <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} />
                    {V.change}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy !== null}
                    loading={busy === `remove-${i}`}
                    onClick={() =>
                      void save(
                        videos.filter((_, j) => j !== i),
                        `remove-${i}`,
                        'Video removed.',
                      )
                    }
                    data-testid="outreach-video-remove"
                  >
                    <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                    {V.remove}
                  </Button>
                </div>
              </li>
            ),
          )}
        </ul>
      ) : null}
      {editing === 'new' ? (
        <VideoForm
          initial={null}
          others={videos}
          busy={busy === 'add'}
          onCancel={() => setEditing(null)}
          onSave={async (video) => {
            const ok = await save([...videos, video], 'add', 'Video added.');
            if (ok) setEditing(null);
          }}
        />
      ) : (
        <div className="space-y-1.5">
          <Button
            variant={videos.length ? 'secondary' : 'primary'}
            disabled={full || busy !== null}
            onClick={() => setEditing('new')}
            data-testid="outreach-videos-add"
          >
            <Plus className="h-4 w-4" strokeWidth={1.75} />
            {V.add}
          </Button>
          {full ? <p className="text-[13px] text-text-2">{V.full}</p> : null}
        </div>
      )}
      <p className="text-[13px] text-text-2">{V.fromScript}</p>
    </Card>
  );
}

/** One video's boxes: checked as the save checks them, so a link that won't pass says why at once. */
function VideoForm({
  initial,
  others,
  busy,
  onSave,
  onCancel,
}: {
  initial: LibraryVideo | null;
  others: readonly LibraryVideo[];
  busy: boolean;
  onSave: (video: LibraryVideo) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [link, setLink] = useState(initial?.link ?? '');
  const [about, setAbout] = useState(initial?.about ?? '');
  const [problem, setProblem] = useState<string | null>(null);
  const id = initial ? 'outreach-video-edit' : 'outreach-video-new';
  return (
    <form
      className="space-y-3 rounded-menu border border-border p-3.5"
      data-testid="outreach-video-form"
      onSubmit={(e) => {
        e.preventDefault();
        const video = { name: name.trim(), link: withScheme(link), about: about.trim() };
        const wrong = libraryVideoProblem(video, others);
        setProblem(wrong);
        if (!wrong) void onSave(video);
      }}
    >
      <Field label={V.name} htmlFor={`${id}-name`}>
        <Input
          id={`${id}-name`}
          value={name}
          maxLength={LIBRARY_LIMITS.name}
          placeholder={V.namePlaceholder}
          onChange={(e) => {
            setName(e.target.value);
            setProblem(null);
          }}
          data-testid="outreach-video-name-input"
        />
      </Field>
      <Field label={V.link} htmlFor={`${id}-link`} hint={V.linkHint}>
        <Input
          id={`${id}-link`}
          type="url"
          inputMode="url"
          value={link}
          maxLength={500}
          placeholder={V.linkPlaceholder}
          onChange={(e) => {
            setLink(e.target.value);
            setProblem(null);
          }}
          onBlur={() => setLink(withScheme(link))}
          data-testid="outreach-video-link-input"
        />
      </Field>
      <Field label={V.aboutLabel} htmlFor={`${id}-about`} hint={V.aboutHint} error={problem}>
        <Textarea
          id={`${id}-about`}
          rows={3}
          value={about}
          maxLength={LIBRARY_LIMITS.about}
          placeholder={V.aboutPlaceholder}
          onChange={(e) => {
            setAbout(e.target.value);
            setProblem(null);
          }}
          data-testid="outreach-video-about-input"
        />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" loading={busy} data-testid="outreach-video-save">
          {V.save}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
          {V.cancel}
        </Button>
      </div>
    </form>
  );
}
