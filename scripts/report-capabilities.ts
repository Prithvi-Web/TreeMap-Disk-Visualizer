/**
 * Print what this machine actually detected.
 *
 * Run by CI on all three operating systems (.github/workflows/test.yml) and
 * usable locally with `npm run capabilities:report`.
 *
 * The reason this is a *report* and not a test: an honest "unavailable with a
 * reason" state passes every assertion by design — that is the whole point of
 * §2.2. So a capability that silently regresses from available to unavailable
 * (a tool dropped from a runner image, a permission model changed) would never
 * turn a suite red. Printing the matrix per OS makes that visible to a person
 * reading the log, which is the only place it can be caught.
 */

import { getCapabilities } from '../src/platform/capabilities';
import { platform } from '../src/platform';

async function main(): Promise<void> {
  const caps = await getCapabilities();

  console.log('');
  console.log(`TreeMap capability report — ${caps.platform} (process.platform=${process.platform}, ${process.arch})`);
  console.log('='.repeat(78));

  const rows = Object.entries(caps).filter(([key]) => key !== 'platform');
  for (const [key, value] of rows) {
    const state = value as { available: boolean; mechanism: string; reason?: string; degradedTo?: string };
    const status = state.available ? (state.degradedTo ? 'DEGRADED' : 'OK') : 'UNAVAILABLE';
    console.log(`${status.padEnd(12)} ${key.padEnd(22)} ${state.mechanism}`);
    if (state.degradedTo) console.log(`${' '.repeat(12)} ${' '.repeat(22)} falls back to: ${state.degradedTo}`);
    if (state.reason) console.log(`${' '.repeat(12)} ${' '.repeat(22)} ${state.reason}`);
  }

  console.log('='.repeat(78));
  const available = rows.filter(([, v]) => (v as { available: boolean }).available).length;
  console.log(`${String(available)}/${String(rows.length)} capabilities available on this machine.`);

  // Prove the enumerator actually runs here rather than only type-checking.
  let count = 0;
  for await (const _entry of platform().fastEnumerate(process.cwd(), { skip: (p) => p.includes('node_modules') })) {
    count++;
    if (count > 500) break;
  }
  console.log(`fastEnumerate produced ${String(count)} entries from the working directory.`);
  console.log('');
}

main().catch((err: unknown) => {
  console.error('capability report failed:', err);
  process.exitCode = 1;
});
