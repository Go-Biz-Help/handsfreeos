import * as React from 'react';
import { View } from 'react-native';

import { TextClassContext } from '@/components/ui/text';
import { cn } from '@/lib/utils';

/** The web's card: the card colour, a hairline border and the 12 px radius. */
function Card({ className, ...props }: React.ComponentProps<typeof View>) {
  return (
    <TextClassContext.Provider value="text-text">
      <View
        className={cn('overflow-hidden rounded-card border border-border bg-card', className)}
        {...props}
      />
    </TextClassContext.Provider>
  );
}

export { Card };
