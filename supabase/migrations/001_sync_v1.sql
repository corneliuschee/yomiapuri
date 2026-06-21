-- Supabase Sync V1 schema for the local-first Japanese reader.
-- Run this in the Supabase SQL editor for the project used by the app.

create extension if not exists "pgcrypto";

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  updated_at timestamptz default now()
);

create table if not exists public.devices (
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id text not null,
  name text not null,
  platform text,
  last_seen_at timestamptz default now(),
  primary key (user_id, device_id)
);

create table if not exists public.document_files (
  user_id uuid not null references auth.users(id) on delete cascade,
  file_hash text not null,
  filename text,
  storage_path text not null,
  content_type text,
  size_bytes bigint default 0,
  created_at timestamptz default now(),
  primary key (user_id, file_hash)
);

create table if not exists public.documents (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  title text not null,
  filename text,
  type text,
  order_index integer default 0,
  cover_path text,
  source_path text,
  file_hash text,
  content jsonb default '{}'::jsonb,
  deleted_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  primary key (user_id, id)
);

create table if not exists public.reading_progress (
  user_id uuid not null references auth.users(id) on delete cascade,
  document_id text not null,
  page integer default 0,
  chapter_id text,
  mode text default 'scroll',
  percentage numeric default 0,
  scroll_top numeric default 0,
  zoom numeric default 100,
  updated_at timestamptz default now(),
  primary key (user_id, document_id)
);

create table if not exists public.reader_annotations (
  user_id uuid not null references auth.users(id) on delete cascade,
  document_id text not null,
  kind text not null,
  payload jsonb default '{}'::jsonb,
  updated_at timestamptz default now(),
  primary key (user_id, document_id, kind)
);

create table if not exists public.known_terms (
  user_id uuid not null references auth.users(id) on delete cascade,
  term text not null,
  meta jsonb default '{}'::jsonb,
  deleted_at timestamptz,
  updated_at timestamptz default now(),
  primary key (user_id, term)
);

create table if not exists public.cards (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  document_id text,
  expression text,
  dictionary_form text,
  anki_note_id bigint,
  payload jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  primary key (user_id, id)
);

create table if not exists public.app_settings (
  user_id uuid not null references auth.users(id) on delete cascade,
  key text not null,
  value jsonb default '{}'::jsonb,
  updated_at timestamptz default now(),
  primary key (user_id, key)
);

create table if not exists public.learning_events (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  type text not null,
  payload jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  primary key (user_id, id)
);

create table if not exists public.sync_state (
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id text not null,
  last_push_at timestamptz,
  last_pull_at timestamptz,
  updated_at timestamptz default now(),
  primary key (user_id, device_id)
);

alter table public.profiles enable row level security;
alter table public.devices enable row level security;
alter table public.document_files enable row level security;
alter table public.documents enable row level security;
alter table public.reading_progress enable row level security;
alter table public.reader_annotations enable row level security;
alter table public.known_terms enable row level security;
alter table public.cards enable row level security;
alter table public.app_settings enable row level security;
alter table public.learning_events enable row level security;
alter table public.sync_state enable row level security;

create policy "profiles own rows" on public.profiles for all using (auth.uid() = id) with check (auth.uid() = id);
create policy "devices own rows" on public.devices for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "document_files own rows" on public.document_files for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "documents own rows" on public.documents for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "reading_progress own rows" on public.reading_progress for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "reader_annotations own rows" on public.reader_annotations for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "known_terms own rows" on public.known_terms for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "cards own rows" on public.cards for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "app_settings own rows" on public.app_settings for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "learning_events own rows" on public.learning_events for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "sync_state own rows" on public.sync_state for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

insert into storage.buckets (id, name, public)
values ('book-files', 'book-files', false)
on conflict (id) do nothing;

create policy "book files readable by owner"
on storage.objects for select
using (bucket_id = 'book-files' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "book files writable by owner"
on storage.objects for insert
with check (bucket_id = 'book-files' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "book files updatable by owner"
on storage.objects for update
using (bucket_id = 'book-files' and (storage.foldername(name))[1] = auth.uid()::text)
with check (bucket_id = 'book-files' and (storage.foldername(name))[1] = auth.uid()::text);
