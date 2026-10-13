import { EXTENSION_SIGN_IN_WORDS, type ExtensionSignInPending } from '@hfos/core';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as React from 'react';
import { View } from 'react-native';

import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { api, errorMessage, unwrap } from '@/lib/api';

type State =
  | { readonly kind: 'loading' }
  | { readonly kind: 'asking'; readonly request: ExtensionSignInPending }
  | { readonly kind: 'done'; readonly said: string; readonly ok: boolean };

/**
 * Signing in to the browser extension with this person's email (its push, `extension_sign_in`, 20261027002900):
 * "Signing in to the extension on Chrome? Pick the number you see." with three numbers. The right one lets it in;
 * a wrong one, or That wasn’t me, stops it. Answered online, straight away: it lasts two minutes.
 */
export default function ExtensionSignIn() {
  const { requestId } = useLocalSearchParams<{ requestId: string }>();
  const router = useRouter();
  const [state, setState] = React.useState<State>({ kind: 'loading' });
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const found = unwrap(await api.POST('/v1/queries/extension_sign_in.pending', { body: {} }));
        const request = found.requests.find((r) => r.id === String(requestId));
        if (cancelled) return;
        setState(
          request
            ? { kind: 'asking', request }
            : { kind: 'done', said: EXTENSION_SIGN_IN_WORDS.gone, ok: false },
        );
      } catch (e) {
        if (!cancelled) setState({ kind: 'done', said: errorMessage(e), ok: false });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [requestId]);

  const answer = async (pick: number | null) => {
    if (state.kind !== 'asking') return;
    setBusy(true);
    try {
      const out = unwrap(
        await api.POST('/v1/commands/extension_sign_in.answer', {
          body: { requestId: state.request.id, pick },
        }),
      );
      setState({
        kind: 'done',
        ok: out.outcome === 'approved',
        said:
          out.outcome === 'approved'
            ? EXTENSION_SIGN_IN_WORDS.approved
            : pick === null
              ? EXTENSION_SIGN_IN_WORDS.denied
              : EXTENSION_SIGN_IN_WORDS.refused,
      });
    } catch (e) {
      setState({ kind: 'done', said: errorMessage(e), ok: false });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title="Extension sign-in" back="/app" testID="extension-sign-in">
      <View className="gap-4 px-4 pt-4">
        {state.kind === 'loading' ? <Text variant="muted">One moment…</Text> : null}
        {state.kind === 'asking' ? (
          <>
            <Text variant="heading">{EXTENSION_SIGN_IN_WORDS.question(state.request.browser)}</Text>
            <Text variant="lead">{EXTENSION_SIGN_IN_WORDS.pick}</Text>
            <View className="flex-row gap-3">
              {state.request.choices.map((n) => (
                <Button
                  key={n}
                  variant="secondary"
                  className="h-16 flex-1"
                  disabled={busy}
                  onPress={() => void answer(n)}
                  testID={`extension-sign-in-pick-${n}`}
                >
                  <Text className="text-[26px] font-semibold">{String(n)}</Text>
                </Button>
              ))}
            </View>
            <Button variant="ghost" disabled={busy} onPress={() => void answer(null)}>
              {EXTENSION_SIGN_IN_WORDS.notMe}
            </Button>
          </>
        ) : null}
        {state.kind === 'done' ? (
          <>
            <Text variant={state.ok ? 'heading' : 'lead'}>{state.said}</Text>
            <Button variant="secondary" onPress={() => router.replace('/app')}>
              Done
            </Button>
          </>
        ) : null}
      </View>
    </Screen>
  );
}
