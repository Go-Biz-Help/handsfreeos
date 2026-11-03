import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import * as React from 'react';

import { Text } from '@/components/ui/text';

/**
 * The post above a comment, on Today and in Waiting for you (decision 141), as the web's (apps/web's post-quote.tsx):
 * its first words, and when HandsFreeOS cut them short, **More** right after them, which shows the whole post in place;
 * **Less** folds it back. A server from before it sends no whole post, and the start shows alone, as it did.
 */
export function PostQuote({
  post,
  whole,
  className,
  testID,
}: {
  /** The post's first words, as HandsFreeOS cut them. */
  post: string;
  /** The whole post, when `post` is cut short. */
  whole?: string | null;
  className: string;
  testID: string;
}) {
  const [open, setOpen] = React.useState(false);
  if (!whole || whole === post)
    return (
      <Text className={className} testID={testID}>
        {post}
      </Text>
    );
  return (
    <Text className={className} testID={testID}>
      {open ? whole : post}{' '}
      <Text
        className="font-medium text-accent-text"
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((o) => !o)}
        suppressHighlighting
        testID={`${testID}-more`}
      >
        {open ? W.postLess : W.postMore}
      </Text>
    </Text>
  );
}
