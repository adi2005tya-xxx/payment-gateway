import { TransientError } from '../../common/errors';

export type FetchLike = typeof fetch;
export interface HttpResult {
  status: number;
  json: any;
}

/**
 * One HTTP call to a provider. Outages, timeouts, 5xx and 429 become TransientError (outcome unknown, caller keeps state unresolved and retries).
 * 2xx/3xx/4xx come back to the adapter, which decides whether a 4xx is a definitive refusal (ProviderRejection) or "not found".
 */
export async function call(f: FetchLike, url: string, init: RequestInit, timeoutMs = 10_000): Promise<HttpResult> {
  let res: Response;
  try {
    res = await f(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new TransientError(`provider unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.status >= 500 || res.status === 429) throw new TransientError(`provider HTTP ${res.status}`);
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body: adapter sees json === null */
  }
  return { status: res.status, json };
}

export const rupees = (minor: number): string => `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;
export const toMinor = (rupeeString: string | number | undefined | null): number => Math.round(parseFloat(String(rupeeString ?? '0')) * 100);

/** JSON that is safe inside an inline <script> block. */
export const jsonForScript = (v: unknown): string => JSON.stringify(v).replace(/</g, '\\u003c').replace(new RegExp(String.fromCharCode(0x2028), 'g'), '\\u2028').replace(new RegExp(String.fromCharCode(0x2029), 'g'), '\\u2029');
