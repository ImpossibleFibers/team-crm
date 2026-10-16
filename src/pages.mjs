// The HTML the server sends: the browse page's shell (public/app.js fills it in)
// and short pages for signing in and for sign-in problems.

import { settings } from './config.mjs';
import { escapeHtml, html } from './http.mjs';

const FONTS =
  'https://fonts.googleapis.com/css2?family=DM+Sans:ital,wght@0,400;0,500;0,600;0,700;1,400&family=DM+Serif+Display&display=swap';

function layout(title, header, main) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS}">
<link rel="stylesheet" href="/app.css">
</head>
<body>
<header class="top">
<a class="brand" href="/">${escapeHtml(settings().name)}</a>
${header}
</header>
${main}
</body>
</html>
`;
}

export function appShell(me) {
  const header = `<form class="who" method="post" action="/logout">
<span>${escapeHtml(me.name)}</span>
<button type="submit" class="link">Sign out</button>
</form>`;
  const main = `<main id="app" data-me="${escapeHtml(me.email)}"></main>
<script type="module" src="/app.js"></script>`;
  return html(200, layout(settings().name, header, main));
}

// A page with a heading, one line of text, and optionally one button.
export function messagePage(status, { title, text, action }, options) {
  const button = action ? `<p><a class="button" href="${escapeHtml(action.href)}">${escapeHtml(action.label)}</a></p>` : '';
  const main = `<main class="message">
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(text)}</p>
${button}
</main>`;
  return html(status, layout(title, '', main), options);
}

export function signInPage(next) {
  return messagePage(200, {
    title: 'Sign in',
    text: settings().domain ? `Use your @${settings().domain} Google account.` : 'Use your company Google account.',
    action: { href: `/login?next=${encodeURIComponent(next)}`, label: 'Sign in with Google' },
  });
}
