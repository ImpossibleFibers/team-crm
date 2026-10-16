// The two settings that make this CRM yours, set as Netlify environment variables:
//   CRM_EMAIL_DOMAIN  your Google Workspace domain, e.g. example.com. Only verified
//                     accounts on it can sign in. Required.
//   CRM_NAME          what the CRM is called in Claude and on the browse page.
//                     Optional; default "Team CRM".

export function settings(env = process.env) {
  return {
    name: env.CRM_NAME?.trim() || 'Team CRM',
    domain: env.CRM_EMAIL_DOMAIN?.trim().toLowerCase().replace(/^@/, '') || null,
  };
}
