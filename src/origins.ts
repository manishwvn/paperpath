export type OriginConfig = {
  origins: Set<string>;
  publicOrigins: Set<string>;
  authorities: Set<string>;
  hostnames: Set<string>;
  originAuthorities: Map<string, string>;
};

export function configureOrigins(raw: string | undefined, port: number): OriginConfig {
  const loopbackOrigins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  let values: unknown = [];
  if (raw !== undefined) {
    try { values = JSON.parse(raw); }
    catch { throw new Error('INVALID_PUBLIC_ORIGINS'); }
    if (!Array.isArray(values) || values.some(value => typeof value !== 'string')) {
      throw new Error('INVALID_PUBLIC_ORIGINS');
    }
  }

  const publicOrigins = new Set<string>();
  for (const value of values as string[]) {
    let parsed: URL;
    try { parsed = new URL(value); }
    catch { throw new Error('INVALID_PUBLIC_ORIGINS'); }
    if (parsed.protocol !== 'https:' || parsed.origin !== value || parsed.username || parsed.password ||
        value.includes('*') || /\s/.test(value) || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new Error('INVALID_PUBLIC_ORIGINS');
    }
    publicOrigins.add(value);
  }

  const origins = new Set([...loopbackOrigins, ...publicOrigins]);
  const authorities = new Set(['127.0.0.1', 'localhost'].map(host => `${host}:${port}`));
  const hostnames = new Set(['127.0.0.1', 'localhost']);
  const originAuthorities = new Map<string, string>();
  for (const origin of origins) {
    const parsed = new URL(origin);
    originAuthorities.set(origin, parsed.host);
    if (publicOrigins.has(origin)) {
      authorities.add(parsed.host);
      hostnames.add(parsed.hostname);
    }
  }
  return { origins, publicOrigins, authorities, hostnames, originAuthorities };
}
