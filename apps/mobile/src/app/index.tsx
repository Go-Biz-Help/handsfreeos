import { createApiClient } from '@hfos/api-client';
import { ATTENTION_KIND_LABELS, CORE_VERSION, money, whenLabel } from '@hfos/core';
import { Link, Stack, type Href } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

// Spike: prove the shared packages load as raw TypeScript on the phone.
const api = createApiClient({ baseUrl: 'http://localhost:4000', getToken: () => null });
const FIRST_VISIT = Date.parse('2026-09-17T15:00:00Z');

const SCREENS: { href: Href; label: string; devOnly?: boolean }[] = [
  { href: '/self-test', label: 'Self-test (time zones on this phone)', devOnly: true },
  { href: '/database', label: 'Encrypted database and PowerSync' },
  { href: '/streaming', label: 'Streaming responses' },
  { href: '/kit', label: 'Kit: Button and Card' },
];

export default function Home() {
  const rows: [string, string][] = [
    ['@hfos/core version', CORE_VERSION],
    ['money(1850050)', money(1850050)],
    ['money(1850000)', money(1850000)],
    ['Hot lead label', ATTENTION_KIND_LABELS.hot_lead],
    ['whenLabel (Chicago)', whenLabel(FIRST_VISIT, 'America/Chicago')],
    ['@hfos/api-client', typeof api.POST === 'function' ? 'client ready' : 'missing'],
  ];
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Stack.Screen options={{ title: 'HandsFreeOS' }} />
      {rows.map(([label, value]) => (
        <View key={label} style={styles.row} testID={`home-${label}`}>
          <Text style={styles.label}>{label}</Text>
          <Text style={styles.value}>{value}</Text>
        </View>
      ))}
      {SCREENS.filter((s) => __DEV__ || !s.devOnly).map((s) => (
        <Link key={String(s.href)} href={s.href} asChild>
          <Pressable style={styles.link}>
            <Text style={styles.linkText}>{s.label}</Text>
          </Pressable>
        </Link>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, gap: 8 },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  label: { color: '#5b616a', fontSize: 15 },
  value: { color: '#191d25', fontSize: 15, fontWeight: '600' },
  link: {
    marginTop: 8,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 8,
    backgroundColor: '#2d69d8',
  },
  linkText: { color: '#ffffff', fontSize: 15, fontWeight: '600' },
});
