-- Phase 3A.1 — embedding worker Cron plumbing.
--
-- Enables pg_net + pg_cron (verified live: pg_net resolves as net.http_post,
-- pg_cron as cron.schedule) and schedules the embed-worker tick every
-- minute. The schedule references Vault secret NAMES only; values are
-- provisioned operationally (embed_worker_url, embed_worker_key) and never
-- appear here. Until those Vault secrets exist, ticks fail closed without
-- touching job state. Re-running this migration replaces the schedule
-- (unschedule is a no-op when absent).

create extension if not exists "pg_net";
create extension if not exists "pg_cron";

select cron.schedule(
  'embed-worker-tick',
  '* * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'embed_worker_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-worker-key', (select decrypted_secret from vault.decrypted_secrets where name = 'embed_worker_key')
    ),
    body := '{"tick": true}'::jsonb
  ) as request_id;
  $$
);
