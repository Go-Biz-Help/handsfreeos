import { FORM_MODE_LABELS } from '@hfos/core';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import * as React from 'react';
import { Share, View } from 'react-native';

import { ClipboardPen, CloudOff, CloudUpload, Link2, UserRound } from '@/components/icons';
import { businessHref, useBusiness } from '@/components/shell/business-context';
import { List, ListLabel, ListRow } from '@/components/shell/list';
import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { fetchFormLink, useAnswersOnThisPhone, useFormAnswers } from '@/forms/use-answers';
import { usePhoneForm } from '@/forms/use-forms';
import { FORM_WORDS, responseLine } from '@/forms/words';
import { useNetwork } from '@/lib/network';

/**
 * One form on the phone (M17): fill it in, send its link to somebody, and see who answered.
 *
 * Filling in works with no signal (the form is in the phone's copy). The link and the answers don't: the business's
 * link name and what customers said aren't kept on the phone, so they're asked for live, and say so when they can't
 * be. An answer sheet filled in here that hasn't reached HandsFreeOS yet is counted above the list, so it isn't
 * missing without a word.
 */
export default function FormPage() {
  const { business } = useBusiness();
  const { formId } = useLocalSearchParams<{ formId: string }>();
  const id = String(formId);
  const form = usePhoneForm(id);
  const answers = useFormAnswers(business.id, id);
  const onThisPhone = useAnswersOnThisPhone(business.id, id);
  const { online } = useNetwork();
  const [link, setLink] = React.useState<string | null>(null);
  const [linking, setLinking] = React.useState(false);

  // Coming back from filling one in, or from an answer sheet, asks again: somebody may have answered meanwhile.
  const { reload } = answers;
  const first = React.useRef(true);
  useFocusEffect(
    React.useCallback(() => {
      if (first.current) {
        first.current = false;
        return;
      }
      reload();
    }, [reload]),
  );

  if (!form)
    return (
      <Screen title="Form" leading="back" back={businessHref(business.id, 'forms')} testID="form">
        <Text className="px-1 py-6 text-[13px] text-text-2">
          This form isn’t on this phone. It may have been unpublished, or this phone may not have
          caught up yet.
        </Text>
      </Screen>
    );

  /**
   * The link is shown first and sent second, as an invoice's payment link is: the phone's share sheet is another
   * app's screen over this one, and opening it straight away leaves nobody sure what was sent. From the sheet, Send
   * it hands the link to Messages, Mail or Copy — whichever the person wants.
   */
  const shareLink = async () => {
    setLinking(true);
    try {
      setLink(await fetchFormLink(business.id, form.slug));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'That didn’t work.');
    }
    setLinking(false);
  };

  return (
    <Screen
      title={form.name}
      subtitle={FORM_MODE_LABELS[form.mode]}
      leading="back"
      back={businessHref(business.id, 'forms')}
      testID="form"
    >
      <View className="gap-2">
        <Button
          icon={ClipboardPen}
          onPress={() => router.push(businessHref(business.id, `forms/${form.id}/fill`))}
          testID="form-fill"
        >
          Fill it in
        </Button>
        <Button
          variant="secondary"
          icon={Link2}
          loading={linking}
          onPress={() => void shareLink()}
          testID="form-share"
        >
          {online ? 'Share the link' : 'Share the link — needs signal'}
        </Button>
      </View>

      <ListLabel>ANSWERS</ListLabel>

      {onThisPhone > 0 ? (
        <Card className="flex-row items-center gap-3 px-3.5 py-3" testID="form-answers-waiting">
          <Icon as={CloudUpload} className="size-5 text-text-3" />
          <Text className="flex-1 text-[13px] text-text-2">
            {onThisPhone === 1
              ? 'One filled in on this phone is on its way. It shows here once HandsFreeOS has it.'
              : `${onThisPhone} filled in on this phone are on their way. They show here once HandsFreeOS has them.`}
          </Text>
        </Card>
      ) : null}

      {answers.items.length > 0 ? (
        <>
          <List testID="form-answers">
            {answers.items.map((response) => (
              <ListRow
                key={response.responseId}
                icon={UserRound}
                label={response.personName ?? FORM_WORDS.anonymous}
                detail={responseLine(response, business.timezone)}
                onPress={() =>
                  router.push(
                    businessHref(business.id, `forms/${form.id}/answers/${response.responseId}`),
                  )
                }
                testID={`form-answer-${response.responseId}`}
              />
            ))}
          </List>
          {answers.hasMore ? (
            <Button
              variant="secondary"
              loading={answers.loadingMore}
              onPress={answers.more}
              testID="form-answers-more"
            >
              {FORM_WORDS.showMore}
            </Button>
          ) : null}
          {answers.error ? (
            <Text className="px-1 text-[13px] text-text-3">{answers.error}</Text>
          ) : null}
        </>
      ) : answers.loading ? (
        <Card className="px-5 py-8">
          <Text className="text-center text-[13.5px] text-text-3">{FORM_WORDS.loading}</Text>
        </Card>
      ) : answers.error ? (
        <Card className="items-center gap-3 px-5 py-8" testID="form-answers-error">
          <Icon as={CloudOff} className="size-6 text-text-3" />
          <Text className="text-center text-[14.5px] leading-[21px] text-text-2">
            {answers.error}
          </Text>
          <Button
            variant="secondary"
            className="self-stretch"
            onPress={answers.reload}
            testID="form-answers-retry"
          >
            {FORM_WORDS.retry}
          </Button>
        </Card>
      ) : (
        <Card className="px-5 py-8" testID="form-answers-none">
          <Text className="text-center text-[13.5px] text-text-3">{FORM_WORDS.none}</Text>
        </Card>
      )}

      <Sheet
        open={link !== null}
        onClose={() => setLink(null)}
        title="The form’s link"
        description={FORM_WORDS.linkWhat}
        testID="form-link"
      >
        <Text
          className="rounded-menu bg-card-2 px-3 py-2.5 text-[12.5px] text-text-2"
          selectable
          testID="form-link-url"
        >
          {link ?? ''}
        </Text>
        <Button
          className="mt-3"
          onPress={() => void Share.share({ message: link ?? '', url: link ?? '' })}
          testID="form-link-share"
        >
          Send it
        </Button>
        <Button variant="ghost" className="mt-2" onPress={() => setLink(null)}>
          Done
        </Button>
      </Sheet>
    </Screen>
  );
}
