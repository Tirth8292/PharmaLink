begin;

insert into public.users (id, name, email, role)
select
  au.id,
  coalesce(nullif(au.raw_user_meta_data->>'name', ''), 'harvi shah'),
  au.email,
  'doctor'
from auth.users au
where au.email = 'harvishah4246@gmail.com'
on conflict (id) do update
set
  name = excluded.name,
  email = excluded.email,
  role = 'doctor';

with target_user as (
  select id
  from public.users
  where email = 'harvishah4246@gmail.com'
  limit 1
)
update public.doctors d
set user_id = tu.id
from target_user tu
where d.id = 5
  and (d.user_id is null or d.user_id = tu.id);

commit;

select
  d.id,
  d.name,
  d.user_id,
  d.city,
  d.fees,
  d.start_time,
  d.end_time,
  d.slot_duration
from public.doctors d
where d.id = 5;
