/**
 * Apache-2.0-only build stub.
 *
 * The proprietary distribution ships the real persistence layer
 * (src/store/sqlite.ts). This placeholder exists only so `tsc` can resolve the
 * dynamic import in src/scan.ts when compiling the Apache-only open-source
 * tree. It is a silent no-op: scans run with persist:false never reach it, and
 * the runtime path in src/scan.ts treats persistence as an optional feature of
 * the proprietary distribution.
 */
export function saveScan(..._args: unknown[]): void {
  // Silent no-op in the Apache-only build.
}

export default { saveScan };
