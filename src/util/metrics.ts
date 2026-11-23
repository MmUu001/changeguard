/**
 * In-process metrics registry with a Prometheus text-exposition renderer.
 * Zero dependencies; all values are process-local by design — ChangeGuard
 * targets single-node deployments (SQLite is single-writer anyway).
 *
 * This module lives in util/ (Apache-2.0 side) on purpose: llm/ records
 * counters too, and the npm distribution ships dist/util/** but never
 * dist/server/**. Importing a server module from llm/ would break the
 * Apache-only install at runtime.
 *
 * Naming follows Prometheus conventions: underscore-separated, unit suffix,
 * counters end in _total.
 */
import { scanQueue } from './task-queue.js';

const startedAtMs = Date.now();

interface Series {
  labels: Record<string, string>;
  value: number;
}

interface Metric {
  help: string;
  type: 'counter' | 'gauge';
  series: Map<string, Series>; // key: sorted label pairs "k=v,k2=v2"
}

const registry = new Map<string, Metric>();

function labelKey(labels: Record<string, string> | undefined): string {
  if (!labels || Object.keys(labels).length === 0) return '';
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(',');
}

function metricFor(name: string, type: 'counter' | 'gauge', help: string): Metric {
  let m = registry.get(name);
  if (!m) {
    m = { help, type, series: new Map() };
    registry.set(name, m);
  }
  return m;
}

/** Increment a counter (created on first use). */
export function incCounter(name: string, labels?: Record<string, string>, delta = 1): void {
  const m = metricFor(name, 'counter', HELP[name] ?? `${name} counter`);
  const key = labelKey(labels);
  const s = m.series.get(key) ?? { labels: labels ?? {}, value: 0 };
  s.value += delta;
  m.series.set(key, s);
}

/** Set a gauge value (created on first use). */
export function setGauge(name: string, value: number, labels?: Record<string, string>): void {
  const m = metricFor(name, 'gauge', HELP[name] ?? `${name} gauge`);
  const key = labelKey(labels);
  m.series.set(key, { labels: labels ?? {}, value });
}

/** Record one duration observation (count/sum counters + last gauge). */
export function recordDuration(
  name: string,
  durationMs: number,
  labels?: Record<string, string>,
): void {
  const suffix = labels
    ? Object.entries(labels)
        .sort()
        .map(([k, v]) => `${k}="${v}"`)
        .join(',')
    : '';
  const scope = suffix ? `{${suffix}}` : '';
  incCounter(`${name}_ms_count${scope}`, undefined, 1);
  incCounter(`${name}_ms_sum${scope}`, undefined, durationMs);
  setGauge(`${name}_ms_last${scope}`, durationMs);
}

const HELP: Record<string, string> = {
  changeguard_scans_total: 'Scan jobs executed by the server queue, by result.',
  changeguard_scan_duration_ms: 'Scan job duration in milliseconds (count/sum/last).',
  changeguard_scan_findings_total: 'Findings produced by scans, by severity.',
  changeguard_llm_explanations_total: 'Explanations produced by the LLM pipeline.',
  changeguard_llm_fallback_total:
    'Explanations that fell back to the deterministic template, by reason.',
  changeguard_scan_queue: 'Scan queue depth gauges (running / pending).',
  changeguard_uptime_seconds: 'Seconds since this process started.',
};

/** Render the whole registry in Prometheus text exposition format (0.0.4). */
export function renderPrometheus(): string {
  // Dynamic gauges that mirror live state at scrape time.
  const q = scanQueue.stats;
  setGauge('changeguard_scan_queue', q.running, { state: 'running' });
  setGauge('changeguard_scan_queue', q.pending, { state: 'pending' });
  setGauge('changeguard_uptime_seconds', Math.floor((Date.now() - startedAtMs) / 1000));

  const lines: string[] = [];
  for (const [name, metric] of registry) {
    lines.push(`# HELP ${name} ${metric.help}`);
    lines.push(`# TYPE ${name} ${metric.type}`);
    for (const s of metric.series.values()) {
      const keys = Object.keys(s.labels);
      const rendered = keys.length
        ? `{${keys
            .sort()
            .map((k) => `${k}="${escapeLabel(s.labels[k] ?? '')}"`)
            .join(',')}}`
        : '';
      lines.push(`${name}${rendered} ${s.value}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function escapeLabel(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** Reset everything (test isolation only — not exported from builds). */
export function resetMetricsForTests(): void {
  registry.clear();
}
