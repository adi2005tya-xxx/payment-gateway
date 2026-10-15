/**
 * API client. The token lives in sessionStorage (cleared when the tab closes). Trade-off, stated plainly: any script running on this
 * origin could read it, so the site ships a strict header set and renders no untrusted HTML. Admin MFA is enforced by the API, not here.
 */
export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}

const KEY = 'gw.session';
export interface Session {
  token: string;
  role: 'ADMIN' | 'MERCHANT';
}

export function loadSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}
export function saveSession(s: Session | null) {
  try {
    if (s) sessionStorage.setItem(KEY, JSON.stringify(s));
    else sessionStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: session lives only until reload */
  }
  memory = s;
  listeners.forEach((l) => l());
}
let memory: Session | null = null;
const listeners = new Set<() => void>();
export const onSessionChange = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export const currentSession = () => memory ?? (memory = loadSession());

type StepUpHandler = () => Promise<boolean>;
let stepUpHandler: StepUpHandler | null = null;
export const setStepUpHandler = (h: StepUpHandler | null) => {
  stepUpHandler = h;
};

interface Opts {
  token?: string | null;
  body?: unknown;
  headers?: Record<string, string>;
  /** internal: a step-up was already attempted */
  retried?: boolean;
}

async function raw(method: string, path: string, opts: Opts): Promise<Response> {
  const token = opts.token === undefined ? currentSession()?.token : opts.token;
  return fetch(`${API_URL}${path}`, {
    method,
    headers: { ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...opts.headers },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    cache: 'no-store',
  });
}

async function request<T>(method: string, path: string, opts: Opts = {}): Promise<T> {
  let res: Response;
  try {
    res = await raw(method, path, opts);
  } catch {
    throw new ApiError(0, 'NETWORK', 'Cannot reach the server. Check your connection and try again.');
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON (e.g. CSV) */
  }
  if (res.ok) return (data ?? (text as unknown)) as T;
  const err = new ApiError(res.status, data?.error ?? 'ERROR', data?.message ?? `Request failed (${res.status})`, data ?? {});
  // High-risk operation: ask for a fresh authenticator code, then repeat the request once.
  if (err.code === 'STEP_UP_REQUIRED' && !opts.retried && stepUpHandler) {
    if (await stepUpHandler()) return request<T>(method, path, { ...opts, retried: true });
  }
  if (res.status === 401 && opts.token === undefined && currentSession()) saveSession(null); // session expired or revoked
  throw err;
}

export const api = {
  get: <T = any>(path: string, opts?: Opts) => request<T>('GET', path, opts),
  post: <T = any>(path: string, body?: unknown, opts?: Opts) => request<T>('POST', path, { ...opts, body: body ?? {} }),
  /** Downloads a file through the authenticated API and saves it. */
  async download(path: string, filename: string) {
    const res = await raw('GET', path, {});
    if (!res.ok) throw new ApiError(res.status, 'DOWNLOAD_FAILED', 'Download failed');
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  },
};

export const idempotencyKey = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`);

export const inr = (minor: number | string | null | undefined) =>
  (Number(minor ?? 0) / 100).toLocaleString('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 });

export const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—');

/** Converts "1,234.50" or "1234.5" to integer paise; returns null when invalid. */
export function toMinor(input: string): number | null {
  const s = input.replace(/[,\s₹]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [r, p = ''] = s.split('.');
  return Number(r) * 100 + Number(p.padEnd(2, '0'));
}
