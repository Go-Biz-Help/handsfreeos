import { fileKindLabel, filePhoneLine, formatBytes, FILE_WORDS, type FileOut } from '@hfos/core';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { Camera, FileText, Image as ImageIcon, CloudUpload } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { usePhotoProgress } from '@/changes/hooks';
import type { PhotoRow } from '@/changes/photos';
import { megabytes } from '@/changes/list';

/**
 * A record's files and photos. The list itself is the phone's copy, so it reads with no signal; opening one needs the
 * network, because the file lives in Storage and its link is short-lived. A photo taken here is kept on the phone
 * first and uploads on its own track, so a weak signal never holds up a note or a text (the canvas's note).
 */

export function FileRow({
  file,
  onOpen,
  online,
}: {
  file: FileOut;
  onOpen: (file: FileOut) => void;
  online: boolean;
}) {
  return (
    <Pressable
      role="button"
      onPress={() => onOpen(file)}
      className="min-h-14 flex-row items-center gap-3 border-b border-border px-1 py-2.5"
      testID={`file-row-${file.id}`}
      accessibilityLabel={`Open ${file.name}`}
    >
      <View className="size-10 items-center justify-center rounded-control bg-card-2">
        <Icon as={file.isImage ? ImageIcon : FileText} className="size-5 text-text-3" />
      </View>
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-[14px] font-semibold" numberOfLines={1} testID="file-name">
          {file.name}
        </Text>
        <Text className="text-[12px] text-text-3" numberOfLines={1}>
          {filePhoneLine({
            by: file.uploadedBy?.fullName ?? null,
            createdAt: file.createdAt,
            sizeBytes: file.sizeBytes,
          })}
        </Text>
      </View>
      <Text className="text-[11px] font-semibold text-text-3">
        {fileKindLabel(file.mimeType, file.isImage)}
      </Text>
      {!online ? <Text className="text-[11px] text-text-3">{FILE_WORDS.needsSignal}</Text> : null}
    </Pressable>
  );
}

/** A photo this phone is still uploading: it is already the record's, and says how far it has got. */
export function UploadingRow({ photo }: { photo: PhotoRow }) {
  const progress = usePhotoProgress(photo.id);
  const sent = progress?.sent ?? photo.bytes_sent;
  return (
    <View
      className="min-h-14 flex-row items-center gap-3 border-b border-border px-1 py-2.5"
      testID={`file-uploading-${photo.id}`}
    >
      <View className="size-10 items-center justify-center rounded-control bg-accent-soft">
        <Icon as={CloudUpload} className="size-5 text-accent-text" />
      </View>
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-[14px] font-semibold" numberOfLines={1}>
          {photo.file_name}
        </Text>
        <Text className="text-[12px] text-text-3">
          {sent > 0
            ? `${FILE_WORDS.uploading} · ${megabytes(sent, photo.size_bytes)}`
            : `${FILE_WORDS.uploading} · ${formatBytes(photo.size_bytes)}`}
        </Text>
      </View>
    </View>
  );
}

export function FilesEmpty({ onAdd }: { onAdd: () => void }) {
  return (
    <Card className="items-center gap-2 px-4 py-8" testID="files-empty">
      <Text className="text-[15px] font-semibold">{FILE_WORDS.emptyTitle}</Text>
      <Text className="text-center text-[13px] text-text-2">{FILE_WORDS.emptyBody}</Text>
      <Button variant="secondary" size="sm" icon={Camera} onPress={onAdd} testID="files-add">
        {FILE_WORDS.takePhoto}
      </Button>
    </Card>
  );
}
