import {
  assertRepoCoordinates,
  deriveAssetAttachmentId,
  extractTitle,
  GITHUB_COMPARE_FILE_LIMIT,
  isCompareSaturated,
  isPageAlive,
  normalizeDir,
  resolveRepoPath,
  signInstallState,
  titleFromSegment,
  verifyInstallState,
} from './github.utils';

describe('install state', () => {
  const secret = 'test-secret';
  const ws = '018f0000-0000-7000-8000-000000000000';

  it('round-trips a workspace id', () => {
    const state = signInstallState(ws, secret);
    expect(verifyInstallState(state, secret)).toEqual({ workspaceId: ws });
  });

  /**
   * The callback is public, so a forged state would let an attacker attach
   * their own GitHub installation to someone else's workspace.
   */
  it('rejects a state we did not sign', () => {
    const forged = `${Buffer.from(
      JSON.stringify({ workspaceId: ws, ts: Date.now() }),
    ).toString('base64url')}.deadbeef`;

    expect(verifyInstallState(forged, secret)).toBeNull();
  });

  it('rejects a state signed with another secret', () => {
    expect(verifyInstallState(signInstallState(ws, 'other'), secret)).toBeNull();
  });

  it('rejects a tampered payload', () => {
    const state = signInstallState(ws, secret);
    const [, signature] = state.split('.');
    const swapped = Buffer.from(
      JSON.stringify({ workspaceId: 'victim', ts: Date.now() }),
    ).toString('base64url');

    expect(verifyInstallState(`${swapped}.${signature}`, secret)).toBeNull();
  });

  it('rejects an expired state', () => {
    const old = Buffer.from(
      JSON.stringify({ workspaceId: ws, ts: Date.now() - 11 * 60 * 1000 }),
    ).toString('base64url');
    const sig = require('crypto')
      .createHmac('sha256', secret)
      .update(old)
      .digest('hex');

    expect(verifyInstallState(`${old}.${sig}`, secret)).toBeNull();
  });

  it.each([[''], ['nodot'], ['a.b.c'], [undefined as unknown as string]])(
    'rejects malformed state %s',
    (state) => {
      expect(verifyInstallState(state, secret)).toBeNull();
    },
  );
});

describe('assertRepoCoordinates', () => {
  it('accepts real GitHub names', () => {
    expect(() => assertRepoCoordinates('audichuang', 'docmost')).not.toThrow();
    expect(() => assertRepoCoordinates('my-org', 'my.repo_v2')).not.toThrow();
  });

  /**
   * new URL() collapses "..", so a slash in owner reaches a different
   * endpoint entirely: /repos/a/../../user/... resolves to /user.
   */
  it.each([
    ['a/../../user', 'repo'],
    ['owner', '../../user'],
    ['owner/sub', 'repo'],
    ['', 'repo'],
    ['-leading', 'repo'],
    [undefined as unknown as string, 'repo'],
  ])('rejects owner=%s repo=%s', (owner, repo) => {
    expect(() => assertRepoCoordinates(owner, repo)).toThrow(
      'invalid_github_repo_coordinates',
    );
  });
});

describe('resolveRepoPath', () => {
  it('resolves a sibling file', () => {
    expect(resolveRepoPath('docs/guide.md', 'img/logo.png')).toBe(
      'docs/img/logo.png',
    );
  });

  it('resolves a parent traversal that stays inside the repo', () => {
    expect(resolveRepoPath('docs/a/guide.md', '../img/logo.png')).toBe(
      'docs/img/logo.png',
    );
  });

  it('treats a leading slash as repo-root relative', () => {
    expect(resolveRepoPath('docs/guide.md', '/assets/logo.png')).toBe(
      'assets/logo.png',
    );
  });

  it('decodes percent-encoded names', () => {
    expect(resolveRepoPath('docs/guide.md', 'my%20image.png')).toBe(
      'docs/my image.png',
    );
  });

  it('strips query and fragment', () => {
    expect(resolveRepoPath('a.md', 'b.png?v=2#frag')).toBe('b.png');
  });

  it.each([
    ['https://example.com/x.png'],
    ['//cdn.example.com/x.png'],
    ['data:image/png;base64,AAA'],
    ['mailto:someone@example.com'],
    ['#section'],
    [''],
  ])('rejects %s', (href) => {
    expect(resolveRepoPath('docs/guide.md', href)).toBeNull();
  });

  it('rejects a path escaping the repo root', () => {
    expect(resolveRepoPath('guide.md', '../../etc/passwd')).toBeNull();
  });
});

describe('extractTitle', () => {
  it('lifts the first h1 out of the body', () => {
    const { title, html } = extractTitle(
      '<h1>Getting started</h1><p>hello</p>',
      'docs/intro.md',
    );
    expect(title).toBe('Getting started');
    expect(html).not.toContain('<h1>');
    expect(html).toContain('hello');
  });

  it('falls back to the filename when there is no h1', () => {
    const { title, html } = extractTitle('<p>hello</p>', 'docs/my-page.md');
    expect(title).toBe('my page');
    expect(html).toContain('hello');
  });

  it('falls back when the h1 is empty', () => {
    expect(extractTitle('<h1>  </h1>', 'docs/api_reference.mdx').title).toBe(
      'api reference',
    );
  });

  it('only removes the first h1', () => {
    const { html } = extractTitle('<h1>A</h1><h1>B</h1>', 'x.md');
    expect(html).toContain('B');
  });
});

describe('normalizeDir', () => {
  it.each([
    [undefined, ''],
    ['', ''],
    ['/docs/', 'docs'],
    ['docs', 'docs'],
    ['//a/b//', 'a/b'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeDir(input)).toBe(expected);
  });
});

describe('titleFromSegment', () => {
  it('humanises separators', () => {
    expect(titleFromSegment('getting-started_guide')).toBe(
      'getting started guide',
    );
  });
});

describe('isPageAlive', () => {
  it('is false for a missing page', () => {
    expect(isPageAlive(null)).toBe(false);
    expect(isPageAlive(undefined)).toBe(false);
  });

  it('is false for a soft-deleted page', () => {
    expect(isPageAlive({ deletedAt: new Date() })).toBe(false);
  });

  it('is true for a page with no deletedAt', () => {
    expect(isPageAlive({ deletedAt: null })).toBe(true);
  });
});

describe('isCompareSaturated', () => {
  it('is false under the cap', () => {
    expect(isCompareSaturated(GITHUB_COMPARE_FILE_LIMIT - 1)).toBe(false);
    expect(isCompareSaturated(0)).toBe(false);
  });

  /**
   * Regression: a push changing exactly (or more than) 300 files used to be
   * processed as if the compare response were the whole story, silently
   * dropping whatever GitHub didn't return.
   */
  it('is true at and above the cap', () => {
    expect(isCompareSaturated(GITHUB_COMPARE_FILE_LIMIT)).toBe(true);
    expect(isCompareSaturated(GITHUB_COMPARE_FILE_LIMIT + 1)).toBe(true);
  });
});

describe('deriveAssetAttachmentId', () => {
  it('is stable for the same source and path', () => {
    const a = deriveAssetAttachmentId('source-1', 'docs/img/logo.png');
    const b = deriveAssetAttachmentId('source-1', 'docs/img/logo.png');
    expect(a).toBe(b);
  });

  it('differs across paths and across sources', () => {
    const base = deriveAssetAttachmentId('source-1', 'docs/img/logo.png');
    expect(deriveAssetAttachmentId('source-1', 'docs/img/other.png')).not.toBe(base);
    expect(deriveAssetAttachmentId('source-2', 'docs/img/logo.png')).not.toBe(base);
  });

  it('produces a valid uuid', () => {
    const id = deriveAssetAttachmentId('source-1', 'docs/img/logo.png');
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });
});
