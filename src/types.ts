/**
 * ChangeGuard core data model.
 * Every stage of the pipeline (manifests -> AST call sites -> vendor changes
 * -> deterministic findings -> enriched report) communicates through these types.
 */

export type Language = 'javascript' | 'python' | 'go';
export type Ecosystem = 'npm' | 'pypi' | 'go';
export type ChangeKind = 'breaking' | 'deprecation' | 'behavior' | 'feature';
export type Severity = 'high' | 'medium' | 'low';
export type Confidence = 'high' | 'medium' | 'low';
export type ChangeScope =
  | 'operation'
  | 'parameter'
  | 'request-field'
  | 'response-field'
  | 'enum'
  | 'sdk-method'
  | 'api-version'
  | 'service';

export interface Dependency {
  ecosystem: Ecosystem;
  /** Canonical package/module name as written in the manifest. */
  name: string;
  /** Raw version specifier, e.g. "^14.0.0", "==5.5.0", "v76.12.0". */
  spec?: string;
  /** Best-effort resolved concrete version. */
  version?: string;
  dev: boolean;
  /** Indirect go dependency. */
  indirect?: boolean;
  manifest: string;
  line?: number;
  providerId?: string;
}

export interface HttpCallHint {
  method: string;
  url: string;
}

export interface CallSite {
  id: string;
  file: string;
  language: Language;
  /** 1-based line of the call expression. */
  line: number;
  endLine?: number;
  /** Imported package this call was traced to. */
  package: string;
  providerId?: string;
  /**
   * Dotted SDK path relative to the client/root binding,
   * e.g. "chat.completions.create", "messages.create", "auth.signIn".
   */
  path: string;
  /** The full receiver text, useful for debugging. */
  receiver: string;
  /** Trimmed source line / short snippet. */
  callText: string;
  /** Top-level keys of the first object argument / kw-args / params struct. */
  argumentKeys: string[];
  /** String literal values keyed by argument name, e.g. {model:"text-davinci-003"}. */
  argumentLiterals: Record<string, string[]>;
  /** Dotted references rooted at an imported binding, e.g. "stripe.ChargeTypeCard". */
  memberRefs: string[];
  /** Raw HTTP call pointing at a vendor REST host. */
  http?: HttpCallHint;
}

export type RenameKind = 'method' | 'parameter' | 'identifier' | 'function';

export interface Rename {
  kind: RenameKind;
  from: string;
  to: string;
  /** When set, the rename only applies to one language SDK. */
  language?: Language;
}

export interface AffectedOperation {
  /** HTTP verb when derived from / matched against an OpenAPI operation. */
  method?: string;
  /** OpenAPI path template, e.g. "/v1/edits". */
  pathTemplate?: string;
  scope: ChangeScope;
  /** Parameter name / field name / enum value / sdk path depending on scope. */
  target?: string;
  /** Canonical SDK paths per language. Entries may end with ".*" for a prefix. */
  sdkPaths?: Partial<Record<Language, string[]>>;
  detail?: string;
}

export interface VersionInfo {
  ecosystem: Ecosystem;
  package: string;
  deprecatedIn?: string;
  removedIn?: string;
  fixedIn?: string;
}

export type ChangeSource = 'openapi-diff' | 'release-note' | 'changelog';

export interface ChangeRecord {
  id: string;
  providerId: string;
  kind: ChangeKind;
  title: string;
  summary?: string;
  body?: string;
  source: ChangeSource;
  sourceUrl?: string;
  /** ISO date. */
  date: string;
  operations: AffectedOperation[];
  renames: Rename[];
  versions: VersionInfo[];
  /** Vendor-authored migration guidance, captured verbatim when available. */
  migration?: string;
  /** Parser bookkeeping (which deterministic signals fired). */
  parserSignals: string[];
  confidence: Confidence;
}

export type CodemodKind = 'rename-method' | 'rename-parameter' | 'rename-identifier';

export interface Codemod {
  kind: CodemodKind;
  from: string;
  to: string;
  language?: Language;
  note?: string;
}

export type RuleId = 'R1' | 'R2' | 'R3' | 'R5' | 'R6' | 'R7' | 'R8' | 'R9';
export type MatchKind =
  'exact' | 'prefix' | 'parameter' | 'enum' | 'http-path' | 'dependency-version';

export interface Explanation {
  source: 'llm' | 'template';
  summary: string;
  migrationSteps: string[];
}

export interface Finding {
  id: string;
  providerId: string;
  changeId: string;
  change: ChangeRecord;
  file?: string;
  line?: number;
  language?: Language;
  callPath?: string;
  codeSnippet?: string;
  ruleId: RuleId;
  match: MatchKind;
  severity: Severity;
  confidence: Confidence;
  reason: string;
  codemod?: Codemod;
  explanation?: Explanation;
}

export interface ScanSummary {
  total: number;
  high: number;
  medium: number;
  low: number;
  filesAffected: number;
  byProvider: Record<string, number>;
}

export interface ScanReport {
  id: string;
  repoName: string;
  repoPath: string;
  generatedAt: string;
  since?: string;
  mode: 'offline' | 'online';
  dependencies: Dependency[];
  detectedProviders: string[];
  callSiteCount: number;
  changes: ChangeRecord[];
  findings: Finding[];
  summary: ScanSummary;
  errors: string[];
}
