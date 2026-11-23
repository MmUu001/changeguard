/**
 * Development server entry (`npm run dev`). Replaces the ad-hoc
 * .changeguard/serve-dev.ps1 wrapper: sets demo defaults and runs the CLI
 * serve command via tsx with inherited stdio. Existing env vars win, so
 * `PORT=9000 npm run dev` still works.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.PORT ??= '8788';
process.env.CHANGEGUARD_CONSOLE_PASSWORD ??= 'cg-demo-2026';

const tsx = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));
const child = spawn(process.execPath, [tsx, 'src/cli.ts', 'serve'], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  env: process.env,
  stdio: 'inherit',
});
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => child.kill(sig));
}
