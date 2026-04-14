create table if not exists app_user (
  id uuid primary key,
  apple_sub text unique not null,
  email text,
  display_name text,
  role text not null default 'user',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists study_question (
  id uuid primary key,
  stable_id text unique not null,
  content_pack_id text,
  topic text,
  tags text[],
  prompt_text text not null,
  answer_text text,
  truth_statement_text text,
  cloze_variants_json jsonb,
  status text not null default 'published',
  author_id uuid references app_user(id),
  contributor_id uuid references app_user(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists study_submission (
  id uuid primary key,
  question_id uuid references study_question(id),
  submitter_id uuid references app_user(id),
  submitter_alias text,
  reason text,
  note text,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists moderation_event (
  id uuid primary key,
  submission_id uuid references study_submission(id),
  moderator_id uuid references app_user(id),
  action text not null,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists idx_submission_status on study_submission(status);
create index if not exists idx_question_status on study_question(status);
create index if not exists idx_question_updated on study_question(updated_at);

-- Migration: run once in Railway SQL editor if the table already exists
-- alter table study_question add column if not exists source_origin text default '';
