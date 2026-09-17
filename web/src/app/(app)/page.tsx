import { ChatView } from "@/components/chat/chat-view";

/**
 * Ask — a new conversation.
 *
 * The surface itself is client-side: the session, the workspace and the
 * transcript all resolve in the browser. Nothing protected is rendered until
 * `AuthGate` has resolved them (see the layout).
 */
export default function AskPage() {
  return <ChatView />;
}
