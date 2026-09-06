// Auto-load every extension folder. Adding `ext/<name>/index.ts` is enough;
// this file never needs editing. Eager so registration precedes first render.
import.meta.glob("./*/index.ts", { eager: true });

export * from "./registry";
