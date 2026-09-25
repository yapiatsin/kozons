// Client HTTP de l'API Kozons (session + CSRF).

function csrfToken() {
  const m = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function request(method, url, data, { onProgress } = {}) {
  const headers = { 'X-CSRFToken': csrfToken() };
  let payload;
  if (data instanceof FormData) {
    payload = data;
  } else if (data !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(data);
  }
  // XHR uniquement si on veut suivre la progression d'un envoi de fichier.
  if (onProgress && payload instanceof FormData) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(method, '/api/' + url);
      for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
      xhr.upload.onprogress = e => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onload = () => {
        let json = {};
        try { json = JSON.parse(xhr.responseText); } catch (e) { /* réponse vide */ }
        if (xhr.status >= 400) reject(new ApiError(json.error || 'Erreur réseau', xhr.status));
        else resolve(json);
      };
      xhr.onerror = () => reject(new ApiError('Connexion impossible', 0));
      xhr.send(payload);
    });
  }
  let res;
  try {
    res = await fetch('/api/' + url, { method, headers, body: payload, credentials: 'same-origin' });
  } catch (e) {
    throw new ApiError('Connexion impossible. Vérifiez votre réseau.', 0);
  }
  let json = {};
  try { json = await res.json(); } catch (e) { /* réponse vide */ }
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('auth/') && url !== 'me') window.dispatchEvent(new Event('kozons:unauthorized'));
    throw new ApiError(json.error || `Erreur ${res.status}`, res.status);
  }
  return json;
}

export const api = {
  get: (url, params) => {
    const qs = params ? '?' + new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')) : '';
    return request('GET', url + qs);
  },
  post: (url, data, opts) => request('POST', url, data ?? {}, opts),
  del: url => request('DELETE', url),
};

export function form(obj) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v.forEach(x => fd.append(k, x));
    else fd.append(k, typeof v === 'boolean' ? (v ? '1' : '0') : v);
  }
  return fd;
}
