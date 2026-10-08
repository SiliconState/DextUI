// Pure checks after SVG sanitization. CSS escapes/imports/resources are not
// needed by trusted Mermaid's generated diagram CSS; only fragment paints are.
export function unsafeDiagramCss(css: string): boolean {
  if (/\\|@(?:import|font-face)|(?:https?:|data:|javascript:)|(?:image-set|expression)\s*\(/i.test(css)) return true;
  const stripped = css.replace(/url\(\s*(["']?)(#[\w:.-]+)\1\s*\)/gi, "");
  return /url\s*\(/i.test(stripped);
}

export function svgDimensions(viewBox: string | null, widthAttr: string | null, heightAttr: string | null): { width: number; height: number } {
  let width: number, height: number;
  if (viewBox !== null) {
    const box = viewBox.trim().split(/[ ,]+/).map(Number);
    if (box.length !== 4 || !box.every(Number.isFinite)) throw new Error("Diagram viewBox is invalid.");
    width = box[2]!; height = box[3]!;
  } else {
    width = Number(widthAttr); height = Number(heightAttr);
  }
  if (!(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height)) || width > 20000 || height > 20000 || width * height > 16_000_000) throw new Error("Diagram dimensions exceed the display limit.");
  return { width, height };
}
