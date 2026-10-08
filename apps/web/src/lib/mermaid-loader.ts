type Renderer = typeof import("./mermaid-render");
let pending: Promise<Renderer> | null = null;
let loaded: Renderer | null = null;
let scope = 0;

export function loadDiagramRenderer(): Promise<Renderer> {
  if (!pending) pending = import("./mermaid-render").then(renderer => {
    loaded = renderer;
    renderer.clearDiagramCache(scope);
    return renderer;
  }).catch(error => { pending = null; throw error; });
  return pending;
}

// App owns reset/sign-out invalidation even if every diagram is unmounted.
// Never download the engine just to clear a cache which does not exist yet.
export function clearCachedDiagrams(nextScope: number): void {
  scope = nextScope;
  loaded?.clearDiagramCache(scope);
}
