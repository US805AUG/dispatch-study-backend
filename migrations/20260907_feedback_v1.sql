begin;

create table if not exists feedback_v1_response (
  id uuid primary key,
  prompt_instance_id uuid unique not null,
  install_id text not null,
  feedback_version integer not null check (feedback_version = 1),
  journey_stage text not null,
  school text,
  job_to_be_done text not null,
  current_value text not null,
  retention_text text,
  discovery_source text,
  purchase_answer text,
  subscriber_state text not null,
  app_version text,
  build_number text,
  platform text,
  tester_interest_at timestamptz,
  submitted_at timestamptz not null default now()
);

create index if not exists idx_feedback_v1_response_submitted
  on feedback_v1_response(submitted_at desc);

create index if not exists idx_feedback_v1_response_install
  on feedback_v1_response(install_id);

create table if not exists feedback_v1_contact (
  id uuid primary key,
  response_id uuid unique not null references feedback_v1_response(id) on delete cascade,
  email text not null,
  consent_version text not null,
  created_at timestamptz not null default now()
);

commit;
