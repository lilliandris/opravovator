export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/**
 * Chyba siete (offline, server nedostupný, reštartuje sa) – na rozdiel od chyby, ktorú vrátil server.
 * 5xx (napr. 502/503 z proxy počas reštartu) sa ráta tiež: zmena sa uloží do zariadenia a odošle neskôr, nezahodí sa.
 */
export const isNetworkError = (e: unknown) =>
  e instanceof TypeError || (e instanceof ApiError && (e.status === 0 || e.status === 408 || e.status === 429 || e.status >= 500));

export async function api<T = unknown>(url: string, opts: { method?: string; body?: unknown; keepalive?: boolean } = {}): Promise<T> {
  // lokálne úlohy (záporné id) obslúži prehliadač, nie server
  if (/^\/api\/(tasks|solutions)\/-\d+/.test(url)) {
    const { localRequest } = await import('./local/api');
    try {
      return await localRequest(opts.method || 'GET', url, opts.body) as T;
    } catch (e) {
      throw new ApiError(400, (e as Error).message);
    }
  }
  const init: RequestInit = { method: opts.method || 'GET', credentials: 'same-origin', keepalive: opts.keepalive };
  if (opts.body instanceof FormData) init.body = opts.body;
  else if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    init.headers = { 'Content-Type': 'application/json' };
  }
  const res = await fetch(url, init);
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json().catch(() => null) : null;
  if (res.status === 401 && !url.startsWith('/api/auth/') && url !== '/api/me') {
    location.href = '/login';
    throw new ApiError(401, 'Nie si prihlásený.');
  }
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || `HTTP ${res.status}`);
  return data as T;
}

/** Nahrá súbor s priebehom (fetch priebeh nahrávania nevie). */
export function uploadWithProgress<T>(url: string, form: FormData, onProgress: (loaded: number, total: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded, e.total); };
    xhr.onerror = () => reject(new ApiError(0, 'Spojenie so serverom sa prerušilo.'));
    xhr.onload = () => {
      let data: { error?: string } | null = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* napr. HTML chyba z proxy */ }
      if (xhr.status >= 200 && xhr.status < 300 && data) return resolve(data as T);
      if (xhr.status === 401) { location.href = '/login'; return; }
      if (xhr.status === 413 && !data) {
        return reject(new ApiError(413, 'Súbor odmietol proxy server pred aplikáciou (v nginx nastav client_max_body_size 0).'));
      }
      reject(new ApiError(xhr.status, (data && data.error) || `Nahranie zlyhalo (HTTP ${xhr.status}).`));
    };
    xhr.send(form);
  });
}
