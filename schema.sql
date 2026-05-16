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
  source_origin text,
  status text not null default 'published',
  author_id uuid references app_user(id),
  contributor_id uuid references app_user(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists study_submission (
  id uuid primary key,
  question_id uuid,
  stable_id text,
  content_pack_id text,
  topic text,
  tags text[],
  prompt_text text,
  answer_text text,
  truth_statement_text text,
  authored_text text,
  cloze_variants_json jsonb,
  submitter_id uuid references app_user(id),
  submitter_alias text,
  reason text,
  note text,
  proposed_cloze_variants_json jsonb,
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
create index if not exists idx_submission_question_id on study_submission(question_id);
create index if not exists idx_submission_stable_id on study_submission(stable_id);
create index if not exists idx_question_status on study_question(status);
create index if not exists idx_question_updated on study_question(updated_at);

-- Migration: run once in Railway SQL editor if the table already exists
-- alter table study_question add column if not exists source_origin text default '';
-- alter table study_submission drop constraint if exists study_submission_question_id_fkey;
-- alter table study_submission alter column question_id drop not null;
