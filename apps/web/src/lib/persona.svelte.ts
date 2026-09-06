// Onboarding persona: who the gallery is for. Persisted per browser; the
// host never sees it. Grouping keeps every installed pack visible — consumer
// personas get their tools first and "developer tools" collapsed, developers
// get the reverse. Nothing is hidden, only folded.
import type { PackInfo } from "@dextui/protocol";
import { app } from "./state.svelte";
export { packTitle } from "./display";

export type Persona = "accountant" | "business" | "developer";

export const PERSONAS: { id: Persona; title: string; blurb: string; glyph: string }[] = [
  { id: "accountant", title: "I keep the books", blurb: "Receipts, reconciliation, month-end, tax packages.", glyph: "▤" },
  { id: "business", title: "I run a business", blurb: "Invoices, cash flow, follow-ups, a team of helpers.", glyph: "◆" },
  { id: "developer", title: "I build software", blurb: "Research loops, browsers, crews, pack tooling.", glyph: "⌘" },
];

const KEY = "dextui.persona";

function load(): Persona | null {
  const v = localStorage.getItem(KEY);
  return v === "accountant" || v === "business" || v === "developer" ? v : null;
}

export const persona = $state({ id: load() as Persona | null, picking: false });

export function setPersona(id: Persona | null): void {
  persona.id = id;
  persona.picking = false;
  if (id) localStorage.setItem(KEY, id);
  else localStorage.removeItem(KEY);
}

export function personaTitle(id: Persona | null): string {
  return PERSONAS.find((p) => p.id === id)?.title ?? "Everyone";
}

/** Plain-language requirement text for consumer personas. */
export function humanRequirement(r: string, id: Persona | null = persona.id): string {
  if (id === "developer") return r;
  if (r.startsWith("approval:")) return "needs permission to write files";
  if (r === "chromium" || r === "lightpanda") return "needs a browser installed";
  if (r.startsWith("connector:")) return `needs a ${r.slice(10)} connection`;
  return `needs ${r}`;
}

function audience(p: PackInfo): string[] {
  const a = p.ui.personas ?? [];
  return a.length === 0 ? ["everyone"] : a;
}

function forPersona(p: PackInfo, id: Persona): boolean {
  const a = audience(p);
  return a.includes("everyone") || a.includes(id);
}

export interface GalleryGroups {
  /** Curated cards for this persona (gallery: true and audience matches). */
  forYou: PackInfo[];
  /** Curated cards for other personas, folded under a heading. */
  folded: { title: string; packs: PackInfo[] };
  /** Everything not curated at all. */
  others: PackInfo[];
}

export function galleryGroups(id: Persona | null = persona.id): GalleryGroups {
  const curated = app.packs.filter((p) => p.ui.gallery);
  const others = app.packs.filter((p) => !p.ui.gallery);
  if (!id) return { forYou: curated, folded: { title: "", packs: [] }, others };
  const forYou = curated.filter((p) => forPersona(p, id));
  const rest = curated.filter((p) => !forPersona(p, id));
  const title = id === "developer" ? "Business tools" : "Developer tools";
  return { forYou, folded: { title, packs: rest }, others };
}
