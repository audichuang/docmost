import { config } from 'dotenv';
import * as path from 'path';

/**
 * Jest `setupFiles` hook: load the repo-root `.env` so a test that needs real
 * infrastructure finds it without every run having to export the variable by
 * hand. Existing environment wins, so CI can override.
 *
 * Only ever read here — nothing in the suites writes to it, and the one
 * variable that matters (GITHUB_TEST_DATABASE_URL) is expected to be absent on
 * most machines, where the database-backed suites skip themselves.
 */
config({
  path: path.resolve(__dirname, '../../../.env'),
  override: false,
  quiet: true,
});
