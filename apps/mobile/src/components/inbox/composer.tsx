import {
  COMPOSER_WORDS,
  composerPlaceholder,
  crossChannelLine,
  emailFromLabel,
  PENDING_REPLY_WORDS,
  PHOTO_CHOICE_WORDS,
  photosSavedLine,
  sendLabel,
  textFromLine,
  THREAD_WORDS,
  type ComposerNote,
  type RichCheck,
  type RichDraft,
  type WordPart,
} from '@hfos/core';
import type { LucideIcon } from 'lucide-react-native';
import * as React from 'react';
import { Image, Pressable, TextInput, View } from 'react-native';

import {
  Camera,
  CircleAlert,
  Clock,
  Image as ImageIcon,
  Mail,
  MessageCircle,
  Paperclip,
  Phone,
  RectangleEllipsis,
  Send,
  Sparkles,
  X,
} from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import type { TrayPhoto } from '@/inbox/send';
import { cn } from '@/lib/utils';
import { photosFolderUri } from '@/sync/device-files';
import { useColors } from '@/theme';

import { newRichDraft, RichEditor } from './rich-editor';

export type ComposerMode = 'sms' | 'email' | 'chat';

/** Over the box while a reply waiting on the phone is reopened from Still send? or the quiet-hours question. */
export const EDITING = 'Editing what you wrote. Send puts it back in line.';

/** A photo on the tray, as the phone keeps it until the reply goes. */
export function localPhotoUri(userId: string, localName: string): string {
  return `${photosFolderUri(userId)}/${encodeURIComponent(localName)}`;
}

/** A sentence with a word or two in bold. */
export function Words({ parts, className }: { parts: readonly WordPart[]; className?: string }) {
  return (
    <Text className={className}>
      {parts.map((p, i) =>
        typeof p === 'string' ? (
          p
        ) : (
          <Text key={i} className={cn(className, 'font-semibold')}>
            {p.strong}
          </Text>
        ),
      )}
    </Text>
  );
}

const NOTE_ICON: Record<ComposerNote['icon'], LucideIcon> = {
  alert: CircleAlert,
  clock: Clock,
  phone: Phone,
  mail: Mail,
};

/** Why the box is off: texting isn't set up, the customer opted out, no address. */
function NoteBox({ note }: { note: ComposerNote }) {
  const tone =
    note.tone === 'danger'
      ? 'bg-danger-soft text-danger-text'
      : note.tone === 'warning'
        ? 'bg-warning-soft text-warning-text'
        : 'bg-accent-soft text-accent-text';
  const [bg, text] = tone.split(' ');
  return (
    <View
      className={cn('flex-row items-start gap-2 rounded-menu px-3 py-2.5', bg)}
      testID="composer-note"
    >
      <Icon as={NOTE_ICON[note.icon]} className={cn('mt-0.5 size-4', text)} />
      <Words
        parts={note.parts}
        className={cn('min-w-0 flex-1 text-[13.5px] leading-[19px]', text)}
      />
    </View>
  );
}

/**
 * The composer, as the Inbox canvas draws it: Text or Email (each keeps its own thread, as on the web), the From line,
 * photos on a tray ("Photos you send are saved to Mike’s files too."), the box and Send. With no signal it says texts go
 * on their own within 30 minutes; when sending takes the conversation from the AI teammate, it says so first.
 */
export function Composer({
  userId,
  mode,
  modes,
  onMode,
  body,
  onBody,
  subject,
  onSubject,
  showSubject,
  photos,
  onAddPhoto,
  onRemovePhoto,
  canPhoto,
  note,
  off,
  first,
  phoneDisplay,
  fromNumber,
  fromEmail,
  elsewhere,
  handover,
  online,
  editing,
  onCancelEdit,
  busy,
  onSend,
  boxKey = 0,
  rich = null,
  onRich,
  richCheck = null,
  canRich = false,
  canCarousel = false,
  onCardPhoto,
}: {
  userId: string;
  mode: ComposerMode;
  /** The switch's two choices, or null in a website chat (no switch). */
  modes: readonly ('sms' | 'email')[] | null;
  onMode: (mode: 'sms' | 'email') => void;
  body: string;
  onBody: (body: string) => void;
  subject: string;
  onSubject: (subject: string) => void;
  showSubject: boolean;
  photos: readonly TrayPhoto[];
  onAddPhoto: (source: 'camera' | 'library') => void;
  onRemovePhoto: (photo: TrayPhoto) => void;
  /** Photos go to the customer's files, so they need a customer; a website chat takes none. */
  canPhoto: boolean;
  note: ComposerNote | null;
  off: boolean;
  first: string | null;
  phoneDisplay: string;
  fromNumber: string | null;
  fromEmail: string | null;
  /** Sending from this thread to the customer's other channel: where it goes. */
  elsewhere: string | null;
  handover: string | null;
  online: boolean;
  editing: boolean;
  onCancelEdit: () => void;
  busy: boolean;
  onSend: () => void;
  /** Changes after a send, so an iPhone's box shrinks back to one line (it keeps a cleared box's height). */
  boxKey?: number;
  /** A text's buttons, card or carousel being written (RCS, 0103), and core's check of it with the words. */
  rich?: RichDraft | null;
  onRich?: (next: RichDraft | null) => void;
  richCheck?: RichCheck | null;
  /** Buttons go with texts, not emails or website chats, and not while a waiting reply is being edited. */
  canRich?: boolean;
  /** A carousel's pictures go to the customer's files, so it needs a customer. */
  canCarousel?: boolean;
  onCardPhoto?: (cardKey: string, source: 'camera' | 'library') => void;
}) {
  const colors = useColors();
  const [choosing, setChoosing] = React.useState(false);
  const placeholder = composerPlaceholder({
    mode,
    off,
    note,
    firstName: first,
    phoneDisplay,
    compact: true,
  });
  const from =
    mode === 'email'
      ? fromEmail
        ? emailFromLabel(fromEmail)
        : null
      : mode === 'sms' && fromNumber
        ? textFromLine(fromNumber)
        : null;
  const ready = !off && !busy && body.trim().length > 0;
  const richOn = !!rich && canRich && !off;
  return (
    <View className="gap-2 border-t border-border bg-card px-3 pb-2 pt-2.5" testID="composer">
      {!online && !off ? (
        <Text className="px-1 text-xs leading-[17px] text-text-3" testID="composer-offline">
          {PENDING_REPLY_WORDS.offline(mode)}
        </Text>
      ) : null}
      {handover && !off ? (
        <View className="flex-row items-center gap-1.5 px-1" testID="composer-handover">
          <Icon as={Sparkles} className="size-3.5 text-text-3" />
          <Text className="min-w-0 flex-1 text-xs leading-[17px] text-text-3">{handover}</Text>
        </View>
      ) : null}
      {editing ? (
        <View className="flex-row items-center gap-2 px-1" testID="composer-editing">
          <Text className="min-w-0 flex-1 text-xs font-medium text-accent-text">{EDITING}</Text>
          <Pressable
            role="button"
            onPress={onCancelEdit}
            hitSlop={12}
            className="h-7 justify-center px-1.5"
            testID="composer-cancel-edit"
          >
            <Text className="text-[13px] font-semibold text-accent-text">
              {THREAD_WORDS.cancel}
            </Text>
          </Pressable>
        </View>
      ) : null}
      {modes || from ? (
        <View className="min-h-9 flex-row items-center gap-2">
          {modes ? (
            <View
              role="tablist"
              accessibilityLabel="Text or email"
              className="flex-row gap-0.5 rounded-[9px] bg-card-2 p-[3px]"
            >
              {modes.map((m) => {
                const on = m === mode;
                return (
                  <Pressable
                    key={m}
                    role="tab"
                    accessibilityState={{ selected: on }}
                    onPress={() => onMode(m)}
                    hitSlop={{ top: 6, bottom: 6 }}
                    testID={`composer-mode-${m}`}
                    className={cn(
                      'h-[30px] flex-row items-center gap-1.5 rounded-[7px] px-3',
                      on && 'bg-card',
                    )}
                    style={on ? { boxShadow: '0 1px 2px rgba(16,24,40,0.12)' } : undefined}
                  >
                    <Icon
                      as={m === 'sms' ? MessageCircle : Mail}
                      className={cn('size-3.5', on ? 'text-text' : 'text-text-2')}
                    />
                    <Text
                      className={cn('text-[13px] font-medium', on ? 'text-text' : 'text-text-2')}
                    >
                      {m === 'sms' ? COMPOSER_WORDS.text : COMPOSER_WORDS.email}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          ) : null}
          <View className="flex-1" />
          {from ? (
            <Text numberOfLines={1} className="shrink text-xs text-text-3" testID="composer-from">
              {from}
            </Text>
          ) : null}
        </View>
      ) : null}
      {elsewhere && !off ? (
        <Text className="px-1 text-xs text-text-3" testID="composer-elsewhere">
          {crossChannelLine(mode === 'email' ? 'email' : 'sms', elsewhere)}
        </Text>
      ) : null}
      {note ? <NoteBox note={note} /> : null}
      {richOn && rich && richCheck && onRich ? (
        <RichEditor
          draft={rich}
          onChange={onRich}
          onClose={() => onRich(null)}
          check={richCheck}
          photos={photos.length}
          canCarousel={canCarousel}
          callNumber={fromNumber}
          photoUri={(localName) => localPhotoUri(userId, localName)}
          onCardPhoto={(key, source) => onCardPhoto?.(key, source)}
        />
      ) : null}
      {photos.length > 0 ? (
        <View className="flex-row items-center gap-2.5" testID="composer-photos">
          <View className="flex-row gap-2">
            {photos.map((p, i) => (
              <View key={p.fileId} className="size-[62px]">
                <Image
                  source={{ uri: localPhotoUri(userId, p.localName) }}
                  accessibilityIgnoresInvertColors
                  className="size-[62px] rounded-[10px] bg-card-2"
                  testID="composer-photo"
                />
                <Pressable
                  role="button"
                  accessibilityLabel={PHOTO_CHOICE_WORDS.remove(i + 1)}
                  onPress={() => onRemovePhoto(p)}
                  hitSlop={10}
                  className="absolute -right-1.5 -top-1.5 size-[22px] items-center justify-center rounded-full bg-toast-bg"
                  testID={`composer-photo-remove-${i + 1}`}
                >
                  <Icon as={X} className="size-3 text-toast-text" strokeWidth={2} />
                </Pressable>
              </View>
            ))}
          </View>
          <Text className="min-w-0 flex-1 text-xs leading-[17px] text-text-3" testID="photos-saved">
            {photosSavedLine(first)}
          </Text>
        </View>
      ) : null}
      {showSubject && !off ? (
        <TextInput
          value={subject}
          onChangeText={onSubject}
          placeholder={COMPOSER_WORDS.subject}
          placeholderTextColor={colors.placeholder}
          accessibilityLabel={COMPOSER_WORDS.subject}
          className="h-10 rounded-menu border border-border-strong bg-card px-3.5 font-sans text-[15px] text-text"
          testID="composer-subject"
        />
      ) : null}
      <View className="flex-row items-end gap-2">
        {canPhoto && !off ? (
          <Pressable
            role="button"
            accessibilityLabel={COMPOSER_WORDS.attachPhoto}
            onPress={() => setChoosing(true)}
            className="size-11 items-center justify-center rounded-full active:bg-card-2"
            testID="composer-attach"
          >
            <Icon as={Paperclip} className="size-5 text-text-2" />
          </Pressable>
        ) : null}
        {canRich && !off && onRich ? (
          <Pressable
            role="button"
            accessibilityLabel={COMPOSER_WORDS.addButtons}
            accessibilityState={{ selected: richOn }}
            onPress={() => onRich(rich ? null : newRichDraft())}
            className={cn(
              'size-11 items-center justify-center rounded-full active:bg-card-2',
              richOn && 'bg-accent-soft',
            )}
            testID="composer-rich"
          >
            <Icon
              as={RectangleEllipsis}
              className={cn('size-5', richOn ? 'text-accent-text' : 'text-text-2')}
            />
          </Pressable>
        ) : null}
        <View
          className={cn(
            'min-h-11 min-w-0 flex-1 justify-center rounded-[22px] border border-border-strong bg-card px-4',
            off && 'bg-card-2',
          )}
        >
          <TextInput
            key={boxKey}
            value={body}
            onChangeText={onBody}
            editable={!off}
            multiline
            placeholder={placeholder}
            placeholderTextColor={colors.placeholder}
            selectionColor={colors.accent}
            cursorColor={colors.accent}
            accessibilityLabel={placeholder}
            className="max-h-[128px] py-2.5 font-sans text-base leading-[22px] text-text"
            textAlignVertical="center"
            testID="composer-body"
          />
        </View>
        <Pressable
          role="button"
          accessibilityLabel={sendLabel(mode, false, off)}
          accessibilityState={{ disabled: !ready }}
          disabled={!ready}
          onPress={onSend}
          className={cn(
            'size-11 items-center justify-center rounded-full bg-accent active:bg-accent-hover',
            !ready && 'opacity-50',
          )}
          testID="composer-send"
        >
          <Icon as={Send} className="size-[18px] text-white" />
        </Pressable>
      </View>
      <Sheet
        open={choosing}
        onClose={() => setChoosing(false)}
        title={PHOTO_CHOICE_WORDS.title}
        testID="photo-choice"
      >
        <View className="mt-3 gap-2">
          <Button
            variant="secondary"
            icon={Camera}
            onPress={() => {
              setChoosing(false);
              // The picker opens once the sheet has gone: an iPhone won't show it over a closing sheet.
              setTimeout(() => onAddPhoto('camera'), 450);
            }}
            testID="photo-camera"
          >
            {PHOTO_CHOICE_WORDS.camera}
          </Button>
          <Button
            variant="secondary"
            icon={ImageIcon}
            onPress={() => {
              setChoosing(false);
              // The picker opens once the sheet has gone: an iPhone won't show it over a closing sheet.
              setTimeout(() => onAddPhoto('library'), 450);
            }}
            testID="photo-library"
          >
            {PHOTO_CHOICE_WORDS.library}
          </Button>
        </View>
      </Sheet>
    </View>
  );
}
