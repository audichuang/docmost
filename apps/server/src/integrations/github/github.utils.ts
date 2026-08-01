import * as path from 'path';
import * as crypto from 'crypto';
import { load } from 'cheerio';
import { BadRequestException } from '@nestjs/common';
import { GITHUB_OWNER_RE, GITHUB_REPO_RE } from './github.dto';

export const MARKDOWN_RE = /\.mdx?$/i;
export const INDEX_RE = /^(readme|index)\.mdx?$/i;

/**
 * Second line of defence for values that end up in a GitHub API URL path.
 * A slash here silently redirects the request to a different endpoint —
 * `new URL()` collapses `..`, so `owner = "a/../../user"` reaches /user.
 * DTO validation covers new rows; this covers rows from anywhere else.
 */
export function assertRepoCoordinates(owner: string, repo: string): void {
  if (!GITHUB_OWNER_RE.test(owner ?? '') || !GITHUB_REPO_RE.test(repo ?? '')) {
    throw new BadRequestException('invalid_github_repo_coordinates');
  }
}

const STATE_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * The GitHub App callback has to be public — GitHub redirects the browser to
 * it — so the workspace it names must be proof that *we* started the flow.
 * An unsigned state lets anyone link their own installation into someone
 * else's workspace.
 */
export function signInstallState(workspaceId: string, secret: string): string {
  const payload = Buffer.from(
    JSON.stringify({ workspaceId, ts: Date.now() }),
  ).toString('base64url');

  return `${payload}.${hmac(payload, secret)}`;
}

export function verifyInstallState(
  state: string,
  secret: string,
): { workspaceId: string } | null {
  const [payload, signature] = (state ?? '').split('.');
  if (!payload || !signature) return null;

  const expected = Buffer.from(hmac(payload, secret));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length) return null;
  if (!crypto.timingSafeEqual(expected, actual)) return null;

  try {
    const { workspaceId, ts } = JSON.parse(
      Buffer.from(payload, 'base64url').toString(),
    );
    if (!workspaceId || typeof ts !== 'number') return null;
    if (Date.now() - ts > STATE_MAX_AGE_MS) return null;
    return { workspaceId };
  } catch {
    return null;
  }
}

function hmac(value: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

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
