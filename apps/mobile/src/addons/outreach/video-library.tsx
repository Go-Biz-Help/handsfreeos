/**
 * Settings → Videos on the phone (docs/outreach.md, decision 154), as the web has it: the business's video library,
 * for owners and admins. Each video is a name, a link and what it shows and when it helps, which is what the AI picks
 * it by. Until it's first saved, the library is the playbooks' short videos (3a), said so above them; any change keeps
 * it as its own. Each video keeps its own Save; a removal saves at once. It needs signal.
 */
import { outreachSettings } from '@hfos/core/addons/outreach/chat-read';
import {
  fromPlaybooks,
  LIBRARY_LIMITS,
  libraryOf,
  libraryVideoProblem,
  VIDEO_LIBRARY_WORDS as V,
  type LibraryVideo,
  type PlaybookVideo,
} from '@hfos/core/addons/outreach/video-library';
import type { OutreachSettings } from '@hfos/core/addons/outreach/chat-read';
import * as React from 'react';
import { View } from 'react-native';
import { List } from '@/components/shell/list';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { Note, openOutside, Part } from './kit';

/** "loom.com/share/abc" is taken to mean https://loom.com/share/abc, as the web takes it. */
const withScheme = (v: string) => {
  const t = v.trim();
  return t && !/^[a-z][a-z0-9+.-]*:/i.test(t) && /^[^\s/]+\.[^\s/]+/.test(t) ? `https://${t}` : t;
};

export function VideoLibraryPart({
  business,
  playbookVideos,
  online,
  onSave,
}: {
  /** The business's Social Outreach settings as saved. */
  business: Readonly<Record<string, unknown>>;
  /** The playbooks' short videos, the library until it's first saved. */
  playbookVideos: readonly PlaybookVideo[];
  online: boolean;
  /** Saves some of the business's settings: the problem's words, or null once saved. */
  onSave: (edit: (now: OutreachSettings) => Partial<OutreachSettings>) => Promise<string | null>;
}) {
  const saved = outreachSettings(business).videos;
  const videos = libraryOf(saved, playbookVideos);
  const folded = fromPlaybooks(saved) && videos.length > 0;
  const [editing, setEditing] = React.useState<number | 'new' | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [problem, setProblem] = React.useState<string | null>(null);
  const save = async (next: LibraryVideo[], key: string): Promise<boolean> => {
    setBusy(key);
    setProblem(null);
    const wrong = await onSave(() => ({ videos: next }));
    setBusy(null);
    setProblem(wrong);
    return wrong === null;
  };
  const full = videos.length >= LIBRARY_LIMITS.videos;
  return (
    <Part title={V.row} about={V.count(videos.length)} testID="settings-videos-library">
      {folded ? <Note testID="settings-videos-from-playbooks">{V.fromPlaybooks}</Note> : null}
      {problem ? (
        <Text role="alert" className="text-[13.5px] text-danger-text">
          {problem}
        </Text>
      ) : null}
      {videos.length === 0 && editing !== 'new' ? (
        <Note testID="settings-videos-none">{V.none}</Note>
      ) : null}
      {videos.length ? (
        <List testID="settings-videos-list">
          {videos.map((v, i) =>
            editing === i ? (
              <View key={v.link} className="p-3">
                <VideoForm
                  initial={v}
                  others={videos.filter((_, j) => j !== i)}
                  busy={busy === `save-${i}`}
                  online={online}
                  onCancel={() => setEditing(null)}
                  onSave={async (changed) => {
                    if (
                      await save(
                        videos.map((o, j) => (j === i ? changed : o)),
                        `save-${i}`,
                      )
                    )
                      setEditing(null);
                  }}
                />
              </View>
            ) : (
              <View key={v.link} className="gap-1.5 px-4 py-3" testID="settings-video">
                <Text className="text-[15px] font-medium">{v.name}</Text>
                <Text className="text-[13.5px] leading-[19px] text-text-2">{v.about}</Text>
                <Text
                  className="text-[13px] text-accent-text"
                  numberOfLines={1}
                  onPress={() => openOutside(v.link)}
                >
                  {v.link}
                </Text>
                <View className="flex-row flex-wrap gap-2 pt-1">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!online || busy !== null}
                    onPress={() => setEditing(i)}
                    testID="settings-video-change"
                  >
                    {V.change}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!online || busy !== null}
                    loading={busy === `remove-${i}`}
                    onPress={() =>
                      void save(
                        videos.filter((_, j) => j !== i),
                        `remove-${i}`,
                      )
                    }
                    testID="settings-video-remove"
                  >
                    {V.remove}
                  </Button>
                </View>
              </View>
            ),
          )}
        </List>
      ) : null}
      {editing === 'new' ? (
        <VideoForm
          initial={null}
          others={videos}
          busy={busy === 'add'}
          online={online}
          onCancel={() => setEditing(null)}
          onSave={async (video) => {
            if (await save([...videos, video], 'add')) setEditing(null);
          }}
        />
      ) : (
        <Button
          variant={videos.length ? 'secondary' : 'primary'}
          className="self-start"
          disabled={!online || full || busy !== null}
          onPress={() => setEditing('new')}
          testID="settings-videos-add"
        >
          {V.add}
        </Button>
      )}
      {full ? <Note>{V.full}</Note> : null}
      <Note>{V.fromScript}</Note>
    </Part>
  );
}

/** One video's boxes, checked as the save checks them. */
function VideoForm({
  initial,
  others,
  busy,
  online,
  onSave,
  onCancel,
}: {
  initial: LibraryVideo | null;
  others: readonly LibraryVideo[];
  busy: boolean;
  online: boolean;
  onSave: (video: LibraryVideo) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = React.useState(initial?.name ?? '');
  const [link, setLink] = React.useState(initial?.link ?? '');
  const [about, setAbout] = React.useState(initial?.about ?? '');
  const [problem, setProblem] = React.useState<string | null>(null);
  return (
    <View
      className="gap-2.5 rounded-card border border-border bg-card p-3"
      testID="settings-video-form"
    >
      <Text className="text-[14px] font-medium">{V.name}</Text>
      <Input
        value={name}
        onChangeText={(t) => {
          setName(t);
          setProblem(null);
        }}
        placeholder={V.namePlaceholder}
        maxLength={LIBRARY_LIMITS.name}
        testID="settings-video-name"
      />
      <Text className="text-[14px] font-medium">{V.link}</Text>
      <Input
        value={link}
        onChangeText={(t) => {
          setLink(t);
          setProblem(null);
        }}
        onBlur={() => setLink(withScheme(link))}
        placeholder={V.linkPlaceholder}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        maxLength={500}
        testID="settings-video-link"
      />
      <Note>{V.linkHint}</Note>
      <Text className="text-[14px] font-medium">{V.aboutLabel}</Text>
      <Input
        value={about}
        onChangeText={(t) => {
          setAbout(t);
          setProblem(null);
        }}
        placeholder={V.aboutPlaceholder}
        multiline
        className="h-24 py-3"
        maxLength={LIBRARY_LIMITS.about}
        testID="settings-video-about"
      />
      <Note>{V.aboutHint}</Note>
      {problem ? (
        <Text
          role="alert"
          className="text-[13.5px] text-danger-text"
          testID="settings-video-problem"
        >
          {problem}
        </Text>
      ) : null}
      <View className="flex-row flex-wrap gap-2">
        <Button
          size="sm"
          disabled={!online || busy}
          loading={busy}
          onPress={() => {
            const video = { name: name.trim(), link: withScheme(link), about: about.trim() };
            const wrong = libraryVideoProblem(video, others);
            setProblem(wrong);
            if (!wrong) void onSave(video);
          }}
          testID="settings-video-save"
        >
          {V.save}
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onPress={onCancel}>
          {V.cancel}
        </Button>
      </View>
    </View>
  );
}
