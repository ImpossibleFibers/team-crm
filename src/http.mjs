// Small helpers for building HTTP responses and reading cookies.

export function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

export function redirect(location, { status = 302, cookies = [] } = {}) {
  const headers = new Headers({ Location: String(location), 'Cache-Control': 'no-store' });
  for (const c of cookies) headers.append('Set-Cookie', c);
  return new Response(null, { status, headers });
}

export function html(status, body, { cookies = [] } = {}) {
  const headers = new Headers({
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self' https://fonts.googleapis.com",
      'font-src https://fonts.gstatic.com',
      "connect-src 'self'",
      "img-src 'self' data:",
      "form-action 'self'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
  });
  for (const c of cookies) headers.append('Set-Cookie', c);
  return new Response(body, { status, headers });
}

export const methodNotAllowed = (allow) => json(405, { error: `Use ${allow}.` }, { Allow: allow });

// Every cookie the CRM sets is httpOnly, Secure and SameSite=Lax. The __Host-
// prefix makes browsers refuse it unless it is also Secure, for this host only, and for every path.
export function setCookie(name, value, maxAgeSeconds) {
  return `${name}=${value}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
}

export const clearCookie = (name) => setCookie(name, '', 0);

export function readCookie(request, name) {
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
