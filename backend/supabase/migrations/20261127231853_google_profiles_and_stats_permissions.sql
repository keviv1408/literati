create or replace function public.initialize_user_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.user_profiles (id, display_name, avatar_id)
  values (
    new.id,
    left(coalesce(
      nullif(trim(new.raw_user_meta_data->>'display_name'), ''),
      nullif(trim(new.raw_user_meta_data->>'full_name'), ''),
      nullif(trim(new.raw_user_meta_data->>'name'), ''),
      nullif(split_part(new.email, '@', 1), ''),
      'Player'
    ), 20),
    left(coalesce(nullif(new.raw_user_meta_data->>'avatar_id', ''), 'avatar-1'), 20)
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

revoke insert, update, delete, truncate, references, trigger on public.user_stats
  from public, anon, authenticated;

revoke execute on function
  public.increment_user_stats(uuid, integer, integer, integer, integer, integer, integer),
  public.increment_user_stats(uuid, integer, integer, integer, integer, integer, integer, integer)
  from public, anon, authenticated;

grant execute on function
  public.increment_user_stats(uuid, integer, integer, integer, integer, integer, integer),
  public.increment_user_stats(uuid, integer, integer, integer, integer, integer, integer, integer)
  to service_role;
