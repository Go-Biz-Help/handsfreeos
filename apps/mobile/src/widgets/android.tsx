'use no memo';
/**
 * The home-screen widgets on Android (docs/phone-widgets.md), drawn by react-native-android-widget: plain functions
 * that return its widget elements, which it turns into the views Android shows with no app running. The library calls
 * each function once and keeps no state, so the React Compiler stays out of this file ("use no memo").
 *
 * Every word comes from the copy core built (`buildWidgetsData`); this lays it out for the widget's size. Lists
 * scroll on Android, so Today and Needs you show all the rows the copy has.
 */
import {
  WIDGET_EMPTY_WORDS,
  WIDGET_GALLERY,
  WIDGET_WORDS,
  widgetFaceAt,
  type WidgetAction,
  type WidgetActionKey,
  type WidgetFace,
  type WidgetFigure,
  type WidgetList,
  type WidgetRow,
  type WidgetsData,
  type WidgetTone,
} from '@hfos/core';
import * as React from 'react';
import {
  FlexWidget,
  ListWidget,
  SvgWidget,
  TextWidget,
  type ColorProp,
  type HexColor,
  type WidgetInfo,
  type WidgetRepresentation,
} from 'react-native-android-widget';

import { colors } from '@/theme/tokens';

/** Each widget's name in app.json (the `react-native-android-widget` plugin), and which of core's it is. */
export const ANDROID_WIDGETS = {
  MyDay: 'myday',
  Today: 'today',
  NeedsYou: 'needs',
  QuickActions: 'quick',
  Money: 'money',
  Outreach: 'outreach',
  Ask: 'ask',
} as const;

export type AndroidWidgetName = keyof typeof ANDROID_WIDGETS;

export const isAndroidWidget = (name: string): name is AndroidWidgetName => name in ANDROID_WIDGETS;

interface Palette {
  readonly bg: HexColor;
  readonly soft: HexColor;
  readonly text: HexColor;
  readonly text2: HexColor;
  readonly accent: HexColor;
  readonly accentText: HexColor;
  readonly accentSoft: HexColor;
  readonly good: HexColor;
  readonly danger: HexColor;
  readonly onAccent: HexColor;
}

const hex = (c: string) => c.slice(0, 7) as HexColor;

function paletteOf(theme: 'light' | 'dark'): Palette {
  const c = colors[theme];
  return {
    bg: hex(c.card),
    soft: hex(c.card2),
    text: hex(c.text),
    text2: hex(c.text2),
    accent: hex(c.accent),
    accentText: hex(c.accentText),
    accentSoft: hex(c.accentSoft),
    good: hex(c.success),
    danger: hex(c.danger),
    onAccent: '#ffffff',
  };
}

const toneOf = (p: Palette, tone: WidgetTone, otherwise: HexColor): HexColor =>
  tone === 'accent'
    ? p.accentText
    : tone === 'danger'
      ? p.danger
      : tone === 'good'
        ? p.good
        : tone === 'muted'
          ? p.text2
          : otherwise;

const open = (uri: string) => ({ clickAction: 'OPEN_URI', clickActionData: { uri } }) as const;

// ---------- icons (Lucide's, drawn as SVG) ----------

const ICON_PATHS: Record<WidgetActionKey | 'check', string> = {
  contact:
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6"/><path d="M22 11h-6"/>',
  receipt:
    '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
  invoice:
    '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  calendar:
    '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>',
  tasks:
    '<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>',
  ask: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3"/>',
  check: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
};

const svg = (key: keyof typeof ICON_PATHS, color: HexColor) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[key]}</svg>`;

// ---------- pieces ----------

interface Sized {
  readonly width: number;
  readonly height: number;
}

function Card({
  p,
  uri,
  background,
  children,
}: {
  p: Palette;
  uri: string | null;
  background?: ColorProp;
  children: React.ReactNode;
}) {
  return (
    <FlexWidget
      style={{
        height: 'match_parent',
        width: 'match_parent',
        flexDirection: 'column',
        backgroundColor: background ?? p.bg,
        borderRadius: 20,
        padding: 14,
      }}
      {...(uri ? open(uri) : { clickAction: 'OPEN_APP' })}
    >
      {children}
    </FlexWidget>
  );
}

function Header({ p, title, trailing }: { p: Palette; title: string; trailing?: string | null }) {
  return (
    <FlexWidget
      style={{
        width: 'match_parent',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 6,
      }}
    >
      <TextWidget
        text={title}
        maxLines={1}
        truncate="END"
        style={{ fontSize: 14, fontWeight: '600', color: p.accentText }}
      />
      {trailing ? (
        <TextWidget
          text={trailing}
          maxLines={1}
          truncate="END"
          style={{ fontSize: 12, color: p.text2, marginLeft: 8 }}
        />
      ) : null}
    </FlexWidget>
  );
}

function Row({ p, row, lead }: { p: Palette; row: WidgetRow; lead: boolean }) {
  return (
    <FlexWidget
      style={{ width: 'match_parent', flexDirection: 'row', paddingVertical: 5 }}
      {...open(row.url)}
    >
      {lead ? (
        <TextWidget
          text={row.lead}
          maxLines={1}
          style={{
            width: 64,
            fontSize: 12,
            fontWeight: '600',
            color: toneOf(p, row.tone, p.text2),
            marginTop: 1,
          }}
        />
      ) : null}
      <FlexWidget style={{ flex: 1, flexDirection: 'column' }}>
        <TextWidget
          text={row.title}
          maxLines={1}
          truncate="END"
          style={{ fontSize: 14, fontWeight: '600', color: p.text }}
        />
        {row.detail ? (
          <TextWidget
            text={row.detail}
            maxLines={1}
            truncate="END"
            style={{ fontSize: 12, color: p.text2 }}
          />
        ) : null}
      </FlexWidget>
    </FlexWidget>
  );
}

/** "+N more" after the rows the copy holds (it keeps eight). */
function moreThanHeld(list: WidgetList): string | null {
  const left = list.count - list.rows.length;
  return left > 0 ? WIDGET_WORDS.more(left) : null;
}

function Note({ p, text, uri }: { p: Palette; text: string; uri?: string }) {
  return (
    <TextWidget
      text={text}
      maxLines={2}
      truncate="END"
      style={{ fontSize: 12, color: p.text2, marginTop: 4 }}
      {...(uri ? open(uri) : {})}
    />
  );
}

/** A list's rows: scrolling when there's room for more than one, the first alone on a small widget. */
function ListBody({
  p,
  list,
  size,
  fit,
}: {
  p: Palette;
  list: WidgetList;
  size: Sized;
  /** Show only this many, without scrolling (My day's sections). */
  fit?: number;
}) {
  if (!list.rows.length) return <Note p={p} text={list.empty} />;
  const lead = list.rows.some((r) => r.lead);
  if (fit !== undefined) {
    const shown = list.rows.slice(0, fit);
    const more = list.count - shown.length;
    return (
      <FlexWidget style={{ width: 'match_parent', flexDirection: 'column' }}>
        {shown.map((row) => (
          <Row key={row.id} p={p} row={row} lead={lead} />
        ))}
        {more > 0 ? <Note p={p} text={WIDGET_WORDS.more(more)} uri={list.url} /> : null}
      </FlexWidget>
    );
  }
  if (size.height < 150) {
    return (
      <FlexWidget style={{ width: 'match_parent', flexDirection: 'column' }}>
        <Row p={p} row={list.rows[0]!} lead={lead} />
        {list.more['1'] ? <Note p={p} text={list.more['1']} uri={list.url} /> : null}
      </FlexWidget>
    );
  }
  const more = moreThanHeld(list);
  return (
    <ListWidget style={{ height: 'match_parent', width: 'match_parent' }}>
      {list.rows.map((row) => (
        <Row key={row.id} p={p} row={row} lead={lead} />
      ))}
      {more ? (
        <FlexWidget style={{ width: 'match_parent', paddingVertical: 6 }} {...open(list.url)}>
          <TextWidget
            text={more}
            style={{ fontSize: 12, fontWeight: '500', color: p.accentText }}
          />
        </FlexWidget>
      ) : null}
    </ListWidget>
  );
}

function Figure({ p, figure, big }: { p: Palette; figure: WidgetFigure; big?: boolean }) {
  return (
    <FlexWidget style={{ flex: 1, flexDirection: 'column', marginBottom: 6 }}>
      <TextWidget
        text={figure.value}
        maxLines={1}
        style={{
          fontSize: big ? 22 : 17,
          fontWeight: '700',
          color: toneOf(p, figure.tone, p.text),
        }}
      />
      <TextWidget text={figure.label} maxLines={1} style={{ fontSize: 12, color: p.text2 }} />
    </FlexWidget>
  );
}

function Figures({
  p,
  figures,
  perRow,
}: {
  p: Palette;
  figures: readonly WidgetFigure[];
  perRow: number;
}) {
  const rows: WidgetFigure[][] = [];
  for (let i = 0; i < figures.length; i += perRow) rows.push(figures.slice(i, i + perRow));
  return (
    <FlexWidget style={{ width: 'match_parent', flexDirection: 'column' }}>
      {rows.map((row, i) => (
        <FlexWidget key={i} style={{ width: 'match_parent', flexDirection: 'row' }}>
          {row.map((figure) => (
            <Figure key={figure.label} p={p} figure={figure} />
          ))}
        </FlexWidget>
      ))}
    </FlexWidget>
  );
}

function ActionButton({
  p,
  action,
  labels,
}: {
  p: Palette;
  action: WidgetAction;
  labels: boolean;
}) {
  const ask = action.key === 'ask';
  return (
    <FlexWidget
      style={{ flex: 1, flexDirection: 'column', alignItems: 'center' }}
      {...open(action.url)}
      accessibilityLabel={action.label}
    >
      <FlexWidget
        style={{
          width: 44,
          height: 44,
          borderRadius: 22,
          backgroundColor: ask ? p.accent : p.accentSoft,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <SvgWidget
          svg={svg(action.key, ask ? p.onAccent : p.accentText)}
          style={{ width: 22, height: 22 }}
        />
      </FlexWidget>
      {labels ? (
        <TextWidget
          text={action.label}
          maxLines={1}
          style={{ fontSize: 11, fontWeight: '500', color: p.text, marginTop: 4 }}
        />
      ) : null}
    </FlexWidget>
  );
}

function Actions({
  p,
  actions,
  labels,
}: {
  p: Palette;
  actions: readonly WidgetAction[];
  labels: boolean;
}) {
  return (
    <FlexWidget style={{ width: 'match_parent', flexDirection: 'row', alignItems: 'center' }}>
      {actions.map((action) => (
        <ActionButton key={action.key} p={p} action={action} labels={labels} />
      ))}
    </FlexWidget>
  );
}

// ---------- each widget ----------

function TodayWidget({ p, data, face, size }: Faced) {
  const t = face.today;
  return (
    <Card p={p} uri={t.url}>
      <Header
        p={p}
        title={t.title}
        trailing={size.width < 200 ? t.date : `${t.date} · ${t.countWords}`}
      />
      <ListBody p={p} list={t} size={size} />
      {t.tasks && size.height >= 150 ? <Note p={p} text={t.tasks} uri={t.tasksUrl} /> : null}
      {data.showBusiness && size.height >= 250 ? <Note p={p} text={data.business.name} /> : null}
    </Card>
  );
}

function NeedsWidget({ p, face, size }: Faced) {
  const n = face.needs;
  if (!n.count)
    return (
      <Card p={p} uri={n.url}>
        <Header p={p} title={n.title} />
        <SvgWidget svg={svg('check', p.good)} style={{ width: 28, height: 28, marginTop: 4 }} />
        <Note p={p} text={n.empty} />
      </Card>
    );
  if (size.height < 150)
    return (
      <Card p={p} uri={n.rows[0]?.url ?? n.url}>
        <Header p={p} title={n.title} />
        <TextWidget
          text={String(n.count)}
          style={{ fontSize: 34, fontWeight: '700', color: n.urgent ? p.danger : p.text }}
        />
        {n.rows[0] ? (
          <TextWidget
            text={n.rows[0].title}
            maxLines={1}
            truncate="END"
            style={{ fontSize: 13, fontWeight: '600', color: p.text }}
          />
        ) : null}
      </Card>
    );
  return (
    <Card p={p} uri={n.url}>
      <Header p={p} title={n.title} trailing={n.countWords} />
      <ListBody p={p} list={n} size={size} />
    </Card>
  );
}

function QuickWidget({ p, face, size }: Faced) {
  return (
    <Card p={p} uri={null}>
      {size.height >= 110 ? <Header p={p} title={face.quick.title} /> : null}
      <Actions p={p} actions={face.quick.actions} labels={size.height >= 80} />
    </Card>
  );
}

function MoneyWidget({ p, face, size }: Faced) {
  const m = face.money;
  if (!m.allowed)
    return (
      <Card p={p} uri={m.url}>
        <Header p={p} title={m.title} />
        <Note p={p} text={m.note ?? ''} />
      </Card>
    );
  const small = size.width < 200;
  return (
    <Card p={p} uri={m.url}>
      <Header p={p} title={m.title} />
      {small ? (
        <FlexWidget style={{ width: 'match_parent', flexDirection: 'column' }}>
          {m.figures.slice(0, 2).map((figure, i) => (
            <Figure key={figure.label} p={p} figure={figure} big={i === 0} />
          ))}
        </FlexWidget>
      ) : (
        <Figures p={p} figures={m.figures} perRow={2} />
      )}
      {!small && m.note ? <Note p={p} text={m.note} /> : null}
    </Card>
  );
}

function OutreachWidget({ p, data, face, size }: Faced) {
  const addon = face.addons.outreach;
  if (!addon)
    return (
      <Card p={p} uri={data.url}>
        <Header p={p} title={WIDGET_GALLERY.outreach.name} />
        <Note p={p} text={WIDGET_EMPTY_WORDS.signedOut} />
      </Card>
    );
  if (!addon.on)
    return (
      <Card p={p} uri={addon.url}>
        <Header p={p} title={addon.title} />
        <Note p={p} text={addon.note ?? ''} />
      </Card>
    );
  const small = size.width < 200;
  return (
    <Card p={p} uri={addon.url}>
      <Header p={p} title={addon.title} />
      {small ? (
        addon.figures[0] ? (
          <Figure p={p} figure={addon.figures[0]} big />
        ) : null
      ) : (
        <Figures p={p} figures={addon.figures} perRow={3} />
      )}
      {addon.note ? <Note p={p} text={addon.note} /> : null}
    </Card>
  );
}

function AskWidget({ p, face, size }: Faced) {
  const tiny = size.height < 100 || size.width < 100;
  return (
    <Card p={p} uri={face.ask.url} background={p.accent}>
      <FlexWidget
        style={{
          width: tiny ? 'match_parent' : 48,
          height: tiny ? 'match_parent' : 48,
          borderRadius: 24,
          backgroundColor: tiny ? p.accent : p.onAccent,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <SvgWidget
          svg={svg('ask', tiny ? p.onAccent : p.accent)}
          style={{ width: 24, height: 24 }}
        />
      </FlexWidget>
      {tiny ? null : (
        <FlexWidget style={{ flexDirection: 'column', marginTop: 10 }}>
          <TextWidget
            text={face.ask.title}
            maxLines={2}
            style={{ fontSize: 14, fontWeight: '700', color: p.onAccent }}
          />
          <TextWidget
            text={face.ask.hint}
            maxLines={1}
            style={{ fontSize: 12, color: '#ffffffd9' }}
          />
        </FlexWidget>
      )}
    </Card>
  );
}

function MyDayWidget({ p, data, face, size }: Faced) {
  const roomy = size.height >= 330;
  return (
    <Card p={p} uri={data.url}>
      <Header
        p={p}
        title={WIDGET_GALLERY.myday.name}
        trailing={data.showBusiness ? data.business.name : face.today.date}
      />
      <FlexWidget
        style={{ width: 'match_parent', flexDirection: 'column', marginTop: 2 }}
        {...open(face.today.url)}
      >
        <Header p={p} title={face.today.title} trailing={face.today.countWords} />
      </FlexWidget>
      <ListBody p={p} list={face.today} size={size} fit={roomy ? 3 : 2} />
      <FlexWidget
        style={{ width: 'match_parent', flexDirection: 'column', marginTop: 6 }}
        {...open(face.needs.url)}
      >
        <Header
          p={p}
          title={face.needs.title}
          trailing={face.needs.count ? face.needs.countWords : null}
        />
      </FlexWidget>
      <ListBody p={p} list={face.needs} size={size} fit={roomy ? 2 : 1} />
      <FlexWidget style={{ flex: 1 }} />
      <Actions p={p} actions={face.quick.actions} labels={roomy} />
    </Card>
  );
}

interface Faced {
  readonly p: Palette;
  readonly data: WidgetsData;
  readonly face: WidgetFace;
  readonly size: Sized;
}

const DRAW: Record<AndroidWidgetName, (props: Faced) => React.JSX.Element> = {
  MyDay: MyDayWidget,
  Today: TodayWidget,
  NeedsYou: NeedsWidget,
  QuickActions: QuickWidget,
  Money: MoneyWidget,
  Outreach: OutreachWidget,
  Ask: AskWidget,
};

function Empty({ p }: { p: Palette }) {
  return (
    <Card p={p} uri={null}>
      <TextWidget
        text="HandsFreeOS"
        style={{ fontSize: 14, fontWeight: '600', color: p.accentText }}
      />
      <Note p={p} text={WIDGET_EMPTY_WORDS.signedOut} />
    </Card>
  );
}

/** One widget, light and dark, as it is at `now`: the moment that has begun, from the copy. */
export function renderAndroidWidget(
  name: AndroidWidgetName,
  data: WidgetsData | null,
  info: Pick<WidgetInfo, 'width' | 'height'>,
  now: number,
): WidgetRepresentation {
  const size = { width: info.width, height: info.height };
  const draw = (theme: 'light' | 'dark') => {
    const p = paletteOf(theme);
    if (!data) return <Empty p={p} />;
    const Widget = DRAW[name];
    return <Widget p={p} data={data} face={widgetFaceAt(data, now)} size={size} />;
  };
  return { light: draw('light'), dark: draw('dark') };
}
