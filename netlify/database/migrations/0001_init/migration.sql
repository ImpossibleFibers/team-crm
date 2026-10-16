-- Team CRM: first schema.
-- gen_random_uuid() is built into Postgres 13+, so no extensions are needed.

-- Teammates. Every change in the CRM records which teammate made it.
create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  name text not null,
  created_at timestamptz not null default now()
);
create unique index users_email_key on users (lower(email));

-- Secret keys that let a teammate's Claude reach the CRM.
-- Only a SHA-256 hash is stored; the key itself is shown once when it's made.
create table api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  label text not null default '',
  key_hash text not null unique,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create table organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  type text not null default 'other'
    check (type in ('funder', 'investor', 'customer', 'partner', 'supplier', 'research', 'other')),
  relationship text not null default 'in_touch'
    check (relationship in ('collaborating', 'want_to_collaborate', 'in_touch')),
  website text,
  notes text not null default '',
  created_by uuid references users (id) on delete set null,
  updated_by uuid references users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index organizations_name_key on organizations (lower(name));

create table people (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text,
  organization_id uuid references organizations (id) on delete set null,
  role text,
  relationship text not null default 'in_touch'
    check (relationship in ('collaborating', 'want_to_collaborate', 'in_touch')),
  -- The teammate who owns this relationship.
  owner_id uuid references users (id) on delete set null,
  how_we_met text,
  notes text not null default '',
  created_by uuid references users (id) on delete set null,
  updated_by uuid references users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index people_email_key on people (lower(email)) where email is not null;
create index people_organization_idx on people (organization_id);

-- Topics people are useful for: Robotics, Fundraising, ...
create table tags (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text not null default '',
  created_by uuid references users (id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index tags_name_key on tags (lower(name));

-- A tag on a person, with a note on why they're useful for that topic.
create table person_tags (
  person_id uuid not null references people (id) on delete cascade,
  tag_id uuid not null references tags (id) on delete cascade,
  useful_for text not null default '',
  added_by uuid references users (id) on delete set null,
  added_at timestamptz not null default now(),
  primary key (person_id, tag_id)
);
create index person_tags_tag_idx on person_tags (tag_id);

-- Meetings, calls, emails. "Last contacted" is the newest of these.
create table interactions (
  id uuid primary key default gen_random_uuid(),
  type text not null
    check (type in ('meeting', 'call', 'email_sent', 'email_received', 'message', 'event')),
  occurred_at timestamptz not null default now(),
  summary text not null,
  details text not null default '',
  logged_by uuid references users (id) on delete set null,
  -- 'manual' for entries Claude logs in conversation; 'gmail' for the later automatic email sync.
  source text not null default 'manual',
  -- For automatic sources, the outside ID (e.g. a Gmail message ID), so nothing is logged twice.
  external_id text,
  created_at timestamptz not null default now()
);
create unique index interactions_external_key on interactions (source, external_id)
  where external_id is not null;
create index interactions_occurred_idx on interactions (occurred_at desc);

-- One interaction can involve several people (a meeting, an email with three recipients).
create table interaction_people (
  interaction_id uuid not null references interactions (id) on delete cascade,
  person_id uuid not null references people (id) on delete cascade,
  primary key (interaction_id, person_id)
);
create index interaction_people_person_idx on interaction_people (person_id);

-- Follow-ups and suggested emails. Claude suggests; a teammate approves, finishes or dismisses.
create table actions (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  type text not null default 'follow_up'
    check (type in ('email', 'follow_up', 'meeting', 'other')),
  status text not null default 'suggested'
    check (status in ('suggested', 'approved', 'done', 'dismissed')),
  person_id uuid references people (id) on delete cascade,
  due_date date,
  assigned_to uuid references users (id) on delete set null,
  draft_subject text,
  draft_body text,
  notes text not null default '',
  created_by uuid references users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);
create index actions_status_idx on actions (status, due_date);
create index actions_person_idx on actions (person_id);
