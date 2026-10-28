import {
  DOCUMENT_EDITOR_WORDS as E,
  DOCUMENT_FIELD_LABELS,
  documentDay,
  type DocumentEdit,
  type DocumentField,
  type DocumentFont,
  type DocumentPage,
  type DocumentValueInput,
} from '@hfos/core';
import * as React from 'react';
import {
  Image,
  Platform,
  Pressable,
  ScrollView,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';

import { X } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useColors } from '@/theme';

import { documentCalls, type PagePicture, type PagesSource } from './calls';

/**
 * A document's pages on the phone (docs/documents.md, part 3). The phone can't read a PDF, so each page is the picture
 * the worker drew of it, at the screen's width, with a layer on top for what's placed on it: fields, the words typed
 * over, what's filled in. Positions are fractions of the page (core's definition.ts), so the layer is laid out in
 * percentages and only a font size needs the scale (pixels per point).
 *
 * Pages are asked for a few at a time as they scroll near. Until a page's picture comes, it's a white sheet of the
 * right shape (the definition knows each page's size), so what's on top still lands where it goes.
 */

/** Pages asked for at once: the worker's most. */
const CHUNK = 4;
/** How far past the screen a page is asked for, in pixels. */
const NEAR = 900;
/** The space between pages, and around them. */
const GAP = 16;

/** A box on the page from its fractions. */
export const boxStyle = (b: { x: number; y: number; w: number; h: number }) =>
  ({
    position: 'absolute',
    left: `${b.x * 100}%`,
    top: `${b.y * 100}%`,
    width: `${b.w * 100}%`,
    height: `${b.h * 100}%`,
  }) as const;

/** How a word change's font is drawn, close to the PDF's own Helvetica, Times and Courier. */
export const EDIT_FONTS: Readonly<Record<DocumentFont, string>> = {
  sans: Platform.select({ ios: 'Helvetica', default: 'sans-serif' }),
  serif: Platform.select({ ios: 'Times New Roman', default: 'serif' }),
  mono: Platform.select({ ios: 'Courier', default: 'monospace' }),
};

/** The pictures of a PDF's pages, asked for a few at a time. */
export function usePagePictures(workspaceId: string, source: PagesSource | null, key: string) {
  const calls = React.useMemo(() => documentCalls(workspaceId), [workspaceId]);
  const [pictures, setPictures] = React.useState<Readonly<Record<number, PagePicture>>>({});
  const [failed, setFailed] = React.useState(false);
  const asked = React.useRef(new Set<number>());
  const live = React.useRef(key);

  React.useEffect(() => {
    // Another PDF: start again.
    if (live.current === key) return;
    live.current = key;
    asked.current = new Set();
    setPictures({});
    setFailed(false);
  }, [key]);

  const want = React.useCallback(
    (index: number) => {
      if (!source) return;
      const from = Math.floor(index / CHUNK) * CHUNK;
      if (asked.current.has(from)) return;
      asked.current.add(from);
      const askedFor = live.current;
      calls
        .pages(source, from, CHUNK)
        .then((out) => {
          if (live.current !== askedFor) return;
          setPictures((was) => ({
            ...was,
            ...Object.fromEntries(out.pages.map((p) => [p.page, p])),
          }));
        })
        .catch(() => {
          if (live.current !== askedFor) return;
          asked.current.delete(from);
          setFailed(true);
        });
    },
    [calls, source],
  );

  const retry = React.useCallback(() => {
    asked.current = new Set();
    setFailed(false);
  }, []);

  return { pictures, want, failed, retry };
}

export interface PageLayer {
  readonly index: number;
  /** The page's size on the screen, in pixels. */
  readonly width: number;
  readonly height: number;
  /** Pixels per point at that width. */
  readonly scale: number;
}

/**
 * The pages, one under another, in a scroll of their own. `header` sits above them; `onPagePress` gets where a page
 * was tapped, in fractions of it, for whatever isn't on top of it.
 */
export function PdfPagesView({
  pages,
  pictures,
  onWant,
  failed,
  onRetry,
  layer,
  header,
  onPagePress,
  scrollEnabled = true,
  testID,
}: {
  pages: readonly DocumentPage[];
  pictures: Readonly<Record<number, PagePicture>>;
  onWant: (index: number) => void;
  failed?: boolean;
  onRetry?: () => void;
  layer?: (page: PageLayer) => React.ReactNode;
  header?: React.ReactNode;
  onPagePress?: (index: number, at: { x: number; y: number }) => void;
  scrollEnabled?: boolean;
  testID?: string;
}) {
  const colors = useColors();
  const [width, setWidth] = React.useState(0);
  const tops = React.useRef<number[]>([]);
  const view = React.useRef({ y: 0, height: 0 });

  const look = React.useCallback(() => {
    const { y, height } = view.current;
    if (!height) return;
    pages.forEach((p, i) => {
      const top = tops.current[i];
      if (top === undefined || !width) return;
      const bottom = top + (width * p.height) / p.width;
      if (bottom >= y - NEAR && top <= y + height + NEAR) onWant(i);
    });
  }, [pages, width, onWant]);

  React.useEffect(() => {
    if (pages.length) onWant(0);
  }, [pages.length, onWant]);
  React.useEffect(look, [look, failed]);

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    view.current = {
      y: e.nativeEvent.contentOffset.y,
      height: e.nativeEvent.layoutMeasurement.height,
    };
    look();
  };

  return (
    <ScrollView
      className="flex-1"
      contentContainerStyle={{ padding: 12, paddingBottom: 32, gap: GAP }}
      keyboardShouldPersistTaps="handled"
      scrollEnabled={scrollEnabled}
      scrollEventThrottle={64}
      onScroll={onScroll}
      onLayout={(e: LayoutChangeEvent) => {
        view.current = { ...view.current, height: e.nativeEvent.layout.height };
        setWidth(Math.max(0, Math.floor(e.nativeEvent.layout.width - 24)));
      }}
      testID={testID}
    >
      {header}
      {failed ? (
        <View className="items-center gap-2 py-2" testID="pages-failed">
          <Text role="alert" className="text-center text-[13px] text-danger-text">
            {E.phone.pagesFailed}
          </Text>
          {onRetry ? (
            <Button variant="secondary" size="sm" onPress={onRetry}>
              {E.phone.tryAgain}
            </Button>
          ) : null}
        </View>
      ) : null}
      {width > 0
        ? pages.map((size, index) => {
            const height = Math.round((width * size.height) / size.width);
            const picture = pictures[index];
            return (
              <View
                key={index}
                className="items-center gap-1.5"
                onLayout={(e) => {
                  tops.current[index] = e.nativeEvent.layout.y;
                  if (index === pages.length - 1) look();
                }}
              >
                <View
                  style={{
                    width,
                    height,
                    backgroundColor: '#ffffff',
                    borderWidth: 1,
                    borderColor: colors.border,
                    overflow: 'hidden',
                  }}
                  testID={`document-page-${index}`}
                >
                  {picture ? (
                    <Image
                      source={{ uri: picture.picture }}
                      style={{ position: 'absolute', left: 0, top: 0, width, height }}
                      resizeMode="stretch"
                      accessibilityIgnoresInvertColors
                      testID={`document-page-picture-${index}`}
                    />
                  ) : null}
                  {onPagePress ? (
                    <Pressable
                      style={{ position: 'absolute', left: 0, top: 0, width, height }}
                      onPress={(e) =>
                        onPagePress(index, {
                          x: e.nativeEvent.locationX / width,
                          y: e.nativeEvent.locationY / height,
                        })
                      }
                      testID={`document-page-press-${index}`}
                    />
                  ) : null}
                  {layer ? layer({ index, width, height, scale: width / size.width }) : null}
                </View>
                {pages.length > 1 ? (
                  <Text className="text-[11.5px] text-text-3">
                    {E.pageOf(index + 1, pages.length)}
                  </Text>
                ) : null}
              </View>
            );
          })
        : null}
    </ScrollView>
  );
}

/** Words typed over the PDF (answer 26c): the old ones covered in the paper's colour, the new ones written on it. */
export function EditView({ edit, scale }: { edit: DocumentEdit; scale: number }) {
  const size = edit.size * scale;
  return (
    <View
      pointerEvents="none"
      style={{ ...boxStyle(edit), backgroundColor: edit.background, overflow: 'hidden' }}
    >
      <Text
        style={{
          color: edit.color,
          fontFamily: EDIT_FONTS[edit.font],
          fontWeight: edit.bold ? '700' : '400',
          fontSize: size,
          lineHeight: size * 1.15,
        }}
      >
        {edit.text}
      </Text>
    </View>
  );
}

/** What was filled in a field, drawn the way the signed copy draws it. */
export function ValueView({
  value,
  type,
  fontSize,
  scale,
}: {
  value: DocumentValueInput;
  type: string;
  fontSize: number;
  scale: number;
}) {
  if (value.kind === 'signature')
    return (
      <Image
        source={{ uri: value.image }}
        style={{ width: '100%', height: '100%' }}
        resizeMode="contain"
        accessibilityLabel={`Signed by ${value.name}`}
      />
    );
  if (value.kind === 'check')
    return value.checked ? (
      <View className="flex-1 items-center justify-center" accessibilityLabel="Ticked">
        <X size={Math.max(8, 14 * scale)} color="#111827" strokeWidth={2.5} />
      </View>
    ) : null;
  const text = value.kind === 'date' ? documentDay(value.date) : value.text;
  const size = fontSize * scale;
  return (
    <Text
      numberOfLines={type === 'long_text' ? undefined : 1}
      style={{
        color: '#111827',
        fontFamily: EDIT_FONTS.sans,
        fontSize: size,
        lineHeight: size * 1.2,
        paddingHorizontal: 2,
      }}
    >
      {text}
    </Text>
  );
}

/** A field on a page: its signer's colour, what it asks for, or what's filled in it. */
export function FieldView({
  field,
  colour,
  scale,
  value,
  picked,
}: {
  field: DocumentField;
  colour: string;
  scale: number;
  value?: DocumentValueInput;
  picked?: boolean;
}) {
  const name = field.label || DOCUMENT_FIELD_LABELS[field.type];
  return (
    <View
      pointerEvents="none"
      style={{
        width: '100%',
        height: '100%',
        borderRadius: 3,
        borderWidth: picked ? 2 : 1,
        borderColor: colour,
        backgroundColor: value ? `${colour}10` : `${colour}26`,
        justifyContent: 'center',
        overflow: 'hidden',
      }}
    >
      {value ? (
        <ValueView value={value} type={field.type} fontSize={field.fontSize} scale={scale} />
      ) : field.type === 'checkbox' ? null : (
        <Text
          numberOfLines={1}
          style={{
            color: colour,
            fontSize: Math.max(7, Math.min(12, field.fontSize * scale)),
            fontWeight: '500',
            paddingHorizontal: 2,
          }}
        >
          {`${name}${field.required ? ' *' : ''}`}
        </Text>
      )}
    </View>
  );
}
