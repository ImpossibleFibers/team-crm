// The one serverless function: the Claude connector, Google sign-in, and the browse page.
import { handleRequest } from '../../src/app.mjs';

export default (request) => handleRequest(request);

export const config = {
  path: [
    '/mcp',
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/mcp',
    '/.well-known/oauth-authorization-server',
    '/authorize',
    '/token',
    '/register',
    '/auth/google/callback',
    '/login',
    '/logout',
    '/api/*',
    '/',
    '/people/*',
  ],
};
