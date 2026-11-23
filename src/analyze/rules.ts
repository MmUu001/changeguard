import type { Language } from '../types.js';

/**
 * A provider's import surface for one language.
 * The analyzer traces local aliases/instances back to one of these rules,
 * but only activates a rule when the provider's package is imported in the
 * same file (so a variable named "stripe" in an unrelated file is ignored).
 */
export interface LanguageRule {
  providerId: string;
  packageName: string;
  /** Identifier roots accepted once the package is imported (defaults, aliases). */
  roots: string[];
  /** Factory/constructor names: const x = factory(...) / new Factory() binds x. */
  factories: string[];
  /** Go only: module path prefixes (with or without the /vNN major suffix). */
  goModulePrefixes?: string[];
}

export interface HostRule {
  suffix: string;
  providerId: string;
}

export interface AnalyzerIndex {
  rules: Record<Language, LanguageRule[]>;
  hosts: HostRule[];
}
