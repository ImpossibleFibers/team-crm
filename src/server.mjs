// The Claude connector: an MCP server exposing the CRM as tools.
// It runs statelessly: every HTTP request builds a fresh server for the
// teammate whose key or Google sign-in signed the request, answers, and closes.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import * as z from 'zod';
import { openDb } from './db.mjs';
import { userForAuthHeader } from './auth.mjs';
import { json, methodNotAllowed } from './http.mjs';
import { siteUrls, unauthorized, userForAccessToken } from './oauth.mjs';
import * as crm from './crm.mjs';
import { settings } from './config.mjs';

const instructions = (name) => `This is ${name}: the team's shared record of people, organizations, and every meeting, call and email with them. Teammates use it by talking to Claude, so keep entries consistent. Everything you write is visible to the whole team.

- Search before adding. add_person and add_organization refuse likely duplicates; set confirm_new only after the user confirms it's a different person or organization.
- Tags are topics a person is useful for, such as Robotics or Fundraising. Call list_tags and reuse an existing tag; create a new one (create_new_tag: true) only when nothing fits. When you tag someone, fill useful_for with one specific sentence on why they're useful for that topic.
- relationship: collaborating = we're actively working together; want_to_collaborate = we'd like to work with them; in_touch = everyone else.
- When the user mentions a meeting, call, email or message with someone, log it with log_interaction (emails are email_sent or email_received). "Last contacted" comes from these entries.
- Follow-ups and email drafts go in add_action. Save drafts with status "suggested" until the user approves them. The CRM never sends email.
- Dates are YYYY-MM-DD in the team's time zone. whoami gives today's date and the list of teammates.
- Use append_note rather than notes, so earlier notes aren't overwritten.`;

const personRef = z.string().describe("The person's ID, email address, or exact full name.");
const teammateRef = z.string().describe('A teammate\'s email, exact name, or "me".');
const day = z.string().describe('A date, YYYY-MM-DD.');
const relationship = z.enum(crm.RELATIONSHIPS);
const confirmNewOrganization = z
  .boolean()
  .optional()
  .describe('Set true only to add an organization whose name looks like an existing one.');

const READ = { readOnlyHint: true, openWorldHint: false };
const ADD = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const CHANGE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

function respond(fn) {
  return async (args) => {
    try {
      const result = await fn(args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      if (err instanceof crm.UserError) return { isError: true, content: [{ type: 'text', text: err.message }] };
      if (err?.code === '23505') {
        return { isError: true, content: [{ type: 'text', text: `That would create a duplicate (${err.detail || err.message}).` }] };
      }
      console.error(err);
      return {
        isError: true,
        content: [{ type: 'text', text: 'The CRM hit an unexpected error. Try once more; if it repeats, tell the user.' }],
      };
    }
  };
}

export function buildServer(db, me) {
  const server = new McpServer({ name: 'team-crm', version: '0.1.0' }, { instructions: instructions(settings().name) });
  const tool = (name, description, inputSchema, annotations, fn) =>
    server.registerTool(name, { description, inputSchema, annotations }, respond((args) => fn(db, me, args)));

  tool('whoami', 'Who you are signed in as, the list of teammates, and today\'s date in the team\'s time zone.', {}, READ, crm.whoami);

  // People
  tool(
    'search_people',
    'Find people. All filters combine (AND). Each result includes tags with "useful for" notes, relationship, and when they were last contacted.',
    {
      query: z.string().optional().describe('Words to match in name, email, organization, role, notes, or tags.'),
      tags: z.array(z.string()).optional().describe('Only people with ALL of these tags.'),
      relationship: relationship.optional(),
      organization: z.string().optional().describe('Organization name or ID.'),
      owner: teammateRef.optional().describe('Only people whose relationship this teammate owns.'),
      not_contacted_since: day.optional().describe('Only people not contacted on or after this date (includes never contacted).'),
      contacted_since: day.optional().describe('Only people contacted on or after this date.'),
      never_contacted: z.boolean().optional(),
      sort: z.enum(['name', 'recently_contacted', 'least_recently_contacted']).optional(),
      limit: z.number().int().optional().describe('Default 25, max 200.'),
    },
    READ,
    crm.searchPeople,
  );
  tool(
    'get_person',
    "One person's full record: details, tags, notes, their 20 most recent interactions, and open follow-ups.",
    { person: personRef },
    READ,
    crm.getPerson,
  );
  tool(
    'add_person',
    'Add a person. Refuses likely duplicates (same email, or a similar name) unless confirm_new is true. The organization is created if it is new.',
    {
      name: z.string(),
      email: z.string().optional(),
      organization: z.string().optional().describe('Organization name. Reuses an existing one with the same name.'),
      role: z.string().optional().describe('Job title or role.'),
      relationship: relationship.optional().describe('Default in_touch.'),
      owner: teammateRef.optional().describe('The teammate who owns this relationship.'),
      how_we_met: z.string().optional(),
      notes: z.string().optional(),
      tags: z
        .array(z.object({ tag: z.string(), useful_for: z.string().optional() }))
        .optional()
        .describe('Tags to add, each with a one-sentence note on why they are useful for that topic.'),
      create_new_tags: z.boolean().optional().describe('Allow tags in this call that do not exist yet.'),
      confirm_new: z.boolean().optional().describe('Set true only after confirming this is not someone already in the CRM.'),
      confirm_new_organization: confirmNewOrganization,
    },
    ADD,
    crm.addPerson,
  );
  tool(
    'update_person',
    'Change fields on a person. Only the fields you pass change; pass an empty string to clear email, organization, role, owner or how_we_met.',
    {
      person: personRef,
      name: z.string().optional(),
      email: z.string().optional(),
      organization: z.string().optional(),
      role: z.string().optional(),
      relationship: relationship.optional(),
      owner: z.string().optional().describe('A teammate\'s email, exact name, or "me"; empty string to clear.'),
      how_we_met: z.string().optional(),
      append_note: z.string().optional().describe('Adds a dated line, signed with your name, to the notes.'),
      notes: z.string().optional().describe('Replaces all notes. Prefer append_note.'),
      confirm_new_organization: confirmNewOrganization,
    },
    CHANGE,
    crm.updatePerson,
  );

  // Tags
  tool('list_tags', 'All tags, with how many people have each.', {}, READ, crm.listTags);
  tool(
    'tag_person',
    'Tag a person with a topic they are useful for, with a note on why. Re-tagging updates the note. Refuses a new tag name unless create_new_tag is true.',
    {
      person: personRef,
      tag: z.string(),
      useful_for: z.string().optional().describe('One specific sentence on why this person is useful for this topic.'),
      create_new_tag: z.boolean().optional().describe('Set true only after checking list_tags for an existing tag that fits.'),
    },
    ADD,
    crm.tagPerson,
  );
  tool('untag_person', 'Remove a tag from a person.', { person: personRef, tag: z.string() }, CHANGE, crm.untagPerson);
  tool(
    'update_tag',
    'Rename a tag or change its description. Renaming changes it for everyone tagged.',
    { tag: z.string(), new_name: z.string().optional(), description: z.string().optional() },
    CHANGE,
    crm.updateTag,
  );

  // Organizations
  tool(
    'search_organizations',
    'Find organizations, with how many people we know there and when anyone there was last contacted.',
    {
      query: z.string().optional(),
      type: z.enum(crm.ORG_TYPES).optional(),
      relationship: relationship.optional(),
      limit: z.number().int().optional().describe('Default 50, max 200.'),
    },
    READ,
    crm.searchOrganizations,
  );
  tool(
    'add_organization',
    'Add an organization. Refuses names similar to an existing one unless confirm_new is true.',
    {
      name: z.string(),
      type: z.enum(crm.ORG_TYPES).optional().describe('Default other.'),
      relationship: relationship.optional().describe('Default in_touch.'),
      website: z.string().optional(),
      notes: z.string().optional(),
      confirm_new: z.boolean().optional(),
    },
    ADD,
    crm.addOrganization,
  );
  tool(
    'update_organization',
    'Change fields on an organization. Only the fields you pass change.',
    {
      organization: z.string().describe('Organization name or ID.'),
      name: z.string().optional(),
      type: z.enum(crm.ORG_TYPES).optional(),
      relationship: relationship.optional(),
      website: z.string().optional(),
      append_note: z.string().optional().describe('Adds a dated line, signed with your name, to the notes.'),
      notes: z.string().optional().describe('Replaces all notes. Prefer append_note.'),
    },
    CHANGE,
    crm.updateOrganization,
  );

  // Interactions
  tool(
    'log_interaction',
    'Record a meeting, call, email or message with one or more people. This is what "last contacted" is based on.',
    {
      people: z.array(z.string()).describe("Each person's ID, email address, or exact full name. Add unknown people first."),
      type: z.enum(crm.INTERACTION_TYPES),
      summary: z.string().describe('One line: what it was about.'),
      details: z.string().optional(),
      date: z.string().optional().describe('YYYY-MM-DD, or a full ISO date-time. Default: now.'),
    },
    ADD,
    crm.logInteraction,
  );
  tool(
    'list_interactions',
    'List meetings, calls and emails, newest first. Filters combine (AND).',
    {
      person: personRef.optional(),
      organization: z.string().optional().describe('Interactions with anyone at this organization.'),
      type: z.enum(crm.INTERACTION_TYPES).optional(),
      since: day.optional(),
      until: day.optional().describe('Includes this date.'),
      logged_by: teammateRef.optional(),
      limit: z.number().int().optional().describe('Default 25, max 200.'),
    },
    READ,
    crm.listInteractions,
  );
  tool(
    'delete_interaction',
    'Delete an interaction that was logged by mistake. Confirm with the user first.',
    { interaction_id: z.string() },
    CHANGE,
    crm.deleteInteraction,
  );

  // Actions
  tool(
    'add_action',
    'Add a follow-up or a suggested email. Use status "suggested" for anything the user has not approved yet. Email drafts go in draft_subject and draft_body; the CRM never sends them.',
    {
      title: z.string(),
      type: z.enum(crm.ACTION_TYPES).optional().describe('Default follow_up.'),
      status: z.enum(['suggested', 'approved']).optional().describe('Default suggested.'),
      person: personRef.optional(),
      due_date: day.optional(),
      assigned_to: teammateRef.optional().describe('Default: you.'),
      draft_subject: z.string().optional(),
      draft_body: z.string().optional(),
      notes: z.string().optional(),
    },
    ADD,
    crm.addAction,
  );
  tool(
    'list_actions',
    'List follow-ups and suggested emails, soonest due first.',
    {
      status: z.enum(['open', 'all', ...crm.ACTION_STATUSES]).optional().describe('Default open (suggested + approved).'),
      assigned_to: teammateRef.optional(),
      person: personRef.optional(),
      due_before: day.optional(),
      limit: z.number().int().optional().describe('Default 25, max 200.'),
    },
    READ,
    crm.listActions,
  );
  tool(
    'update_action',
    'Approve, finish or dismiss an action, or edit it. Only the fields you pass change; pass an empty string to clear due_date or assigned_to.',
    {
      action_id: z.string(),
      status: z.enum(crm.ACTION_STATUSES).optional(),
      title: z.string().optional(),
      type: z.enum(crm.ACTION_TYPES).optional(),
      due_date: z.string().optional(),
      assigned_to: z.string().optional(),
      draft_subject: z.string().optional(),
      draft_body: z.string().optional(),
      notes: z.string().optional(),
    },
    CHANGE,
    crm.updateAction,
  );

  return server;
}

// `db` is passed in by tests; in production each request opens and closes its own.
export async function handleMcp(request, { db } = {}) {
  let database;
  try {
    database = db || openDb();
  } catch (err) {
    console.error(err);
    return json(503, { error: 'The CRM database is not reachable or not set up yet.' });
  }
  try {
    // A secret key (Claude Code), or an access token from Google sign-in (Claude's apps).
    const header = request.headers.get('authorization');
    let me;
    try {
      me =
        (await userForAuthHeader(database, header)) ||
        (await userForAccessToken(database, header, siteUrls(request).resource));
    } catch (err) {
      console.error(err);
      return json(503, { error: 'The CRM database is not reachable or not set up yet.' });
    }
    if (!me) return unauthorized(request, Boolean(header));
    if (request.method !== 'POST') return methodNotAllowed('POST');

    const server = buildServer(database, me);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(request);
    } finally {
      await server.close();
    }
  } finally {
    if (!db) await database.end().catch((err) => console.error(err));
  }
}
