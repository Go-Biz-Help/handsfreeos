import { Stack } from 'expo-router';
import { useEffect } from 'react';
import { Platform, ScrollView, View } from 'react-native';
import { Uniwind, useCSSVariable, useUniwind } from 'uniwind';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { postResults } from '@/spike/report';

const TOKENS = [
  '--color-background',
  '--color-card',
  '--color-primary',
  '--color-accent',
  '--color-border',
] as const;

/** Spike: one Card and the kit's Buttons in the web's colours, light and dark. */
export default function Kit() {
  const { theme } = useUniwind();
  const values = useCSSVariable([...TOKENS]);

  useEffect(() => {
    void postResults(`kit-${Platform.OS}-${theme}`, {
      theme,
      tokens: Object.fromEntries(TOKENS.map((name, i) => [name, (values as unknown[])[i] ?? null])),
    });
  }, [theme, values]);

  return (
    <ScrollView className="bg-background flex-1" contentContainerClassName="gap-4 p-4" testID="kit">
      <Stack.Screen options={{ title: 'Kit' }} />
      <Card>
        <CardHeader>
          <CardTitle>Maria Lopez</CardTitle>
          <CardDescription>AC replacement · Invoice INV-1042</CardDescription>
        </CardHeader>
        <CardContent className="gap-2">
          <Text>$18,500.50 owed, due Thu, Sep 17</Text>
          <View className="bg-accent rounded-md px-3 py-2">
            <Text className="text-accent-foreground text-sm">Accent soft (color-mix in oklab)</Text>
          </View>
        </CardContent>
        <CardFooter className="gap-2">
          <Button testID="kit-primary">
            <Text>Send payment link</Text>
          </Button>
          <Button variant="outline">
            <Text>Call</Text>
          </Button>
        </CardFooter>
      </Card>
      <View className="flex-row gap-2">
        <Button variant="secondary" onPress={() => Uniwind.setTheme('light')} testID="kit-light">
          <Text>Light</Text>
        </Button>
        <Button variant="secondary" onPress={() => Uniwind.setTheme('dark')} testID="kit-dark">
          <Text>Dark</Text>
        </Button>
        <Button variant="secondary" onPress={() => Uniwind.setTheme('system')} testID="kit-system">
          <Text>System</Text>
        </Button>
      </View>
      <Text className="text-muted-foreground text-sm" testID="kit-theme">
        Theme: {theme} ·{' '}
        {TOKENS.map((name, i) => `${name.slice(8)} ${String((values as unknown[])[i])}`).join(
          ' · ',
        )}
      </Text>
    </ScrollView>
  );
}
