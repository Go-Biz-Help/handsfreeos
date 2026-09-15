import { ChatUnavailable } from '@/components/chat-widget/chat-parts';

/** An unknown key, or one "New key" replaced: the chat window says so plainly. */
export default function ChatNotFound() {
  return <ChatUnavailable kind="missing" />;
}
