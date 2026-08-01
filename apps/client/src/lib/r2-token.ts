/**
 * Access tokens for a token-protected Cloudflare R2 image domain.
 *
 * The token is appended when a URL is rendered, never stored in page content —
 * tokens expire in minutes, page content does not.
 */

let cachedToken: string | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

function r2Domain(): string | null {
  return window.CONFIG?.["R2_IMAGE_DOMAIN"] || null;
}

export function isR2TokenEnabled(): boolean {
  return Boolean(r2Domain());
}

async function fetchToken(): Promise<number> {
  const res = await fetch("/api/r2/token", { credentials: "include" });
  if (!res.ok) throw new Error(`r2 token request failed: ${res.status}`);

  const body = await res.json();
  const token = body?.data?.token ?? body?.token;
  const expiresAt = body?.data?.expiresAt ?? body?.expiresAt;
  if (!token) throw new Error("r2 token response missing token");

  cachedToken = token;

  // refresh a little before expiry; fall back to 4 minutes
  const msUntilExpiry = expiresAt ? expiresAt - Date.now() : 0;
  return msUntilExpiry > 30_000 ? msUntilExpiry - 30_000 : 4 * 60_000;
}

/**
 * Fetches the first token, then keeps it refreshed in the background.
 *
 * Awaiting the first fetch matters: `getFileUrl()` reads the token
 * synchronously while rendering, and nothing re-renders when a token arrives
 * late. Resolves immediately when R2 protection is not configured.
 * Safe to call more than once.
 */
export async function startR2TokenRefresh(): Promise<void> {
  if (!isR2TokenEnabled() || refreshTimer) return;

  const scheduleNext = (delay: number) => {
    refreshTimer = setTimeout(tick, delay);
  };

  const tick = async () => {
    try {
      scheduleNext(await fetchToken());
    } catch {
      // keep serving the previous token and retry sooner
      scheduleNext(30_000);
    }
  };

  try {
    scheduleNext(await fetchToken());
  } catch {
    // a missing token must not block the app from starting
    scheduleNext(30_000);
  }
}

/**
 * Appends the current token to a URL on the protected domain.
 * Anything else is returned untouched.
 */
export function appendR2Token(url: string): string {
  const domain = r2Domain();
  if (!domain || !cachedToken || !url.includes(domain)) return url;

  try {
    const parsed = new URL(url);
    if (parsed.host !== domain) return url;
    parsed.searchParams.set("token", cachedToken);
    return parsed.toString();
  } catch {
    return url;
  }
}
