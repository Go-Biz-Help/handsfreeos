import { fetch as expoFetch } from 'expo/fetch';
import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';

import { postResults, SPIKE_SERVER } from '@/spike/report';

const CHUNKS = 8;
const DELAY_MS = 400;

interface Run {
  readonly name: string;
  readonly ok: boolean;
  readonly notes: readonly string[];
  /** Milliseconds after the request started that each read() returned, with how many events it completed. */
  readonly arrivals: readonly { at: number; bytes: number; events: number }[];
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** The Assistant's reader, reduced: POST with headers, read the body as it arrives, split server-sent events. */
async function stream(name: string, doFetch: Fetch, abortAfter?: number): Promise<Run> {
  const notes: string[] = [];
  const arrivals: { at: number; bytes: number; events: number }[] = [];
  const events: { i: number; header: string | null; echo: string | null; text: string }[] = [];
  const controller = new AbortController();
  const started = Date.now();
  let done = false;
  let ok = true;
  const fail = (why: string) => {
    ok = false;
    notes.push(`FAIL ${why}`);
  };
  try {
    const res = await doFetch(`${SPIKE_SERVER}/stream?chunks=${CHUNKS}&delay=${DELAY_MS}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-spike': 'phone' },
      body: JSON.stringify({ question: 'How much does Maria owe?' }),
      signal: controller.signal,
    });
    notes.push(
      `status ${res.status} ${res.headers.get('content-type')} after ${Date.now() - started} ms`,
    );
    if (!res.body) {
      fail('no response body stream');
      return { name, ok, notes, arrivals };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done: finished } = await reader.read();
      if (finished) break;
      buffer += decoder.decode(value, { stream: true });
      let completed = 0;
      for (let cut = buffer.indexOf('\n\n'); cut >= 0; cut = buffer.indexOf('\n\n')) {
        const raw = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        if (raw.startsWith('event: done')) done = true;
        else if (raw.startsWith('data: ')) {
          events.push(JSON.parse(raw.slice(6)));
          completed += 1;
        }
      }
      arrivals.push({ at: Date.now() - started, bytes: value.byteLength, events: completed });
      if (abortAfter !== undefined && events.length >= abortAfter) {
        const abortedAt = Date.now();
        controller.abort();
        const settled = await Promise.race([
          reader.read().then(
            (r) => `read resolved (done=${String(r.done)})`,
            (e: unknown) => `read rejected (${e instanceof Error ? e.name : String(e)})`,
          ),
          new Promise<string>((resolve) => setTimeout(() => resolve('HUNG for 3 s'), 3000)),
        ]);
        const took = Date.now() - abortedAt;
        notes.push(`aborted after ${events.length} events: ${settled} in ${took} ms`);
        if (settled.startsWith('HUNG')) fail('abort left the reader hanging');
        return { name, ok, notes, arrivals };
      }
    }
  } catch (e) {
    fail(`threw ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
    return { name, ok, notes, arrivals };
  }
  if (events.length !== CHUNKS || !done)
    fail(`got ${events.length} of ${CHUNKS} events, done=${String(done)}`);
  if (events.some((e, i) => e.i !== i)) fail('events out of order');
  if (events[0]?.header !== 'phone') fail(`header not sent (${String(events[0]?.header)})`);
  if (!events[0]?.echo?.includes('Maria')) fail('POST body not sent');
  if (events[0]?.text !== 'Chunk 0 — café ✓')
    fail(`text decoded as ${JSON.stringify(events[0]?.text)}`);
  const reads = arrivals.filter((a) => a.events > 0);
  const spread = (reads.at(-1)?.at ?? 0) - (reads[0]?.at ?? 0);
  notes.push(
    `${arrivals.length} reads; events arrived at ${reads.map((a) => a.at).join(', ')} ms (spread ${spread} ms)`,
  );
  if (reads.length < CHUNKS - 2 || spread < (CHUNKS - 2) * DELAY_MS)
    fail('body was buffered, not streamed');
  return { name, ok, notes, arrivals };
}

export default function Streaming() {
  const [runs, setRuns] = useState<Run[] | null>(null);

  useEffect(() => {
    void (async () => {
      const out = [
        await stream('expo/fetch, POST with headers', expoFetch as unknown as Fetch),
        await stream('global fetch, POST with headers', fetch),
        await stream('expo/fetch, abort after 3 events', expoFetch as unknown as Fetch, 3),
      ];
      setRuns(out);
      void postResults(`streaming-${Platform.OS}`, {
        globalFetchIsExpoFetch: fetch === (expoFetch as unknown),
        runs: out,
      });
    })();
  }, []);

  return (
    <ScrollView contentContainerStyle={styles.page} testID="streaming">
      <Stack.Screen options={{ title: 'Streaming' }} />
      <Text style={styles.summary} testID="streaming-summary">
        {runs ? `${runs.filter((r) => r.ok).length} of ${runs.length} runs passed` : 'Streaming…'}
      </Text>
      {runs?.map((r) => (
        <View key={r.name} style={styles.run}>
          <Text style={[styles.status, { color: r.ok ? '#008743' : '#c43335' }]}>
            {r.ok ? 'PASS' : 'FAIL'}
          </Text>
          <Text style={styles.name}>{r.name}</Text>
          {r.notes.map((n) => (
            <Text key={n} style={styles.note}>
              {n}
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
  run: {
    gap: 2,
    paddingVertical: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: '#d2d6dd',
  },
  status: { fontSize: 12, fontWeight: '700' },
  name: { fontSize: 14, color: '#191d25' },
  note: { fontSize: 12, color: '#5b616a', fontFamily: 'Menlo' },
});
