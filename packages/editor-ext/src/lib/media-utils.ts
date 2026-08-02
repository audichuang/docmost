import { Editor } from "@tiptap/core";

/**
 * Last-mile rewrite applied to every media src the node views render.
 *
 * The client installs one at startup to append the short-lived R2 access
 * token; the server (collaboration.util.ts tiptapExtensions) installs none,
 * so normalizeFileUrl there behaves exactly as it always has.
 *
 * ponytail: one module-level hook instead of an option threaded through
 * image/video/audio/drawio/excalidraw — all five call normalizeFileUrl, so
 * their nine call sites need no change at all. Move it into extension
 * options if a second editor instance ever needs a different transform.
 */
let fileUrlTransformer: ((src: string) => string) | null = null;

export function setFileUrlTransformer(fn: ((src: string) => string) | null) {
  fileUrlTransformer = fn;
}

export function normalizeFileUrl(src: string): string {
  if (!src) return "";
  const normalized = src.startsWith("/files/") ? "/api" + src : src;
  return fileUrlTransformer ? fileUrlTransformer(normalized) : normalized;
}

export type UploadFn = (
  file: File,
  editor: Editor,
  pos: number,
  pageId: string,
  // only applicable to file attachments
  allowMedia?: boolean,
) => void;

export interface MediaUploadOptions {
  validateFn?: (file: File, allowMedia?: boolean) => void;
  onUpload: (file: File, pageId: string) => Promise<any>;
}
