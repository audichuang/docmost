import {
  evaluateInstallationOwnership,
  fullSyncJobId,
  isFullSyncInFlight,
} from './github.controller';

describe('evaluateInstallationOwnership', () => {
  const base = {
    clientSecretConfigured: true,
    code: 'a-code',
    installationId: '123',
    userInstallationIds: ['123'],
  };

  /**
   * B1: the whole point of this check is that state alone is not enough —
   * an attacker can get a validly-signed state for their own workspace and
   * replay the callback with a victim's installation_id. This is the
   * "everything lines up" case that must be allowed through.
   */
  it('allows a caller who owns the installation', () => {
    expect(evaluateInstallationOwnership(base)).toEqual({ ok: true });
  });

  it('refuses to link when the operator has not configured OAuth', () => {
    expect(
      evaluateInstallationOwnership({ ...base, clientSecretConfigured: false }),
    ).toEqual({
      ok: false,
      error: 'installation_ownership_not_configured',
    });
  });

  /**
   * Regression guard: an unconfigured secret must never fall back to
   * trusting installation_id, even if every other field looks legitimate.
   */
  it('refuses even when a code and a matching installation id are present', () => {
    expect(
      evaluateInstallationOwnership({
        ...base,
        clientSecretConfigured: false,
        userInstallationIds: ['123'],
      }),
    ).toEqual({ ok: false, error: 'installation_ownership_not_configured' });
  });

  it('rejects a callback with no oauth code', () => {
    expect(
      evaluateInstallationOwnership({ ...base, code: undefined }),
    ).toEqual({ ok: false, error: 'missing_oauth_code' });
  });

  it('rejects a callback with an empty oauth code', () => {
    expect(evaluateInstallationOwnership({ ...base, code: '' })).toEqual({
      ok: false,
      error: 'missing_oauth_code',
    });
  });

  it('rejects when the token exchange or listing call failed', () => {
    expect(
      evaluateInstallationOwnership({ ...base, userInstallationIds: null }),
    ).toEqual({ ok: false, error: 'oauth_verification_failed' });
  });

  /**
   * The actual attack this fix closes: a valid state for the attacker's own
   * workspace, replayed with someone else's installation_id.
   */
  it('rejects an installation absent from the caller\'s own list', () => {
    expect(
      evaluateInstallationOwnership({
        ...base,
        installationId: '999',
        userInstallationIds: ['123', '456'],
      }),
    ).toEqual({ ok: false, error: 'installation_not_owned' });
  });

  it('compares installation ids as strings', () => {
    expect(
      evaluateInstallationOwnership({
        ...base,
        installationId: '123',
        userInstallationIds: ['123'],
      }),
    ).toEqual({ ok: true });
  });
});

describe('fullSyncJobId', () => {
  it('is deterministic per source', () => {
    expect(fullSyncJobId('src-1')).toBe(fullSyncJobId('src-1'));
  });

  it('differs across sources', () => {
    expect(fullSyncJobId('src-1')).not.toBe(fullSyncJobId('src-2'));
  });
});

describe('isFullSyncInFlight', () => {
  it.each([['waiting'], ['active'], ['delayed'], ['prioritized'], ['waiting-children']])(
    'treats %s as in flight (coalesce onto it)',
    (state) => {
      expect(isFullSyncInFlight(state as any)).toBe(true);
    },
  );

  it.each([['completed'], ['failed'], ['unknown']])(
    'treats %s as finished (free to start a fresh scan)',
    (state) => {
      expect(isFullSyncInFlight(state as any)).toBe(false);
    },
  );
});
