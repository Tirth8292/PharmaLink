create extension if not exists "pgcrypto";

create table if not exists public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  email text unique not null,
  role text not null default 'patient'
);

create table if not exists public.doctors (
  id bigint generated always as identity primary key,
  user_id uuid unique references public.users(id) on delete cascade,
  name text not null,
  specialization text not null,
  fees numeric(10,2) not null default 0,
  availability text not null default 'Available today',
  is_available boolean not null default true,
  available_slots jsonb not null default '[]'::jsonb,
  start_time text not null default '09:00',
  end_time text not null default '17:00',
  slot_duration integer not null default 30,
  city text not null default 'Mumbai'
);

create table if not exists public.labs (
  id bigint generated always as identity primary key,
  name text not null,
  tests jsonb not null default '[]'::jsonb,
  price numeric(10,2) not null default 0
);

create table if not exists public.medicines (
  id bigint generated always as identity primary key,
  name text not null,
  price numeric(10,2) not null default 0,
  stock integer not null default 0,
  category text not null default 'General',
  dosage text not null default '500mg',
  description text not null default ''
);

create table if not exists public.cart (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  product_id bigint not null references public.medicines(id) on delete cascade,
  quantity integer not null default 1
);

create table if not exists public.orders (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  total numeric(10,2) not null default 0,
  status text not null default 'Placed',
  address text,
  delivery_status text not null default 'Placed',
  estimated_delivery_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.appointments (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  doctor_id bigint not null references public.doctors(id) on delete cascade,
  date timestamptz not null,
  status text not null default 'Confirmed',
  slot_label text,
  consultation_fee numeric(10,2) not null default 0
);

create table if not exists public.subscriptions (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  medicine_id bigint not null references public.medicines(id) on delete cascade,
  interval text not null default 'monthly',
  next_refill_at timestamptz not null default (now() + interval '30 days')
);

alter table if exists public.doctors add column if not exists is_available boolean not null default true;
alter table if exists public.doctors add column if not exists available_slots jsonb not null default '[]'::jsonb;
alter table if exists public.doctors add column if not exists start_time text not null default '09:00';
alter table if exists public.doctors add column if not exists end_time text not null default '17:00';
alter table if exists public.doctors add column if not exists slot_duration integer not null default 30;
alter table if exists public.doctors add column if not exists city text not null default 'Mumbai';
alter table if exists public.doctors add column if not exists user_id uuid references public.users(id) on delete cascade;
create unique index if not exists doctors_user_id_key on public.doctors(user_id) where user_id is not null;

alter table if exists public.medicines add column if not exists category text not null default 'General';
alter table if exists public.medicines add column if not exists dosage text not null default '500mg';
alter table if exists public.medicines add column if not exists description text not null default '';

alter table if exists public.orders add column if not exists address text;
alter table if exists public.orders add column if not exists delivery_status text not null default 'Placed';
alter table if exists public.orders add column if not exists estimated_delivery_at timestamptz;

alter table if exists public.appointments add column if not exists slot_label text;
alter table if exists public.appointments add column if not exists consultation_fee numeric(10,2) not null default 0;

alter table public.users enable row level security;
alter table public.cart enable row level security;
alter table public.orders enable row level security;
alter table public.appointments enable row level security;
alter table public.doctors enable row level security;
alter table public.labs enable row level security;
alter table public.medicines enable row level security;
alter table public.subscriptions enable row level security;

drop policy if exists "Users can view own profile" on public.users;
create policy "Users can view own profile" on public.users for select using (auth.uid() = id);
drop policy if exists "Users can update own profile" on public.users;
create policy "Users can update own profile" on public.users for update using (auth.uid() = id);
drop policy if exists "Users can insert own profile" on public.users;
create policy "Users can insert own profile" on public.users for insert with check (auth.uid() = id);

drop policy if exists "Authenticated users can read doctors" on public.doctors;
create policy "Authenticated users can read doctors" on public.doctors for select to authenticated using (true);
drop policy if exists "Doctors can update own profile" on public.doctors;
create policy "Doctors can update own profile" on public.doctors for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "Doctors can claim unlinked profile" on public.doctors;
create policy "Doctors can claim unlinked profile" on public.doctors
for update to authenticated
using (
  user_id is null
  and (
    coalesce((auth.jwt()->'user_metadata'->>'doctor_record_id')::bigint, -1) = id
    or coalesce((auth.jwt()->'raw_user_meta_data'->>'doctor_record_id')::bigint, -1) = id
  )
)
with check (auth.uid() = user_id);
drop policy if exists "Doctors can insert own profile" on public.doctors;
create policy "Doctors can insert own profile" on public.doctors for insert to authenticated with check (auth.uid() = user_id);

create or replace function public.claim_doctor_profile(target_doctor_id bigint)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  current_doctor_id bigint;
  target_owner uuid;
  target_name text;
  current_name text;
  jwt_doctor_record_id text := coalesce(
    auth.jwt()->'user_metadata'->>'doctor_record_id',
    auth.jwt()->'raw_user_meta_data'->>'doctor_record_id',
    ''
  );
  is_doctor boolean := exists (
    select 1
    from public.users
    where id = current_user_id
      and role = 'doctor'
  ) or coalesce(
    auth.jwt()->'user_metadata'->>'role',
    auth.jwt()->'raw_user_meta_data'->>'role',
    ''
  ) = 'doctor';
begin
  if current_user_id is null then
    raise exception 'You must be logged in to claim a doctor profile.';
  end if;

  if not is_doctor then
    raise exception 'Only doctor accounts can claim doctor profiles.';
  end if;

  select id into current_doctor_id
  from public.doctors
  where user_id = current_user_id
  limit 1;

  if current_doctor_id is not null then
    return current_doctor_id;
  end if;

  select user_id, name
  into target_owner, target_name
  from public.doctors
  where id = target_doctor_id;

  if not found then
    raise exception 'Doctor profile not found.';
  end if;

  if target_owner = current_user_id then
    return target_doctor_id;
  end if;

  if target_owner is not null then
    raise exception 'This doctor profile is already linked to another account.';
  end if;

  select coalesce(name, '') into current_name
  from public.users
  where id = current_user_id;

  if jwt_doctor_record_id <> target_doctor_id::text
     and lower(trim(coalesce(current_name, ''))) <> lower(trim(coalesce(target_name, ''))) then
    raise exception 'This doctor profile cannot be claimed by the current account.';
  end if;

  update public.doctors
  set user_id = current_user_id
  where id = target_doctor_id
    and user_id is null;

  return target_doctor_id;
end;
$$;

grant execute on function public.claim_doctor_profile(bigint) to authenticated;

drop policy if exists "Authenticated users can read labs" on public.labs;
create policy "Authenticated users can read labs" on public.labs for select to authenticated using (true);

drop policy if exists "Authenticated users can read medicines" on public.medicines;
create policy "Authenticated users can read medicines" on public.medicines for select to authenticated using (true);
drop policy if exists "Authenticated users can update medicines" on public.medicines;
create policy "Authenticated users can update medicines" on public.medicines for update to authenticated using (true) with check (true);

drop policy if exists "Users manage own cart" on public.cart;
create policy "Users manage own cart" on public.cart for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "Users manage own orders" on public.orders;
create policy "Users manage own orders" on public.orders for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "Users manage own appointments" on public.appointments;
create policy "Users manage own appointments" on public.appointments for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "Users manage own subscriptions" on public.subscriptions;
create policy "Users manage own subscriptions" on public.subscriptions for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

insert into public.doctors (name, specialization, fees, availability, is_available, start_time, end_time, slot_duration, city, available_slots) values
  ('Dr. Emma Wilson', 'Cardiology', 1200, 'Available today', true, '09:00', '15:00', 30, 'Mumbai', '[{"label":"09:00","booked":false,"manualDisabled":false},{"label":"09:30","booked":false,"manualDisabled":false}]'),
  ('Dr. Arjun Mehta', 'Dermatology', 900, 'Next slot 2 PM', true, '10:00', '17:00', 20, 'Delhi', '[{"label":"14:00","booked":false,"manualDisabled":false},{"label":"14:20","booked":true,"manualDisabled":false}]'),
  ('Dr. Sofia Khan', 'Pediatrics', 800, 'Available tomorrow', true, '08:30', '13:30', 30, 'Bangalore', '[{"label":"10:00","booked":false,"manualDisabled":false}]'),
  ('Dr. David Chen', 'Orthopedics', 1500, 'On leave today', false, '11:00', '18:00', 30, 'Hyderabad', '[]')
on conflict do nothing;

insert into public.labs (name, tests, price) values
  ('HealthFirst Diagnostics', '["CBC", "Lipid Profile", "Thyroid"]', 1499),
  ('CarePath Labs', '["Vitamin D", "Iron Study", "Blood Sugar"]', 999),
  ('Prime Scan Lab', '["Liver Function", "Kidney Function", "HbA1c"]', 1799)
on conflict do nothing;

insert into public.medicines (name, price, stock, category, dosage, description) values
  ('Paracetamol', 35, 120, 'General', '500mg', 'Fast relief for fever and mild pain.'),
  ('Insulin FlexPen', 850, 40, 'Insulin', '10 units', 'Monthly insulin refill support for diabetic patients.'),
  ('Amoxicillin', 220, 70, 'Prescription', '250mg', 'Prescription antibiotic for bacterial infections.'),
  ('Vitamin C Tablets', 180, 90, 'General', '1000mg', 'Daily immunity support tablets.')
on conflict do nothing;
