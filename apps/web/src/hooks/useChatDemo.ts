import { useEffect, useRef, useState } from "react";

import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";

export interface BubbleEntry {
  id: string;
  kind: "bubble";
  variant: "in" | "out" | "ai";
  tag?: string;
  text: string;
  meta?: string;
}

export interface SystemEntry {
  id: string;
  kind: "system";
  text: string;
}

export interface TypingEntry {
  id: string;
  kind: "typing";
}

export type TimelineEntry = BubbleEntry | SystemEntry | TypingEntry;

export interface AiBrief {
  summary: string;
  intent: string;
  sentiment: string;
  suggestedAction: string;
  knowledgeUsed: string;
  confidence: number;
}

export interface ChatDemoState {
  customerTimeline: TimelineEntry[];
  agentTimeline: TimelineEntry[];
  aiBrief: AiBrief | null;
}

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

const EMPTY_STATE: ChatDemoState = { customerTimeline: [], agentTimeline: [], aiBrief: null };

const AI_BRIEF: AiBrief = {
  summary:
    "Customer paid ₹2,400 via UPI but wallet balance is still zero. Payment may be successful but not yet reconciled.",
  intent: "Payment issue",
  sentiment: "Concerned",
  suggestedAction: "Verify transaction status with billing",
  knowledgeUsed: "Payment Reconciliation Policy",
  confidence: 92,
};

/** The single static frame shown under `prefers-reduced-motion` — a pure constant, never set via an effect. */
const REDUCED_MOTION_STATE: ChatDemoState = {
  customerTimeline: [
    {
      id: "reduced-c-1",
      kind: "bubble",
      variant: "out",
      text: "My payment was deducted but my wallet still shows zero.",
      meta: "12:40 ✓✓",
    },
    {
      id: "reduced-c-2",
      kind: "bubble",
      variant: "ai",
      tag: "Serviqo AI",
      text: "That needs a specialist to verify with billing directly.",
      meta: "12:41",
    },
    { id: "reduced-c-3", kind: "system", text: "ananya joined the conversation" },
    {
      id: "reduced-c-4",
      kind: "bubble",
      variant: "in",
      tag: "Ananya",
      text: "I can see the ₹2,400 charge. Ticket SRV-10482 is open — you'll be credited within 2 hours.",
      meta: "12:43",
    },
  ],
  agentTimeline: [
    {
      id: "reduced-a-1",
      kind: "bubble",
      variant: "in",
      text: "My payment was deducted but my wallet still shows zero.",
      meta: "12:40",
    },
  ],
  aiBrief: AI_BRIEF,
};

/**
 * Reproduces the prototype's scripted two-pane demo: a customer message,
 * an AI attempt, a handoff to a human agent, and the private AI brief that
 * only the agent's pane sees. Loops on completion; short-circuits to the
 * static `REDUCED_MOTION_STATE` frame under `prefers-reduced-motion`
 * without ever animating, matching the original.
 */
export function useChatDemo(): ChatDemoState {
  const reducedMotion = usePrefersReducedMotion();
  const [animatedState, setAnimatedState] = useState<ChatDemoState>(EMPTY_STATE);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    if (reducedMotion) {
      for (const timer of timersRef.current) clearTimeout(timer);
      timersRef.current = [];
      return;
    }

    function clearTimers() {
      for (const timer of timersRef.current) clearTimeout(timer);
      timersRef.current = [];
    }

    function at(ms: number, fn: () => void) {
      timersRef.current.push(setTimeout(fn, ms));
    }

    function addCustomer(entry: TimelineEntry) {
      setAnimatedState((prev) => ({ ...prev, customerTimeline: [...prev.customerTimeline, entry] }));
    }
    function addAgent(entry: TimelineEntry) {
      setAnimatedState((prev) => ({ ...prev, agentTimeline: [...prev.agentTimeline, entry] }));
    }
    function removeCustomer(id: string) {
      setAnimatedState((prev) => ({
        ...prev,
        customerTimeline: prev.customerTimeline.filter((e) => e.id !== id),
      }));
    }
    function removeAgent(id: string) {
      setAnimatedState((prev) => ({ ...prev, agentTimeline: prev.agentTimeline.filter((e) => e.id !== id) }));
    }

    function play() {
      clearTimers();

      at(0, () => setAnimatedState(EMPTY_STATE));

      at(300, () => {
        addCustomer({
          id: nextId("c"),
          kind: "bubble",
          variant: "out",
          text: "My payment was deducted but my wallet still shows zero.",
          meta: "12:40 ✓✓",
        });
        addAgent({
          id: nextId("a"),
          kind: "bubble",
          variant: "in",
          text: "My payment was deducted but my wallet still shows zero.",
          meta: "12:40",
        });
      });

      at(1600, () => {
        const cId = nextId("c-typing");
        const aId = nextId("a-typing");
        addCustomer({ id: cId, kind: "typing" });
        addAgent({ id: aId, kind: "typing" });
        at(1500, () => {
          removeCustomer(cId);
          removeAgent(aId);
        });
      });

      at(3300, () => {
        const text = "I can check that for you. Could you share the transaction ID?";
        addCustomer({ id: nextId("c"), kind: "bubble", variant: "ai", tag: "Serviqo AI", text, meta: "12:41" });
        addAgent({ id: nextId("a"), kind: "bubble", variant: "ai", tag: "Serviqo AI", text, meta: "12:41" });
      });

      at(4900, () => {
        addCustomer({
          id: nextId("c"),
          kind: "bubble",
          variant: "out",
          text: "4471-08832, and it's still not showing.",
          meta: "12:42 ✓✓",
        });
        addAgent({
          id: nextId("a"),
          kind: "bubble",
          variant: "in",
          text: "4471-08832, and it's still not showing.",
          meta: "12:42",
        });
      });

      at(6300, () => {
        const cId = nextId("c-typing");
        const aId = nextId("a-typing");
        addCustomer({ id: cId, kind: "typing" });
        addAgent({ id: aId, kind: "typing" });
        at(1300, () => {
          removeCustomer(cId);
          removeAgent(aId);
        });
      });

      at(7700, () => {
        const text =
          "That transaction hasn't settled on our end yet — this needs a specialist to verify with billing directly.";
        addCustomer({ id: nextId("c"), kind: "bubble", variant: "ai", tag: "Serviqo AI", text, meta: "12:42" });
        addAgent({ id: nextId("a"), kind: "bubble", variant: "ai", tag: "Serviqo AI", text, meta: "12:42" });
      });

      at(9400, () => {
        addCustomer({ id: nextId("c"), kind: "system", text: "connecting you with billing support" });
        addAgent({ id: nextId("a"), kind: "system", text: "conversation assigned to ananya rao" });
      });

      at(10700, () => {
        addCustomer({ id: nextId("c"), kind: "system", text: "ananya joined the conversation" });
      });

      at(11400, () => {
        setAnimatedState((prev) => ({ ...prev, aiBrief: AI_BRIEF }));
      });

      at(13200, () => {
        const cId = nextId("c-typing");
        addCustomer({ id: cId, kind: "typing" });
        at(1300, () => removeCustomer(cId));
      });

      at(14600, () => {
        const text =
          "I can see the ₹2,400 charge. I've opened ticket SRV-10482 — you'll be credited within 2 hours.";
        addCustomer({ id: nextId("c"), kind: "bubble", variant: "in", tag: "Ananya", text, meta: "12:43" });
        addAgent({ id: nextId("a"), kind: "bubble", variant: "out", text, meta: "12:43 ✓✓" });
      });

      at(16400, () => {
        addCustomer({
          id: nextId("c"),
          kind: "bubble",
          variant: "out",
          text: "Thank you, appreciate the quick help.",
          meta: "12:44 ✓✓",
        });
        addAgent({
          id: nextId("a"),
          kind: "bubble",
          variant: "in",
          text: "Thank you, appreciate the quick help.",
          meta: "12:44",
        });
      });

      at(20500, play);
    }

    play();
    return clearTimers;
  }, [reducedMotion]);

  return reducedMotion ? REDUCED_MOTION_STATE : animatedState;
}
