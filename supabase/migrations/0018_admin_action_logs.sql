-- 0018_admin_action_logs.sql
-- Audit log table: every chatbot action is recorded here.
-- Provides: action name, sanitised args, result summary, and timestamp.
-- Used for debugging, accountability, and reviewing AI-driven changes.

create table if not exists admin_action_logs (
  id          bigserial    primary key,
  action_name text         not null,
  args        jsonb,
  result      jsonb,
  created_at  timestamptz  not null default now()
);

create index if not exists admin_action_logs_action_name_idx on admin_action_logs (action_name);
create index if not exists admin_action_logs_created_at_idx  on admin_action_logs (created_at desc);
