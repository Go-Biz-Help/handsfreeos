import {
  BUSINESS_PAGE_WORDS as BW,
  businessPageHours,
  buttonColorFor,
  isWideLogo,
  LOOK_DEFAULT_COLOR,
  ONBOARDING_SETUP_WORDS as W,
  onboardingPagePreview,
  type OnboardingSetupAnswers,
  type OnboardingSetupState,
} from '@hfos/core';
import * as Linking from 'expo-linking';
import type { LucideIcon } from 'lucide-react-native';
import * as React from 'react';
import { Share, View } from 'react-native';

import { Pills } from '@/components/ai-setup/fields';
import {
  CalendarDays,
  ExternalLink,
  MapPin,
  MessageCircle,
  MessageSquare,
  Phone,
  Share as ShareIcon,
} from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Label } from '@/components/ui/label';
import { Text } from '@/components/ui/text';
import { logoSrc } from '@/look/calls';
import { ONBOARDING_SETUP_PHONE_WORDS as P } from '@/onboarding-setup/words';

import { Mark } from './look';
import { Note, type OwnScreenProps } from './screens';

/**
 * "A simple page for your business" on the phone (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §4, §8), as
 * the web's PageScreen: for a business with no website, Use this page, with a picture of the page made from the answers
 * so far and its address once it's live; or Not now, saying why it matters. The frame keeps the answer
 * (`onboarding_setup.save`), which puts the page live or takes it down.
 */
export function PageScreen({ state, answers, set, calls }: OwnScreenProps) {
  const [origin, setOrigin] = React.useState<string | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    void calls.publicOrigin().then((o) => {
      if (!cancelled) setOrigin(o);
    });
    return () => {
      cancelled = true;
    };
  }, [calls]);
  const link = state.page && origin ? `${origin}/book/${state.page.slug}` : null;
  return (
    <>
      <Pills
        name="use-page"
        options={['use', 'not'] as const}
        labels={{ use: W.usePage, not: W.notNow }}
        value={answers.usePage ? 'use' : 'not'}
        onChange={(v) => set('usePage', v === 'use')}
      />
      {answers.usePage ? (
        <>
          <PagePreview state={state} answers={answers} />
          {link ? (
            <View className="gap-2" testID="setup-page-link">
              <Label>{W.pageAt}</Label>
              <View className="rounded-menu border border-border bg-card px-3.5 py-3">
                <Text className="text-[14.5px]" selectable numberOfLines={2}>
                  {link}
                </Text>
              </View>
              <View className="flex-row flex-wrap items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  icon={ShareIcon}
                  onPress={() => void Share.share({ message: link, url: link })}
                  testID="setup-page-share"
                >
                  {P.share}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={ExternalLink}
                  onPress={() => void Linking.openURL(link)}
                  testID="setup-page-open"
                >
                  {W.openPage}
                </Button>
              </View>
            </View>
          ) : null}
          <Text className="text-[13px] leading-[18px] text-text-3">{W.pageLater}</Text>
        </>
      ) : (
        <Note>{W.pageNotNow}</Note>
      )}
    </>
  );
}

/**
 * The page as customers will see it, from the answers so far, with every button it will have once the number, the
 * booking page and the chat are set up. A picture of a page: one image to a screen reader, and nothing to press.
 */
function PagePreview({
  state,
  answers,
}: {
  state: OnboardingSetupState;
  answers: OnboardingSetupAnswers;
}) {
  const color = state.look.color?.hex ?? LOOK_DEFAULT_COLOR;
  const button = buttonColorFor(color);
  const logo = state.look.logo
    ? {
        url: logoSrc(state.look.logo.path),
        width: state.look.logo.width,
        height: state.look.logo.height,
      }
    : null;
  const page = onboardingPagePreview(state, answers);
  const hours = page.openHours ? businessPageHours(page.openHours) : [];
  const actions: { key: string; icon: LucideIcon; label: string }[] = [
    ...(answers.booksTime ? [{ key: 'book', icon: CalendarDays, label: BW.book }] : []),
    { key: 'call', icon: Phone, label: BW.call },
    { key: 'text', icon: MessageSquare, label: BW.text },
    { key: 'chat', icon: MessageCircle, label: BW.chat },
  ];
  return (
    <View className="gap-2">
      <View
        className="overflow-hidden rounded-card border border-border bg-bg"
        accessible
        accessibilityRole="image"
        accessibilityLabel={W.pagePreview}
        testID="setup-page-preview"
      >
        <View className="flex-row items-center gap-2.5 border-b border-border bg-card px-3.5 py-2.5">
          <Mark name={state.businessName} logo={logo} color={color} size={32} />
          {isWideLogo(logo) ? null : (
            <Text className="min-w-0 flex-1 text-[14px] font-medium" numberOfLines={1}>
              {state.businessName}
            </Text>
          )}
        </View>
        <View className="gap-4 p-3.5">
          <View className="gap-2">
            <Text className="text-[20px] font-semibold leading-[26px]">{state.businessName}</Text>
            {page.place ? (
              <View className="flex-row items-center gap-1.5">
                <Icon as={MapPin} className="size-3.5 text-text-2" />
                <Text className="text-[13px] text-text-2">{page.place}</Text>
              </View>
            ) : null}
            {page.description ? (
              <Text className="text-[14px] leading-[20px] text-text-2">{page.description}</Text>
            ) : null}
            <View className="flex-row flex-wrap gap-1.5 pt-1">
              {actions.map((a, i) => (
                <View
                  key={a.key}
                  className="h-8 flex-row items-center gap-1.5 rounded-control border px-2.5"
                  style={
                    i === 0
                      ? { backgroundColor: button, borderColor: button }
                      : { borderColor: button }
                  }
                >
                  <a.icon size={14} color={i === 0 ? '#ffffff' : button} strokeWidth={1.75} />
                  <Text
                    className="text-[13px] font-medium"
                    style={{ color: i === 0 ? '#ffffff' : button }}
                  >
                    {a.label}
                  </Text>
                </View>
              ))}
            </View>
          </View>
          {page.services.length ? (
            <Part title={page.servicesTitle}>
              {page.services.map((s) => (
                <View key={s.name} className="gap-0.5">
                  <View className="flex-row items-baseline justify-between gap-3">
                    <Text className="min-w-0 flex-1 text-[14px] font-medium">{s.name}</Text>
                    {s.price ? <Text className="text-[13px] text-text-2">{s.price}</Text> : null}
                  </View>
                  {s.description ? (
                    <Text className="text-[12.5px] leading-[17px] text-text-2">
                      {s.description}
                    </Text>
                  ) : null}
                </View>
              ))}
            </Part>
          ) : null}
          {hours.length || page.hours.trim() ? (
            <Part title={BW.hours}>
              {hours.length ? (
                hours.map((row) => (
                  <View key={row.days} className="flex-row gap-4">
                    <Text className="w-[72px] text-[13px] text-text-2">{row.days}</Text>
                    <Text className="min-w-0 flex-1 text-[13px]">{row.times}</Text>
                  </View>
                ))
              ) : (
                <Text className="text-[13px]">{page.hours}</Text>
              )}
            </Part>
          ) : null}
          {page.area.trim() ? (
            <Part title={BW.area}>
              <Text className="text-[13px]">{page.area}</Text>
            </Part>
          ) : null}
          <Text className="text-center text-[11.5px] text-text-3">
            {`${BW.privacy} · ${BW.terms}`}
          </Text>
          <Text className="text-center text-[11.5px] text-text-3">{BW.byline}</Text>
        </View>
      </View>
      <Text className="text-[12.5px] leading-[17px] text-text-3">
        {W.pageButtonsLater(answers.booksTime)}
      </Text>
    </View>
  );
}

/** One part of the page, in its own box. */
function Part({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View className="gap-2 rounded-[12px] border border-border bg-card p-3">
      <Text className="text-[14px] font-semibold">{title}</Text>
      {children}
    </View>
  );
}
