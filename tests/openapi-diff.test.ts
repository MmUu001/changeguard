import { describe, expect, it } from 'vitest';
import { diffOpenApi, type OpenAPIDoc } from '../src/ingest/openapi-diff.js';

const opts = { providerId: 'openai', date: '2024-01-04' };

const oldDoc: OpenAPIDoc = {
  openapi: '3.0.0',
  info: { title: 'API', version: 'old' },
  paths: {
    '/v1/edits': {
      post: {
        operationId: 'createEdit',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['model', 'instruction'],
                properties: { model: { type: 'string' }, instruction: { type: 'string' } },
              },
            },
          },
        },
      },
    },
    '/v1/completions': {
      get: {
        operationId: 'listModels',
        parameters: [
          {
            name: 'model',
            in: 'query',
            schema: { type: 'string', enum: ['text-davinci-003', 'gpt-3.5-turbo-instruct'] },
          },
        ],
      },
    },
  },
};

const newDoc: OpenAPIDoc = {
  openapi: '3.0.0',
  info: { title: 'API', version: 'new' },
  paths: {
    '/v1/completions': {
      get: {
        operationId: 'listModels',
        deprecated: true,
        parameters: [
          {
            name: 'model',
            in: 'query',
            schema: { type: 'string', enum: ['gpt-3.5-turbo-instruct'] },
          },
        ],
      },
    },
  },
};

describe('diffOpenApi', () => {
  const records = diffOpenApi(oldDoc, newDoc, opts);
  const titles = records.map((r) => r.title);

  it('detects removed endpoints (D2)', () => {
    const removed = records.find((r) =>
      r.operations.some((o) => o.pathTemplate === '/v1/edits' && o.method === 'POST'),
    );
    expect(
      removed,
      `expected an /v1/edits removal record among ${titles.join(' | ')}`,
    ).toBeTruthy();
    expect(removed!.kind).toBe('breaking');
  });

  it('detects newly deprecated operations (D8)', () => {
    const dep = records.find((r) => r.kind === 'deprecation');
    expect(dep).toBeTruthy();
    expect(dep!.operations.some((o) => o.pathTemplate === '/v1/completions')).toBe(true);
  });

  it('detects removed enum values (D7)', () => {
    const enumRec = records.find((r) => r.operations.some((o) => o.scope === 'enum'));
    expect(enumRec).toBeTruthy();
    const op = enumRec!.operations.find((o) => o.scope === 'enum')!;
    expect(op.detail).toContain('removed:text-davinci-003');
    expect(op.detail).not.toContain('gpt-3.5-turbo-instruct');
  });

  it('emits no records for identical docs', () => {
    expect(diffOpenApi(oldDoc, oldDoc, opts)).toHaveLength(0);
  });
});
