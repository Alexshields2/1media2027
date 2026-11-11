// No imports: used by client components too.

/**
 * Text ready to paste into WhatsApp: markdown headings and **bold** become WhatsApp *bold*,
 * bullets become •, and runs of blank lines collapse to one.
 */
export function toWhatsApp(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      const h = line.match(/^\s{0,3}#{1,6}\s+(.*)$/);
      if (h) return `*${h[1].replace(/\*\*/g, "").trim()}*`;
      return line.replace(/\*\*(.+?)\*\*/g, "*$1*").replace(/__(.+?)__/g, "_$1_").replace(/^\s*[-*]\s+/, "• ");
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
