export interface AttachmentHandoff {
  name: string;
  size: number;
  status: "uploading" | "done" | "error";
  path?: string;
  type?: string;
}

export type ImageAttachmentKind = "vision" | "large-image" | "other-image" | "file";

const VISION_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);
const VISION_EXT = /\.(?:png|jpe?g|webp)$/i;
const IMAGE_EXT = /\.(?:avif|bmp|gif|heic|heif|png|jpe?g|svg|tiff?|webp)$/i;
const VISION_SOURCE_BYTE_CAP = 20 * 1024 * 1024;

export const humanSize = (n: number): string =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

export function imageAttachmentKind(a: Pick<AttachmentHandoff, "name" | "path" | "type" | "size">): ImageAttachmentKind {
  const mime = (a.type ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const namedVision = VISION_EXT.test(a.path ?? a.name);
  if (VISION_MIMES.has(mime) || namedVision) return a.size <= VISION_SOURCE_BYTE_CAP ? "vision" : "large-image";
  return mime.startsWith("image/") || IMAGE_EXT.test(a.path ?? a.name) ? "other-image" : "file";
}

function attachmentLine(a: AttachmentHandoff & { path: string }): string {
  return `- ${a.path} (${[a.type, humanSize(a.size)].filter(Boolean).join(", ")})`;
}

/** Prompt paths are grouped by the core operation that can safely consume them.
 * `read_image` is explicit because pixel disclosure has its own approval gate. */
export function attachmentBlock(list: AttachmentHandoff[]): string {
  const done = list.filter((a): a is AttachmentHandoff & { path: string } => a.status === "done" && !!a.path);
  if (done.length === 0) return "";
  const vision = done.filter((a) => imageAttachmentKind(a) === "vision");
  const largeImages = done.filter((a) => imageAttachmentKind(a) === "large-image");
  const otherImages = done.filter((a) => imageAttachmentKind(a) === "other-image");
  const files = done.filter((a) => imageAttachmentKind(a) === "file");
  const sections: string[] = [];
  if (vision.length) {
    sections.push(
      `Attached image${vision.length > 1 ? "s" : ""} ready for native vision:\n${vision.map(attachmentLine).join("\n")}\nTo inspect pixels, call read_image(path) for each needed image (maximum two per turn). It may request approval before sanitized pixels are sent to the active model provider. If the model reports that image input is unavailable, use explicit OCR/conversion instead.`,
    );
  }
  if (largeImages.length) {
    sections.push(
      `Attached image${largeImages.length > 1 ? "s" : ""} over read_image's 20 MiB source limit:\n${largeImages.map(attachmentLine).join("\n")}\nResize or convert before calling read_image, or use OCR.`,
    );
  }
  if (otherImages.length) {
    sections.push(
      `Attached image${otherImages.length > 1 ? "s" : ""} not accepted directly by read_image:\n${otherImages.map(attachmentLine).join("\n")}\nConvert one intended static frame explicitly to PNG, JPEG, or WebP before read_image, or use OCR.`,
    );
  }
  if (files.length) {
    sections.push(
      `Attached file${files.length > 1 ? "s" : ""} in the workspace. Inspect with format-aware tools (read_file is text-only):\n${files.map(attachmentLine).join("\n")}`,
    );
  }
  return sections.join("\n\n");
}
