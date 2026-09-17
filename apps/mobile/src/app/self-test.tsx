import { Redirect, Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { testToolsEnabled } from '@/lib/config';
import { CASES } from '@/self-test/cases';
import { environment } from '@/self-test/environment';
import { runCase, type CaseResult } from '@/self-test/runner';

/**
 * Development and test builds only: runs @hfos/core's time-zone and quiet-hours cases on this phone's engine. A Maestro
 * flow reads "N of N cases passed" on both phones.
 */
export default function SelfTest() {
  const [results, setResults] = useState<CaseResult[] | null>(null);

  useEffect(() => {
    if (testToolsEnabled) setResults(CASES.map(runCase));
  }, []);

  if (!testToolsEnabled) return <Redirect href="/" />;

  const passed = results?.filter((r) => r.ok).length ?? 0;
  const env = environment();
  return (
    <ScrollView className="flex-1 bg-bg" contentContainerClassName="gap-2.5 p-4" testID="self-test">
      <Stack.Screen options={{ title: 'Self-test' }} />
      <Text className="text-xl font-bold" testID="self-test-summary">
        {results ? `${passed} of ${results.length} cases passed` : 'Running…'}
      </Text>
      <Text className="text-xs text-text-2">
        {env.platform} {env.osVersion} · Hermes{' '}
        {String(env.hermes?.['OSS Release Version'] ?? 'unknown')} · {env.deviceTimeZone}
      </Text>
      {[...(results ?? [])]
        .sort((a, b) => Number(a.ok) - Number(b.ok))
        .map((r) => (
          <View key={`${r.group}/${r.name}`} className="gap-0.5 border-t border-border py-1.5">
            <Text
              className={
                r.ok ? 'text-xs font-bold text-success-text' : 'text-xs font-bold text-danger-text'
              }
            >
              {r.ok ? 'PASS' : 'FAIL'} · {r.group}
            </Text>
            <Text className="text-sm">{r.name}</Text>
            {r.error ? (
              <Text className="font-mono text-xs text-danger-text">Threw {r.error}</Text>
            ) : null}
            {r.failures.map((f) => (
              <Text key={f.label} className="font-mono text-xs text-danger-text">
                {f.label}: expected {f.expected}, got {f.actual}
              </Text>
            ))}
            {r.notes.map((note) => (
              <Text key={note} className="text-xs text-text-2" testID="self-test-note">
                {note}
              </Text>
            ))}
          </View>
        ))}
    </ScrollView>
  );
}
