import {
  answerProblem,
  formState,
  smsConsentWords,
  type AnswerSheet,
  type AnswerValue,
} from '@hfos/core';
import { router, useLocalSearchParams } from 'expo-router';
import * as React from 'react';
import { View } from 'react-native';

import { change, newId } from '@/changes';
import { QuestionField } from '@/components/forms/question-field';
import { businessHref, useBusiness } from '@/components/shell/business-context';
import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { blockedQuestions, usePhoneForm } from '@/forms/use-forms';
import { openWeb } from '@/lib/open-web';

/**
 * Filling a form in on a job (M17).
 *
 * **The engine is core's.** `formState` decides which questions are showing and prunes the answers to them;
 * `answerProblem` decides whether an answer will do. The same two run in the editor's preview, on the public
 * page and on the server, which is why what this screen accepts is what the server accepts.
 *
 * **It works with no signal.** `form_response.record` is an "any time" command carrying an id made here, so
 * sending it puts it in the phone's queue and a retry is the same answer sheet rather than a second one. The
 * screen says it has gone, because for the person holding the phone it has: the job is done and the queue is
 * ours to worry about.
 */
export default function FillForm() {
  const { business } = useBusiness();
  const { formId } = useLocalSearchParams<{ formId: string }>();
  const form = usePhoneForm(String(formId));
  const [answers, setAnswers] = React.useState<AnswerSheet>({});
  const [tried, setTried] = React.useState(false);
  const [consent, setConsent] = React.useState(false);
  const [sending, setSending] = React.useState(false);
  // Made once, not per attempt: a failed send that the person tries again is the same answer sheet.
  const responseId = React.useMemo(() => newId(), []);

  // Back from filling in goes to the form's own page, where its answers and its link are.
  const formHref = businessHref(business.id, `forms/${String(formId)}`);
  const blocked = form ? blockedQuestions(form.definition) : [];
  const state = form ? formState(form.definition, answers) : null;
  const words = smsConsentWords(business.name, 'form');

  if (!form)
    return (
      <Screen
        title="Form"
        leading="back"
        back={businessHref(business.id, 'forms')}
        testID="fill-form"
      >
        <Text className="px-1 py-6 text-[13px] text-text-2">
          This form isn’t on this phone. It may have been unpublished, or this phone may not have
          caught up yet.
        </Text>
      </Screen>
    );

  // A question this screen cannot ask stops the whole form rather than being quietly dropped. Rendering four
  // of five questions and sending an answer sheet missing the fifth is the failure worth avoiding.
  if (blocked.length > 0)
    return (
      <Screen title={form.name} leading="back" back={formHref} testID="fill-form">
        <View className="gap-2 px-1 py-6">
          <Text className="text-[15px] font-medium">Fill this one in on the web</Text>
          <Text className="text-[13px] text-text-2">
            {blocked.length === 1 ? `“${blocked[0]}” needs` : `${blocked.length} questions need`}{' '}
            something this screen can’t do yet — a file, a signature or a card payment.
          </Text>
          <Button
            variant="secondary"
            className="mt-2 self-start"
            onPress={() => openWeb(`/app/w/${business.id}/forms/${form.id}`)}
            testID="fill-form-open-web"
          >
            Open on the web
          </Button>
        </View>
      </Screen>
    );

  const send = async () => {
    setTried(true);
    const problems = state!.questions
      .map((q) => ({ id: q.id, message: answerProblem(q, state!.answers[q.id] ?? null) }))
      .filter((p) => p.message);
    if (problems.length > 0) return;
    setSending(true);
    try {
      await change('form_response.record', {
        workspaceId: business.id,
        id: responseId,
        formId: form.id,
        // The pruned sheet, not the raw one: an answer to a question that hid itself is dropped here the
        // same way the server would drop it.
        answers: state!.answers as Record<string, AnswerValue>,
        smsConsent: consent,
      });
      toast.show('Sent.');
      // Back to the form's page, which counts it as on its way until HandsFreeOS has it.
      if (router.canGoBack()) router.back();
      else router.replace(formHref);
    } catch {
      toast.show('That didn’t send. It’s saved on this phone; try again.');
    } finally {
      setSending(false);
    }
  };

  return (
    <Screen title={form.name} leading="back" back={formHref} testID="fill-form">
      {form.definition.intro ? (
        <Text className="px-1 pb-1 text-[13px] text-text-2">{form.definition.intro}</Text>
      ) : null}
      <View className="gap-1">
        {state!.questions.map((question) => (
          <QuestionField
            key={question.id}
            question={question}
            value={state!.answers[question.id] ?? null}
            onChange={(value) => setAnswers((was) => ({ ...was, [question.id]: value }))}
            problem={tried ? answerProblem(question, state!.answers[question.id] ?? null) : null}
          />
        ))}
      </View>

      {/* The same words the public form and the booking page show, from core, because a carrier reads all
          three and two of them saying different things is what an audit finds. */}
      {form.definition.settings.identity !== 'anonymous' ? (
        <View className="mt-3 gap-1.5 rounded-menu bg-card-2 p-3">
          <View className="flex-row items-center gap-3">
            <Switch
              label={words.title}
              checked={consent}
              onCheckedChange={(next: boolean) => setConsent(next)}
            />
            <Text className="flex-1 text-[14px] font-medium">{words.title}</Text>
          </View>
          <Text className="text-xs text-text-3">{words.detail}</Text>
        </View>
      ) : null}

      <Button
        className="mt-4"
        loading={sending}
        onPress={() => void send()}
        testID="fill-form-send"
      >
        Send it
      </Button>
    </Screen>
  );
}
