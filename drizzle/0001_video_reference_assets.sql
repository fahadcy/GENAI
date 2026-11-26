alter table "video_generations"
  add column if not exists "reference_assets" jsonb not null default '[]'::jsonb;
