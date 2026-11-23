/**
 * ChangeGuard deterministic impact engine.
 *
 * All impact decisions live in this file. The LLM can later explain a finding,
 * but it can never create, upgrade, downgrade or remove one.
 *
 * Rules:
 *   R1 exact SDK path match            (breaking call site)
 *   R2 SDK prefix wildcard match       ("resource.* removed")
 *   R3 removed parameter / field used at the call site
 *   R5 removed enum value / constant used
 *   R6 raw HTTP method+path match
 *   R7 pinned dependency version older than deprecation/removal
 *   R8 explicit rename (emits a codemod)
 *   R9 repo-level advisory: provider in use, no concrete call matched
 */
import type {
  AffectedOperation,
  CallSite,
  ChangeRecord,
  Codemod,
  Dependency,
  Finding,
  Language,
  MatchKind,
  RuleId,
  Severity,
} from '../types.js';
import { isOlder } from '../util/versions.js';

interface EvaluateInput {
  sites: CallSite[];
  dependencies: Dependency[];
  changes: ChangeRecord[];
}

/** Collapse snake_case / camelCase / dotted differences for same-language compare. */
function norm(s: string): string {
  return s.toLowerCase().replace(/[_-]/g, '');
}
function segments(s: string): string[] {
  return s.split('.').filter(Boolean);
}
function pathEquals(a: string, b: string): boolean {
  return norm(a) === norm(b);
}
function pathPrefixMatch(prefixPattern: string, sitePath: string): boolean {
  const p = segments(prefixPattern.replace(/\.\*$/, ''));
  const s = segments(sitePath);
  if (p.length === 0 || s.length < p.length) return false;
  return p.every((seg, i) => norm(seg) === norm(s[i]!));
}
function sdkPatternsFor(
  change: ChangeRecord,
  lang: Language,
  scopes?: AffectedOperation['scope'][],
): string[] {
  const out: string[] = [];
  for (const op of change.operations) {
    if (scopes && !scopes.includes(op.scope)) continue;
    for (const p of op.sdkPaths?.[lang] ?? []) out.push(p);
  }
  return [...new Set(out)];
}

const CALL_LEVEL_SCOPES: AffectedOperation['scope'][] = ['operation', 'sdk-method', 'api-version'];

function matchSdkPath(
  change: ChangeRecord,
  site: CallSite,
  scopes: AffectedOperation['scope'][] = CALL_LEVEL_SCOPES,
): { exact: string[]; prefix: string[] } {
  const exact: string[] = [];
  const prefix: string[] = [];
  for (const p of sdkPatternsFor(change, site.language, scopes)) {
    if (p.endsWith('.*')) {
      if (pathPrefixMatch(p, site.path)) prefix.push(p);
    } else if (pathEquals(p, site.path)) {
      exact.push(p);
    } else if (
      pathPrefixMatch(`${p}.*`, site.path) &&
      segments(site.path).length === segments(p).length + 1
    ) {
      // direct child call of a removed namespace
      prefix.push(`${p}.*`);
    }
  }
  return { exact, prefix };
}

function httpPathMatch(template: string, actual: string): boolean {
  const t = template.split('/').filter(Boolean);
  const a = actual.split('/').filter(Boolean);
  if (t.length !== a.length) return false;
  return t.every(
    (seg, i) => /^\{[^}]+\}$/.test(seg) || seg.startsWith(':') || norm(seg) === norm(a[i]!),
  );
}

function parseEnumList(detail: string | undefined, prefix: 'removed' | 'added'): string[] {
  if (!detail) return [];
  const m = detail.match(new RegExp(`${prefix}:(.+)$`));
  return m
    ? m[1]!
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
}

let findingSeq = 0;
function makeFinding(init: {
  change: ChangeRecord;
  ruleId: RuleId;
  match: MatchKind;
  severity: Severity;
  confidence: Finding['confidence'];
  reason: string;
  site?: CallSite;
  codemod?: Codemod;
}): Finding {
  findingSeq += 1;
  return {
    id: `F${String(findingSeq).padStart(4, '0')}`,
    providerId: init.change.providerId,
    changeId: init.change.id,
    change: init.change,
    file: init.site?.file,
    line: init.site?.line,
    language: init.site?.language,
    callPath: init.site ? `${init.site.path}` : undefined,
    codeSnippet: init.site?.callText,
    ruleId: init.ruleId,
    match: init.match,
    severity: init.severity,
    confidence: init.confidence,
    reason: init.reason,
    codemod: init.codemod,
  };
}

function kindSeverity(
  change: ChangeRecord,
  matched: Severity,
  deprecated: Severity,
  behavior: Severity,
): Severity {
  if (change.kind === 'breaking') return matched;
  if (change.kind === 'deprecation') return deprecated;
  if (change.kind === 'behavior') return behavior;
  return 'low';
}

export function evaluate(input: EvaluateInput): Finding[] {
  findingSeq = 0;
  const findings: Finding[] = [];
  const emitted = new Set<string>();
  const matchedChangeIds = new Set<string>();

  const remember = (f: Finding) => {
    // reason is part of the key so distinct impacts on the same call
    // (e.g. two removed parameters, per-ecosystem R7 pins) stay separate.
    const key = `${f.changeId}:${f.file ?? ''}:${f.line ?? ''}:${f.ruleId}:${f.match}:${f.callPath ?? ''}:${f.reason}`;
    if (emitted.has(key)) return;
    emitted.add(key);
    findings.push(f);
    matchedChangeIds.add(f.changeId);
  };

  const providerSites = new Map<string, CallSite[]>();
  for (const site of input.sites) {
    if (!site.providerId) continue;
    const list = providerSites.get(site.providerId) ?? [];
    list.push(site);
    providerSites.set(site.providerId, list);
  }
  const providerDeps = new Map<string, Dependency[]>();
  for (const dep of input.dependencies) {
    if (!dep.providerId) continue;
    const list = providerDeps.get(dep.providerId) ?? [];
    list.push(dep);
    providerDeps.set(dep.providerId, list);
  }

  for (const change of input.changes) {
    const sites = providerSites.get(change.providerId) ?? [];

    for (const site of sites) {
      const { exact, prefix } = matchSdkPath(change, site);

      // R1 exact path
      if (exact.length > 0) {
        const ops = change.operations.filter(
          (o) => o.scope === 'operation' || o.scope === 'sdk-method' || o.scope === 'api-version',
        );
        if (ops.length > 0 || change.operations.length === 0) {
          remember(
            makeFinding({
              change,
              site,
              ruleId: 'R1',
              match: 'exact',
              severity: kindSeverity(change, 'high', 'medium', 'medium'),
              confidence: change.confidence === 'low' ? 'medium' : 'high',
              reason: `Call \`${site.path}\` matches ${change.kind} change "${change.title}"`,
            }),
          );
        }
      }

      // R2 prefix wildcard
      if (prefix.length > 0 && exact.length === 0) {
        remember(
          makeFinding({
            change,
            site,
            ruleId: 'R2',
            match: 'prefix',
            severity: kindSeverity(change, 'high', 'low', 'medium'),
            confidence: 'medium',
            reason: `Call \`${site.path}\` falls under removed/changed namespace ${prefix.join(', ')}`,
          }),
        );
      }

      // R3 parameters / fields — risk analysis only. A feature note ("new
      // parameter available") is an update-log entry, not a risk signal;
      // R9 excludes feature changes for the same reason.
      if (change.kind !== 'feature') {
        const pathScoped =
          exact.length > 0 ||
          change.operations.some((o) => (o.sdkPaths?.[site.language] ?? []).length === 0);
        for (const op of change.operations) {
          if (op.scope !== 'parameter' && op.scope !== 'request-field') continue;
          if (!op.target) continue;
          const sdkList = op.sdkPaths?.[site.language] ?? [];
          const bindsCall =
            sdkList.length === 0
              ? pathScoped
              : sdkList.some(
                  (p) =>
                    (!p.endsWith('.*') && pathEquals(p, site.path)) ||
                    (p.endsWith('.*') && pathPrefixMatch(p, site.path)),
                );
          if (!bindsCall) continue;
          const keyHit = site.argumentKeys.some((k) => {
            const tail = k.split('.').pop()!;
            return norm(tail) === norm(op.target!) || norm(k) === norm(op.target!);
          });
          if (keyHit) {
            remember(
              makeFinding({
                change,
                site,
                ruleId: 'R3',
                match: 'parameter',
                severity: kindSeverity(change, 'high', 'medium', 'medium'),
                confidence: 'high',
                reason: `Call \`${site.path}\` passes ${op.scope === 'parameter' ? 'parameter' : 'field'} \`${op.target}\` affected by "${change.title}"`,
              }),
            );
          }
        }
      }

      // R5 enums / constants
      for (const op of change.operations) {
        if (op.scope !== 'enum') continue;
        const removed = parseEnumList(op.detail, 'removed');
        if (removed.length === 0) continue;
        const sdkList = op.sdkPaths?.[site.language] ?? [];
        const values = new Set<string>();
        for (const list of Object.values(site.argumentLiterals))
          for (const v of list) values.add(v);
        for (const ref of site.memberRefs) values.add(ref);
        const hit = removed.find(
          (v) =>
            values.has(v) ||
            [...values].some((used) => norm(used) === norm(v) || used.endsWith(`.${v}`)),
        );
        if (!hit) continue;
        // Scope the hit: either the enum declares SDK patterns and the call
        // matches, or the constant reference itself carries the value.
        const binds =
          sdkList.length > 0
            ? sdkList.some(
                (p) =>
                  (!p.endsWith('.*') && pathEquals(p, site.path)) ||
                  (p.endsWith('.*') && pathPrefixMatch(p, site.path)),
              )
            : site.memberRefs.some((r) => removed.some((v) => norm(r) === norm(v)));
        if (binds) {
          remember(
            makeFinding({
              change,
              site,
              ruleId: 'R5',
              match: 'enum',
              severity: 'high',
              confidence: 'high',
              reason: `Usage of removed enum/constant value \`${hit}\` (${op.target ?? 'enum'})`,
            }),
          );
        }
      }

      // R6 raw HTTP
      if (site.http) {
        for (const op of change.operations) {
          if (!op.pathTemplate || op.scope === 'sdk-method') continue;
          const methodOk = !op.method || op.method === site.http.method;
          if (methodOk && httpPathMatch(op.pathTemplate, site.path)) {
            remember(
              makeFinding({
                change,
                site,
                ruleId: 'R6',
                match: 'http-path',
                severity: kindSeverity(change, 'high', 'medium', 'medium'),
                confidence: 'high',
                reason: `Raw HTTP call ${site.http.method} ${site.http.url} hits ${op.method ?? '*'} ${op.pathTemplate}`,
              }),
            );
          }
        }
      }

      // R8 renames -> codemods
      for (const rename of change.renames) {
        if (rename.language && rename.language !== site.language) continue;
        if (rename.kind === 'parameter') {
          const sdkList = sdkPatternsFor(change, site.language);
          const bindsCall =
            sdkList.length === 0
              ? exact.length > 0
              : sdkList.some((p) => !p.endsWith('.*') && pathEquals(p, site.path));
          const usesOld = site.argumentKeys.some(
            (k) => norm(k.split('.').pop()!) === norm(rename.from),
          );
          if (bindsCall && usesOld) {
            remember(
              makeFinding({
                change,
                site,
                ruleId: 'R8',
                match: 'parameter',
                severity: kindSeverity(change, 'high', 'medium', 'medium'),
                confidence: 'high',
                reason: `Parameter \`${rename.from}\` renamed to \`${rename.to}\``,
                codemod: {
                  kind: 'rename-parameter',
                  from: rename.from,
                  to: rename.to,
                  language: site.language,
                },
              }),
            );
          }
        } else {
          const tailFrom = rename.from.split('.').pop()!;
          const tailTo = rename.to.split('.').pop()!;
          const sdkList = sdkPatternsFor(change, site.language);
          const bindsCall = sdkList.some(
            (p) =>
              (!p.endsWith('.*') && pathEquals(p, site.path)) ||
              (p.endsWith('.*') && pathPrefixMatch(p, site.path)),
          );
          const tailMatch = norm(segments(site.path).pop() ?? '') === norm(tailFrom);
          if (
            (bindsCall || sdkList.length === 0) &&
            (tailMatch || pathEquals(site.path, rename.from))
          ) {
            remember(
              makeFinding({
                change,
                site,
                ruleId: 'R8',
                match: 'exact',
                severity: change.kind === 'deprecation' ? 'medium' : 'high',
                confidence: bindsCall ? 'high' : 'medium',
                reason: `Method \`${rename.from}\` renamed to \`${rename.to}\``,
                codemod: {
                  kind: 'rename-method',
                  from: tailFrom,
                  to: tailTo,
                  language: site.language,
                },
              }),
            );
          }
        }
      }
    }

    // R7 dependency version pins
    for (const dep of providerDeps.get(change.providerId) ?? []) {
      for (const v of change.versions) {
        if (v.ecosystem !== dep.ecosystem || norm(v.package) !== norm(dep.name)) continue;
        const version = dep.version ?? dep.spec;
        if (v.removedIn && isOlder(version, v.removedIn)) {
          remember(
            makeFinding({
              change,
              ruleId: 'R7',
              match: 'dependency-version',
              severity: 'high',
              confidence: 'high',
              reason: `Pinned ${dep.ecosystem} package ${dep.name}@${version ?? '?'} is older than removal version ${v.removedIn}`,
            }),
          );
        } else if (v.deprecatedIn && isOlder(version, v.deprecatedIn)) {
          remember(
            makeFinding({
              change,
              ruleId: 'R7',
              match: 'dependency-version',
              severity: 'medium',
              confidence: 'medium',
              reason: `Pinned ${dep.ecosystem} package ${dep.name}@${version ?? '?'} predates deprecation version ${v.deprecatedIn}`,
            }),
          );
        }
      }
    }
  }

  // R9 advisories: provider in use (sites or deps) but nothing concrete
  // matched. Aggregated per provider — one advisory per vendor listing the
  // un-matched changes — because one finding per change buried the matched
  // findings under low-signal entries in online mode (measured: 45 of 59
  // findings were per-change advisories). The severity keeps the original
  // signal strength: any un-matched breaking change keeps the advisory at
  // medium; deprecation/behavior-only groups are low.
  const activeProviders = new Set<string>([...providerSites.keys(), ...providerDeps.keys()]);
  const unmatchedByProvider = new Map<string, ChangeRecord[]>();
  for (const change of input.changes) {
    if (matchedChangeIds.has(change.id)) continue;
    if (!activeProviders.has(change.providerId)) continue;
    if (change.kind === 'feature') continue;
    const list = unmatchedByProvider.get(change.providerId) ?? [];
    list.push(change);
    unmatchedByProvider.set(change.providerId, list);
  }
  for (const [providerId, changes] of unmatchedByProvider) {
    const sorted = [...changes].sort((a, b) => b.date.localeCompare(a.date));
    const breaking = sorted.filter((c) => c.kind === 'breaking');
    const deprecation = sorted.filter((c) => c.kind === 'deprecation');
    const behavior = sorted.filter((c) => c.kind === 'behavior');
    // The representative drives the report's change detail: prefer the newest
    // breaking change, otherwise the newest change of any kind.
    const representative = breaking[0] ?? sorted[0]!;
    const kinds: string[] = [];
    if (breaking.length > 0) kinds.push(`${breaking.length} breaking`);
    if (deprecation.length > 0) kinds.push(`${deprecation.length} deprecation`);
    if (behavior.length > 0) kinds.push(`${behavior.length} behavior`);
    const titles = sorted
      .slice(0, 3)
      .map((c) => `"${c.title}" (${c.date})`)
      .join('; ');
    const more = sorted.length > 3 ? `; +${sorted.length - 3} more` : '';
    remember(
      makeFinding({
        change: representative,
        ruleId: 'R9',
        match: 'exact',
        severity: breaking.length > 0 ? 'medium' : 'low',
        confidence: 'low',
        reason: `${changes.length} un-matched change(s) from ${providerId} (${kinds.join(', ')}): none of your call sites hit them directly. Latest: ${titles}${more}. Review the changelog if this provider matters to you`,
      }),
    );
  }

  return findings;
}
