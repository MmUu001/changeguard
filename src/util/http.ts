export interface FetchOptions {
  headers?: Record<string, string>;
  accept?: string;
  timeoutMs?: number;
  method?: string;
  body?: string;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public url: string,
    public body: string,
  ) {
    super(`HTTP ${status} for ${url}: ${body.slice(0, 200)}`);
  }
}

export async function fetchText(url: string, opts: FetchOptions = {}): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20000);
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? 'GET',
      body: opts.body,
      signal: ctrl.signal,
      headers: {
        'user-agent': 'ChangeGuard/0.1 (+https://changeguard.dev)',
        accept: opts.accept ?? 'application/json, text/plain;q=0.9, */*;q=0.5',
        ...(opts.body ? { 'content-length': String(Buffer.byteLength(opts.body)) } : {}),
        ...opts.headers,
      },
    });
  } finally {
    clearTimeout(timer);
  }
  const body = await res.text();
  if (!res.ok) throw new HttpError(res.status, url, body);
  return body;
}

export async function fetchJson<T = unknown>(url: string, opts: FetchOptions = {}): Promise<T> {
  const body = await fetchText(url, { ...opts, accept: 'application/json' });
  return JSON.parse(body) as T;
}
