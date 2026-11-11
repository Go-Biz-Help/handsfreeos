import { useLocalSearchParams } from 'expo-router';

import { CalendarScreen } from '@/addons/socialcontent/calendar';
import { PostScreen } from '@/addons/socialcontent/own-post';

/**
 * The Calendar of the business's own posts (part 12), at the web's own address; one post opens at
 * `calendar?post=<id>`, as the web's sheet does, on its own screen above the Calendar.
 */
export default function CalendarRoute() {
  const { post } = useLocalSearchParams<{ post?: string }>();
  return post ? <PostScreen key={post} postId={post} /> : <CalendarScreen />;
}
