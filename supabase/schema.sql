-- Supabase schema for the hybrid POS.
-- Run this once in the Supabase dashboard -> SQL Editor.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Products: read by web + android, cached locally on android for offline use.
-- ---------------------------------------------------------------------------
create table if not exists public.products (
  id         uuid primary key default gen_random_uuid(),
  name       text        not null,
  price      numeric(10,2) not null check (price >= 0),
  stock      integer     not null default 0 check (stock >= 0),
  category   text        not null default 'general',
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Sales. client_ref is generated on the device BEFORE the sale is sent.
-- The unique constraint is what makes offline sync retries safe: a sale that
-- was actually saved but whose response was lost will collide instead of
-- being double-counted.
-- ---------------------------------------------------------------------------
create table if not exists public.sales (
  id         uuid primary key default gen_random_uuid(),
  client_ref text        not null unique,
  source     text        not null default 'web',   -- 'web' | 'android'
  total      numeric(10,2) not null check (total >= 0),
  items      jsonb       not null,                 -- [{id,name,price,qty}]
  sold_at    timestamptz not null default now()
);

create index if not exists sales_sold_at_idx on public.sales (sold_at desc);

-- ---------------------------------------------------------------------------
-- Row Level Security.
-- The anon key ships inside the web page and the APK, so it is public.
-- Without these policies anyone holding it could rewrite your catalog.
-- Default here: anyone may read products and insert a sale; nobody may
-- update/delete anything with the anon key.
-- ---------------------------------------------------------------------------
alter table public.products enable row level security;
alter table public.sales    enable row level security;

drop policy if exists products_read on public.products;
create policy products_read on public.products
  for select using (true);

drop policy if exists sales_insert on public.sales;
create policy sales_insert on public.sales
  for insert with check (true);

-- Sales are write-only from the devices. Read them from the dashboard or with
-- the service_role key on a server you control.
drop policy if exists sales_read on public.sales;
create policy sales_read on public.sales
  for select using (false);

-- ---------------------------------------------------------------------------
-- Seed data so both clients have something to show immediately.
-- ---------------------------------------------------------------------------
insert into public.products (name, price, stock, category) values
  ('Espresso',        2.50,  100, 'drinks'),
  ('Cappuccino',      3.75,  100, 'drinks'),
  ('Iced Latte',      4.25,   80, 'drinks'),
  ('Butter Croissant',2.95,   40, 'bakery'),
  ('Blueberry Muffin',3.10,   35, 'bakery'),
  ('Cheese Sandwich', 5.50,   25, 'food'),
  ('Veg Wrap',        6.00,   20, 'food'),
  ('Still Water',     1.20,  200, 'drinks')
on conflict do nothing;
