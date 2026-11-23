import { describe, expect, it } from 'vitest';
import { classify, parseNoteEntry, splitReleaseNotes } from '../src/ingest/note-parser.js';

describe('classify', () => {
  it('classifies breaking / deprecation / behavior / feature prose', () => {
    expect(classify('This is a breaking change for all users.').kind).toBe('breaking');
    expect(classify('The legacy endpoint is deprecated; please migrate to v2.').kind).toBe(
      'deprecation',
    );
    expect(classify('This release changes the default behavior of retries.').kind).toBe('behavior');
    expect(classify('Added a new color scheme to the dashboard.').kind).toBe('feature');
  });
});

describe('parseNoteEntry', () => {
  it('extracts operations, parameter targets and sdk paths from prose', () => {
    const entry = [
      '## Callback parameter renamed',
      '',
      'This release renames parameter `status_callback` to `status_callback_url` in `messages.create`.',
      'The REST path POST /2010-04-01/Accounts/{Sid}/Messages is documented.',
    ].join('\n');
    const rec = parseNoteEntry(entry, {
      providerId: 'twilio',
      source: 'release-note',
      date: '2024-06-15',
      language: 'python',
      ecosystem: 'pypi',
      packageName: 'twilio',
      tag: 'v9.0.0',
    });
    expect(rec).toBeTruthy();
    expect(rec!.kind).toBe('breaking');
    expect(
      rec!.operations.some((o) => o.scope === 'parameter' && o.target === 'status_callback'),
    ).toBe(true);
    expect(rec!.operations.some((o) => o.sdkPaths?.python?.includes('messages.create'))).toBe(true);
    expect(rec!.operations.some((o) => o.method === 'POST')).toBe(true);
    expect(rec!.confidence).toBe('high');
  });

  it('returns undefined for short noise', () => {
    expect(
      parseNoteEntry('minor tweaks', { providerId: 'x', source: 'changelog', date: '2024-01-01' }),
    ).toBeUndefined();
  });
});

describe('splitReleaseNotes', () => {
  it('splits markdown into per-version sections', () => {
    const md = [
      '## v2.0.0',
      '',
      '- Removed the legacy `source` parameter from charges.create',
      '',
      '## v1.1.0',
      '',
      '- Deprecated the v1 billing endpoints',
    ].join('\n');
    const entries = splitReleaseNotes(md);
    expect(entries.length).toBe(2);
    expect(entries[0]).toContain('Removed the legacy');
    expect(entries[1]).toContain('Deprecated');
  });
});

describe('title quality (version-tag headings)', () => {
  it('falls back to the first substantive body line when the heading is a version', () => {
    const rec = parseNoteEntry(
      [
        '### v7.44.0',
        '**api:** Breaking change in a minor release. Live response instructions can now be a string or an array of text parts.',
      ].join('\n'),
      { providerId: 'openai', source: 'release-note', date: '2026-10-26' },
    );
    expect(rec).toBeTruthy();
    expect(rec!.title).not.toBe('v7.44.0');
    expect(rec!.title).toContain('Live response instructions');
    expect(rec!.title.length).toBeLessThanOrEqual(140);
  });

  it('keeps a meaningful heading unchanged', () => {
    const rec = parseNoteEntry(
      [
        '### Legacy Charges / Sources payment flow removed',
        'This is a breaking change: the source parameter was removed from charges.create.',
      ].join('\n'),
      { providerId: 'stripe', source: 'changelog', date: '2024-04-11' },
    );
    expect(rec).toBeTruthy();
    expect(rec!.title).toBe('Legacy Charges / Sources payment flow removed');
  });

  it('survives punctuation-only headings', () => {
    const rec = parseNoteEntry(
      [
        '### -',
        'This is a breaking change: the query builder no longer accepts string unions in select().',
      ].join('\n'),
      { providerId: 'supabase', source: 'release-note', date: '2026-11-11' },
    );
    expect(rec).toBeTruthy();
    expect(rec!.title).not.toBe('-');
    expect(rec!.title).toContain('query builder');
  });

  it('clamps an over-long fallback title to 140 chars', () => {
    const longLine = `This is a breaking change: the SDK removes the legacy ${'very '.repeat(40)}long parameter.`;
    const rec = parseNoteEntry(['### v1.0.0', longLine].join('\n'), {
      providerId: 'openai',
      source: 'release-note',
      date: '2026-01-01',
    });
    expect(rec).toBeTruthy();
    expect(rec!.title.length).toBeLessThanOrEqual(140);
    expect(rec!.title.endsWith('...')).toBe(true);
  });
});
