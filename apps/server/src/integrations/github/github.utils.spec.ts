import {
  extractTitle,
  normalizeDir,
  resolveRepoPath,
  titleFromSegment,
} from './github.utils';

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
