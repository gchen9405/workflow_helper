/**
 * Environment lookup that tolerates hosts without `process`.
 *
 * `process.env.X` is a ReferenceError in a browser, where the client is
 * configured through its constructor options alone. Reading through
 * `globalThis` answers `undefined` there instead, so the same client class
 * serves the CLI (env vars or a `.env` file) and the bundle (options only)
 * without a build-time switch. `host` is injectable for tests.
 */
export function envVar(name: string, host: unknown = globalThis): string | undefined {
  const env = (host as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const value = env?.[name];
  return typeof value === "string" ? value : undefined;
}
