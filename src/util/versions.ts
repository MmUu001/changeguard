/**
 * Loose version comparison good enough for manifest pins, SDK tags and
 * Shopify calendar API versions (YYYY-MM). This is intentionally NOT a full
 * semver implementation - it is deterministic and dependency-free.
 */
export type VersionOrdinal = number[];

export function parseVersion(input: string | undefined): VersionOrdinal | undefined {
  if (!input) return undefined;
  const s = input.trim().replace(/^[vV=~^><\s]+/, '');
  // Calendar version: 2024-01 / 2024-01-01
  const cal = s.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?/);
  if (cal) {
    return [Number(cal[1]), Number(cal[2]), cal[3] ? Number(cal[3]) : 0];
  }
  // go pseudo-version v0.0.0-20220101010101-abcdef -> leading triple
  const m = s.match(/(\d+)\.(\d+)\.(\d+)/);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  const simple = s.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!simple || simple[1] === undefined) return undefined;
  return [
    Number(simple[1]),
    simple[2] === undefined ? 0 : Number(simple[2]),
    simple[3] === undefined ? 0 : Number(simple[3]),
  ];
}

export function compareVersions(a: string | undefined, b: string | undefined): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** True when `version` is strictly older than `target`. Unknown versions -> false. */
export function isOlder(version: string | undefined, target: string | undefined): boolean {
  if (!version || !target) return false;
  const pv = parseVersion(version);
  const pt = parseVersion(target);
  if (!pv || !pt) return false;
  return compareVersions(version, target) < 0;
}

/** Extract a concrete version from a manifest specifier ("^14.1.0" -> "14.1.0"). */
export function concreteFromSpec(spec: string | undefined): string | undefined {
  if (!spec) return undefined;
  const m = spec.match(/(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/);
  return m?.[1];
}
