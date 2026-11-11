// Client logos, matched by client name. Files in public/client-logos come from the
// client pages in the old Notion OS (downloaded once; Notion's own links expire).
// Clients whose Notion icon was a website favicon use Google's favicon service.

const favicon = (domain: string) => `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;

/** `dark: true` = a light/white logo on a clear background, so it needs a dark tile. */
export type Logo = { src: string; dark?: boolean };

const LOGOS: Record<string, Logo> = {
  "apex attics": { src: "/client-logos/apex-attics.png" },
  "crosbie coaching": { src: "/client-logos/crosbie-coaching.png", dark: true },
  "marlor bathrooms": { src: "/client-logos/marlor-bathrooms.png" },
  "new heights attics and construction": { src: "/client-logos/new-heights-attics.png", dark: true },
  "snag list steve": { src: "/client-logos/snag-list-steve.png" },
  spraywise: { src: "/client-logos/spraywise.png", dark: true },
  "good brother": { src: favicon("goodbrother.ie") },
  "riviera kitchens": { src: favicon("rivierakitchens.ie") },
  "sw heating solution": { src: favicon("swheatingsolutions.ie") },
  "the golden ticket co": { src: favicon("thegoldenticketco.com") },
  "active paving": { src: favicon("activepaving.ie") },
  "deluxe garden rooms": { src: favicon("deluxegardenrooms.ie") },
};

const norm = (name: string) => name.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").trim();

/** Logo for a client name, or null (show initials instead). */
export function clientLogo(name: string): Logo | null {
  return LOGOS[norm(name)] ?? null;
}

/** Up to two initials, e.g. "Beyond Jitsu" -> "BJ". */
export function initials(name: string): string {
  const words = name.replace(/[^A-Za-z0-9 ]+/g, " ").trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? "?").slice(0, 2)).toUpperCase();
}
