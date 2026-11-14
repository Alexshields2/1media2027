// Icons for chat agents and the chat UI (24px stroke paths, like app/_components/icons.tsx).

const PATHS = {
  spark: "M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8",
  box: "M21 8 12 3 3 8v8l9 5 9-5zM3 8l9 5 9-5M12 13v8",
  chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  board: "M3 4h18v16H3zM9 4v16M15 4v16M5.5 8h1M11.5 8h1M17.5 8h1M11.5 12h1",
  euro: "M18 6.5A7 7 0 1 0 18 17.5M4 10h10M4 14h10",
  handshake: "M11 17l2 2a1.4 1.4 0 0 0 2-2M14 14l2.5 2.5a1.4 1.4 0 0 0 2-2L15 11M8 15l3 3M2 12l4-4 4 1 3-3 4 1 5 5-3 3M2 12l5 5",
  inbox: "M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z",
  pulse: "M22 12h-4l-3 8L9 4l-3 8H2",
  chat: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
  users: "M16 20v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 20v-1a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  calendar: "M3 5h18v16H3zM3 10h18M8 3v4M16 3v4",
  megaphone: "M3 11v2a1 1 0 0 0 1 1h3l6 4V6L7 10H4a1 1 0 0 0-1 1zM17 9a3 3 0 0 1 0 6",
  doc: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5",
  star: "M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z",
  // UI
  plus: "M12 5v14M5 12h14",
  menu: "M3 6h18M3 12h18M3 18h18",
  close: "M18 6 6 18M6 6l12 12",
  clip: "M21.4 11.1l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5",
  send: "M12 19V5M5 12l7-7 7 7",
  stop: "M7 7h10v10H7z",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  refresh: "M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5",
  pencil: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z",
  trash: "M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14",
  gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z",
  check: "M5 12l5 5L20 7",
  chevron: "M9 6l6 6-6 6",
  globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18",
  lock: "M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4",
  file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6",
  alert: "M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
} as const;

export type ChatIconName = keyof typeof PATHS;

/** Icons an agent can have (the picker on the settings page). */
export const AGENT_ICONS: ChatIconName[] = ["spark", "box", "chart", "board", "euro", "handshake", "inbox", "pulse", "chat", "users", "calendar", "megaphone", "doc", "star"];

export function ChatIcon({ name, className = "size-4" }: { name: ChatIconName | string; className?: string }) {
  const d = PATHS[name as ChatIconName] ?? PATHS.spark;
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d={d} />
    </svg>
  );
}

/** An agent's icon in a brand-tinted tile. */
export function AgentAvatar({ icon, size = "md" }: { icon: string; size?: "sm" | "md" | "lg" }) {
  const box = size === "lg" ? "size-14 rounded-2xl" : size === "sm" ? "size-7 rounded-lg" : "size-9 rounded-xl";
  const glyph = size === "lg" ? "size-7" : size === "sm" ? "size-3.5" : "size-4.5";
  return (
    <span className={`grid shrink-0 place-items-center border border-brand/25 bg-brand-soft text-brand-light ${box}`}>
      <ChatIcon name={icon} className={glyph} />
    </span>
  );
}
