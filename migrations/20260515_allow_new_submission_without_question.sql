begin;

alter table study_submission
  drop constraint if exists study_submission_question_id_fkey;

alter table study_submission
  alter column question_id drop not null;

alter table study_submission
  add column if not exists stable_id text,
  add column if not exists content_pack_id text,
  add column if not exists topic text,
  add column if not exists tags text[],
  add column if not exists prompt_text text,
  add column if not exists answer_text text,
  add column if not exists truth_statement_text text,
  add column if not exists authored_text text,
  add column if not exists cloze_variants_json jsonb,
  add column if not exists proposed_cloze_variants_json jsonb;

create index if not exists idx_submission_question_id
  on study_submission(question_id);

create index if not exists idx_submission_stable_id
  on study_submission(stable_id);

commit;
