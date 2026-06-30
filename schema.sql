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
  created_by_user_id uuid references app_user(id),
  canonical_stable_id text,
  based_on_question_id text,
  moderation_status text,
  content_hash text,
  is_local_only boolean not null default false,
  is_community_question boolean not null default true,
  submitted_to_community_at timestamptz,
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
  content_hash text,
  canonical_stable_id text,
  based_on_question_id text,
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

create table if not exists app_event (
  id uuid primary key,
  install_id text,
  name text not null,
  platform text,
  app_version text,
  build_number text,
  device_family text,
  os_version text,
  locale text,
  locale_region text,
  time_zone text,
  properties jsonb not null default '{}'::jsonb,
  country text,
  region text,
  city text,
  geolocation_source text,
  likely_school_region text not null default 'Unknown',
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists idx_submission_status on study_submission(status);
create index if not exists idx_submission_question_id on study_submission(question_id);
create index if not exists idx_submission_stable_id on study_submission(stable_id);
create index if not exists idx_submission_content_hash on study_submission(content_hash);
create index if not exists idx_question_content_hash on study_question(content_hash);
create index if not exists idx_question_status on study_question(status);
create index if not exists idx_question_updated on study_question(updated_at);
create index if not exists idx_app_event_name_created on app_event(name, created_at);
create index if not exists idx_app_event_install_created on app_event(install_id, created_at);
create index if not exists idx_app_event_likely_region on app_event(likely_school_region);

-- Migration: run once in Railway SQL editor if the table already exists
-- alter table study_question add column if not exists source_origin text default '';
-- alter table study_submission drop constraint if exists study_submission_question_id_fkey;
-- alter table study_submission alter column question_id drop not null;
-- update study_question set canonical_stable_id = stable_id where status in ('published', 'approved') and (canonical_stable_id is null or btrim(canonical_stable_id) = '');
