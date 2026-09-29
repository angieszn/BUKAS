-- Bukas — Supabase schema
-- Paste this whole file into the Supabase SQL editor and run it once.

create extension if not exists pgcrypto;

create table if not exists public.entries (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  body         text not null default '',
  written_at   timestamptz not null default now(),
  return_at    timestamptz,               -- drawn once, at seal time. Never recalculated.
  delivered_at timestamptz,               -- set when a return is actually shown. Used only to meter delivery.
  prompt_text  text,                      -- the prompt shown when this was written, if any. Text only, never a group.
  state        text not null default 'draft'
               check (state in ('draft', 'sealed', 'returned'))
);

-- If you already ran an earlier version of this file:
alter table public.entries add column if not exists prompt_text text;

-- Only index what delivery needs.
create index if not exists entries_delivery_idx
  on public.entries (user_id, state, return_at);

-- One draft per user. (Clears any orphaned empty drafts first, so the index
-- can be created on an existing table.)
delete from public.entries where state = 'draft' and btrim(body) = '';
create unique index if not exists entries_one_draft_per_user
  on public.entries (user_id) where state = 'draft';

alter table public.entries enable row level security;

drop policy if exists "entries are own rows only (select)" on public.entries;
drop policy if exists "entries are own rows only (insert)" on public.entries;
drop policy if exists "entries are own rows only (update)" on public.entries;
drop policy if exists "entries are own rows only (delete)" on public.entries;

create policy "entries are own rows only (select)"
  on public.entries for select using (auth.uid() = user_id);

create policy "entries are own rows only (insert)"
  on public.entries for insert with check (auth.uid() = user_id);

create policy "entries are own rows only (update)"
  on public.entries for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "entries are own rows only (delete)"
  on public.entries for delete using (auth.uid() = user_id);


-- Lets a signed-in user delete their own account. Entries go with it
-- (on delete cascade). The anon key alone cannot delete auth users,
-- so this runs with definer rights and only ever touches auth.uid().
create or replace function public.delete_my_account()
returns void
language sql
security definer
set search_path = public, auth
as $$
  delete from auth.users where id = auth.uid();
$$;

revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
