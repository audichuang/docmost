import * as path from 'path';
import { load } from 'cheerio';

export const MARKDOWN_RE = /\.mdx?$/i;
export const INDEX_RE = /^(readme|index)\.mdx?$/i;

export function normalizeDir(dir?: string): string {
  if (!dir) return '';
  return dir.replace(/^\/+|\/+$/g, '');
}

export function titleFromSegment(segment: string): string {
  return segment.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Resolve a link found inside a markdown file to a repo-relative path.
 * Returns null for anything that is not a file inside this repo.
 */
export function resolveRepoPath(filePath: string, href: string): string | null {
  if (!href) return null;
  if (/^([a-z][a-z0-9+.-]*:)?\/\//i.test(href)) return null; // absolute or protocol-relative
  if (/^(data|mailto|tel):/i.test(href)) return null;
  if (href.startsWith('#')) return null;

  const withoutQuery = href.split('#')[0].split('?')[0];
  if (!withoutQuery) return null;

  const base = path.posix.dirname(filePath);
  const joined = withoutQuery.startsWith('/')
    ? withoutQuery.slice(1)
    : path.posix.join(base, withoutQuery);

  const normalized = path.posix.normalize(joined);
  // a link escaping the repo root is not ours to resolve
  if (normalized.startsWith('..') || normalized === '.') return null;

  try {
    return decodeURIComponent(normalized);
  } catch {
    return normalized;
  }
}

/**
 * Use the document's leading H1 as the page title and drop it from the body,
 * matching how Docmost's own markdown import behaves.
 */
export function extractTitle(
  html: string,
  repoPath: string,
): { title: string; html: string } {
  const fallback = titleFromSegment(
    path.posix.basename(repoPath).replace(MARKDOWN_RE, ''),
  );

  const $ = load(html);
  const firstH1 = $('h1').first();
  if (firstH1.length === 0) return { title: fallback, html };

  const title = firstH1.text().trim();
  if (!title) return { title: fallback, html };

  firstH1.remove();
  return { title, html: $.html() };
}
