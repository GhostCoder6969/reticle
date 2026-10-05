/**
 * The personas the platform proposes for an app, before a server-run drive with none named.
 *
 * Four or five kinds of user for the app's business, each with one journey that ends in something
 * checkable. Asked once per drive; a platform that cannot answer gives no personas, and the drive
 * goes ahead the way it always did, with no persona at all.
 */
const PERSONAS_PATH = '/v1/harness/personas';
const TIMEOUT_MS = 60_000;

export interface Persona {
  name: string;
  journey: string;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export async function proposePersonas(
  platform: { url: string; apiKey: string },
  about: string,
  doFetch: FetchLike = (url, init) => fetch(url, init),
): Promise<Persona[]> {
  try {
    const res = await doFetch(`${platform.url}${PERSONAS_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${platform.apiKey}` },
      body: JSON.stringify({ about }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { personas?: unknown };
    if (!Array.isArray(body.personas)) return [];
    return body.personas.flatMap((p: unknown) => {
      const r = p as { name?: unknown; journey?: unknown } | null;
      return 'string' === typeof r?.name && 'string' === typeof r.journey
        ? [{ name: r.name, journey: r.journey }]
        : [];
    });
  } catch {
    return [];
  }
}
