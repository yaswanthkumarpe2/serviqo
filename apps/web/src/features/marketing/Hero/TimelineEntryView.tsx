import { MessageBubble, SystemLine, TypingIndicator } from "@/components/ui/MessageBubble";

import type { TimelineEntry } from "@/hooks/useChatDemo";

export function TimelineEntryView({ entry }: { entry: TimelineEntry }) {
  if (entry.kind === "typing") return <TypingIndicator />;
  if (entry.kind === "system") return <SystemLine>{entry.text}</SystemLine>;
  return (
    <MessageBubble variant={entry.variant} tag={entry.tag} meta={entry.meta}>
      {entry.text}
    </MessageBubble>
  );
}
