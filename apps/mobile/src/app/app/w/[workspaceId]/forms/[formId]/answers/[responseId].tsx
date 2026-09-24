import { holds } from '@hfos/core';
import { router, useLocalSearchParams } from 'expo-router';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { CloudOff, Trash } from '@/components/icons';
import { businessHref, useBusiness } from '@/components/shell/business-context';
import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { deleteFormAnswer, useFormAnswer } from '@/forms/use-answers';
import { usePhoneForm } from '@/forms/use-forms';
import { answerWords, FORM_WORDS, responseLine } from '@/forms/words';
import { useGrants } from '@/lib/grants';
import { openWeb } from '@/lib/open-web';

/**
 * What one person said on a form (M17): each question worded as it read when they answered it, who they are (a tap
 * opens them), and when. Live, as the list is; a file or a signature says to open it on the web, where it can be seen.
 *
 * Whoever may look after forms (`forms.manage`, as on the web) can delete the sheet here, after saying so a second
 * time: it can't be undone. It goes straight out, needs signal, and says so when there is none.
 */
export default function FormAnswer() {
  const { business } = useBusiness();
  const { formId, responseId } = useLocalSearchParams<{ formId: string; responseId: string }>();
  const form = usePhoneForm(String(formId));
  const { data, loading, error, reload } = useFormAnswer(business.id, String(responseId));
  const back = businessHref(business.id, `forms/${String(formId)}`);
  const canDelete = holds(useGrants(), 'forms.manage');
  const [asking, setAsking] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);

  const remove = async () => {
    setDeleting(true);
    try {
      await deleteFormAnswer(business.id, String(responseId));
      setAsking(false);
      toast.show(FORM_WORDS.deleted);
      // Back to the form, whose list asks again when it comes into view, so the sheet is gone from it.
      if (router.canGoBack()) router.back();
      else router.replace(back);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Something went wrong. Try again.');
    }
    setDeleting(false);
  };

  return (
    <Screen
      title={data?.response.personName ?? (data ? FORM_WORDS.anonymous : 'Answers')}
      subtitle={form?.name}
      leading="back"
      back={back}
      testID="form-answer"
    >
      {data ? (
        <>
          <Card className="gap-1 px-3.5 py-3">
            {data.response.personId ? (
              <Pressable
                role="link"
                onPress={() =>
                  router.push(
                    businessHref(business.id, `customers/people/${data.response.personId}`),
                  )
                }
                testID="form-answer-person"
              >
                <Text className="text-[15px] font-medium text-accent-text">
                  {data.response.personName ?? 'The customer'}
                </Text>
              </Pressable>
            ) : (
              <Text className="text-[15px] font-medium">{FORM_WORDS.anonymous}</Text>
            )}
            <Text className="text-[13px] text-text-3">
              {responseLine(data.response, business.timezone)}
            </Text>
          </Card>

          <Card className="gap-3 px-3.5 py-3" testID="form-answer-list">
            {data.answers.length === 0 ? (
              <Text className="text-[13.5px] text-text-3">No answers on this one.</Text>
            ) : (
              data.answers.map((answer) => (
                <View key={answer.questionId} className="gap-0.5">
                  <Text className="text-[12.5px] text-text-3">{answer.questionTitle}</Text>
                  <Text className="text-[14.5px] leading-[21px]" selectable>
                    {answerWords(answer)}
                  </Text>
                </View>
              ))
            )}
          </Card>

          {Object.keys(data.calculations).length ? (
            <Card className="gap-1 px-3.5 py-3">
              {Object.entries(data.calculations).map(([id, value]) => (
                <View key={id} className="flex-row justify-between">
                  <Text className="text-[13px] text-text-2">Worked out</Text>
                  <Text className="text-[13px] font-medium">{String(value)}</Text>
                </View>
              ))}
            </Card>
          ) : null}

          <Button
            variant="ghost"
            onPress={() => void openWeb(`/app/w/${business.id}/forms/${String(formId)}`)}
            testID="form-answer-open-web"
          >
            Open this form on the web
          </Button>

          {canDelete ? (
            <Button
              variant="ghostDanger"
              icon={Trash}
              onPress={() => setAsking(true)}
              testID="form-answer-delete"
            >
              {FORM_WORDS.delete}
            </Button>
          ) : null}
        </>
      ) : loading ? (
        <Card className="px-5 py-8">
          <Text className="text-center text-[13.5px] text-text-3">{FORM_WORDS.loading}</Text>
        </Card>
      ) : (
        <Card className="items-center gap-3 px-5 py-8" testID="form-answer-error">
          <Icon as={CloudOff} className="size-6 text-text-3" />
          <Text className="text-center text-[14.5px] leading-[21px] text-text-2">
            {error ?? FORM_WORDS.needsSignal}
          </Text>
          <Button variant="secondary" className="self-stretch" onPress={reload}>
            {FORM_WORDS.retry}
          </Button>
        </Card>
      )}

      <Sheet
        open={asking}
        onClose={() => setAsking(false)}
        title={FORM_WORDS.deleteTitle}
        description={FORM_WORDS.deleteWhat}
        testID="form-answer-delete-sheet"
      >
        <View className="gap-2">
          <Button
            variant="danger"
            loading={deleting}
            onPress={() => void remove()}
            testID="form-answer-delete-confirm"
          >
            {FORM_WORDS.deleteConfirm}
          </Button>
          <Button variant="ghost" onPress={() => setAsking(false)}>
            {FORM_WORDS.keep}
          </Button>
        </View>
      </Sheet>
    </Screen>
  );
}
