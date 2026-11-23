/**
 * Apache-2.0-only build stub.
 *
 * The proprietary distribution owns the hosted-service commands (serve,
 * tenant, key, plan, audit, bind-installation) via src/cli-admin.ts. This
 * placeholder exists only so `tsc` can resolve the dynamic import in
 * src/cli.ts when compiling the Apache-only open-source tree. Registering
 * nothing means the CLI simply does not offer those commands.
 */
import type { Command } from 'commander';

export function registerAdminCommands(_program: Command): void {
  // Intentionally empty: hosted-service commands are proprietary.
}
