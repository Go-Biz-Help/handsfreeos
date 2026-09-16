import { Redirect, Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';

import { CASES } from '@/self-test/cases';
import { runCase, type CaseResult } from '@/self-test/runner';
import { environment, postResults } from '@/spike/report';

/** Development builds only: runs @hfos/core's time-zone and quiet-hours cases on this phone's engine. */
export default function SelfTest() {
  const [results, setResults] = useState<CaseResult[] | null>(null);
  const [sent, setSent] = useState<boolean | null>(null);

  useEffect(() => {
    if (!__DEV__) return;
    const run = CASES.map(runCase);
    setResults(run);
    void postResults(`self-test-${Platform.OS}`, { results: run }).then(setSent);
  }, []);

  if (!__DEV__) return <Redirect href="/" />;

  const passed = results?.filter((r) => r.ok).length ?? 0;
  const env = environment();
  return (
    <ScrollView contentContainerStyle={styles.page} testID="self-test">
      <Stack.Screen options={{ title: 'Self-test' }} />
      <Text style={styles.summary} testID="self-test-summary">
        {results ? `${passed} of ${results.length} cases passed` : 'Running…'}
      </Text>
      <Text style={styles.meta}>
        {env.platform} {env.osVersion} · Hermes{' '}
        {String(env.hermes?.['OSS Release Version'] ?? 'unknown')} · {env.deviceTimeZone} ·{' '}
        {sent === null ? 'sending' : sent ? 'sent to spike server' : 'not sent'}
      </Text>
      {[...(results ?? [])]
        .sort((a, b) => Number(a.ok) - Number(b.ok))
        .map((r) => (
          <View key={`${r.group}/${r.name}`} style={styles.case}>
            <Text style={[styles.status, { color: r.ok ? '#008743' : '#c43335' }]}>
              {r.ok ? 'PASS' : 'FAIL'} · {r.group}
            </Text>
            <Text style={styles.name}>{r.name}</Text>
            {r.error ? <Text style={styles.failure}>Threw {r.error}</Text> : null}
            {r.failures.map((f) => (
              <Text key={f.label} style={styles.failure}>
                {f.label}: expected {f.expected}, got {f.actual}
              </Text>
            ))}
          </View>
        ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, gap: 10 },
  summary: { fontSize: 20, fontWeight: '700', color: '#191d25' },
  meta: { fontSize: 12, color: '#5b616a' },
  case: {
    gap: 2,
    paddingVertical: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: '#d2d6dd',
  },
  status: { fontSize: 12, fontWeight: '700' },
  name: { fontSize: 14, color: '#191d25' },
  failure: { fontSize: 12, color: '#862726', fontFamily: 'Menlo' },
});
