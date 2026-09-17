import { ChatView } from "@/components/chat/chat-view";

/**
 * Existing conversation.
 *
 * The id only locates the conversation; Row Level Security decides whether the
 * transcript is readable, so an id from another workspace simply yields an
 * empty (or denied) read rather than leaking anything.
 */
export default async function ConversationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ChatView key={id} conversationId={id} />;
}
