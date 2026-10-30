# M-Hustle v1.0 — Complete Build Blueprint

**The premium campus marketplace for Maseno University — a HartTech product.**

This document contains the complete, production-ready implementation in the exact section order requested:
Supabase setup, frontend configuration, helpers and components, every page, then deployment and verification notes.

The source of truth is the `m-hustle/` directory. Every file printed below exists there, and the production
bundle has been built successfully. Nothing in the app uses mock data: every listing, order, subscription,
message and statistic is read from Supabase through RLS-protected queries.

| Item | Value |
| --- | --- |
| Product | M-Hustle v1.0 |
| Built by | HartTech |
| Support | helloharttech@gmail.com |
| Audience | Maseno University students |
| Frontend | React 18 + Vite 5 |
| Styling | Tailwind CSS 3, custom glass design system |
| Backend | Supabase only (PostgreSQL, Auth, Storage, Realtime) |
| Icons | lucide-react — no emoji in the UI |
| Payments | On handover; subscriptions by manual M-Pesa code approval |
| Currency | KES |

---

## Table of contents

1. [SECTION 1 — Supabase setup](#section-1--supabase-setup)
2. [SECTION 2 — Frontend configuration](#section-2--frontend-configuration)
3. [SECTION 3 — Supabase helpers and components](#section-3--supabase-helpers-and-components)
4. [SECTION 4 — Pages](#section-4--pages)
5. [SECTION 5 — Deployment, security and verification](#section-5--deployment-security-and-verification)

---

# SECTION 1 — Supabase setup

## 1.1 Create the project

1. Create a project at [supabase.com](https://supabase.com).
2. Copy **Project URL** and the **anon public** key from **Project Settings → API**.
   The URL must be exactly `https://<project-ref>.supabase.co` — never prefix it with
   `your-project-`. A wrong host produces `ERR_NAME_NOT_RESOLVED` in the browser.
3. Open **SQL Editor → New query**, paste the entire schema below, and run it once.
4. Confirm **Storage → listing-images** exists and is public (the script creates it).
5. In **Authentication → URL Configuration**, set the Site URL to `http://localhost:5173`
   for development and add your deployed origin for production. Add both to Redirect URLs.
6. In **Authentication → Providers → Email**, turn **Confirm email** OFF. This is the switch
   that removes the verification step; new users are signed in immediately after registering.
7. Promote your first account to admin after registering (see 1.5).
8. If the project already existed before username login was added, run
   `supabase/migrations/001_username_login.sql` once in the SQL Editor (printed in 1.2b).
   If it predates listing quantities, ratings or hostel locations, also run
   `supabase/migrations/002_quantities_reviews_profile.sql` (printed in 1.2c).

The script is idempotent where practical, so it can be re-run after edits. It creates:

- the enums and seven tables with foreign keys, checks and indexes;
- the auth trigger that provisions a profile for every new user;
- authorization helpers, including `is_admin()`, `is_seller()`, `is_active_user()` and username login;
- the atomic checkout RPC `create_order()`, which computes totals from database prices and reserves stock;
- seller rating aggregation and review RLS;
- admin RPCs for listing users, suspending, deleting and platform statistics;
- triggers guarding roles, order totals, message content, cancellations and listing status;
- Row Level Security for every table;
- the public storage bucket and its object policies;
- the realtime publication for chat.

## 1.2 Complete SQL script

```sql
-- ============================================================================
--  M-HUSTLE v1.0  ·  SUPABASE SCHEMA, FUNCTIONS, TRIGGERS & ROW LEVEL SECURITY
--  Run this entire file once in: Supabase Dashboard → SQL Editor → New query.
--  It is idempotent where practical, so it can be re-run safely.
-- ============================================================================

create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

-- ----------------------------------------------------------------------------
-- 1. ENUMS
-- ----------------------------------------------------------------------------
do $$ begin
  create type public.user_role as enum ('admin', 'seller', 'buyer');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.listing_status as enum ('active', 'sold', 'deleted');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.order_status as enum ('pending', 'delivered', 'completed', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.subscription_plan as enum ('pro', 'pro_max');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.subscription_status as enum ('pending', 'active', 'expired');
exception when duplicate_object then null; end $$;

-- ----------------------------------------------------------------------------
-- 2. TABLES
-- ----------------------------------------------------------------------------
create table if not exists public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  username      text not null,
  full_name     text not null,
  email         text not null default '',
  role          public.user_role not null default 'buyer',
  avatar_url    text,
  phone         text,
  location      text,
  is_suspended  boolean not null default false,
  created_at    timestamptz not null default now(),
  constraint profiles_username_format check (username ~ '^[a-z0-9_]{3,20}$'),
  constraint profiles_full_name_length check (char_length(full_name) between 2 and 80),
  constraint profiles_location_check check (
    location is null or location in (
      'Kilimanjaro', 'Niles', 'Nyabundi', 'ACV', 'Equator', 'Elgon',
      'Mara 1', 'Mara 2', 'Mara 3', 'Mara 4', 'Rusinga', 'Ndeere', 'Victoria'
    )
  )
);

create unique index if not exists profiles_username_ci_key
  on public.profiles (lower(username));

create table if not exists public.listings (
  id           uuid primary key default gen_random_uuid(),
  seller_id    uuid not null references public.profiles (id) on delete cascade,
  title        text not null,
  description  text not null default '',
  price        numeric(12, 2) not null,
  category     text not null,
  image_url    text,
  quantity     integer not null default 1,
  status       public.listing_status not null default 'active',
  created_at   timestamptz not null default now(),
  constraint listings_title_length check (char_length(title) between 3 and 120),
  constraint listings_description_length check (char_length(description) <= 4000),
  constraint listings_price_positive check (price > 0 and price <= 100000000),
  constraint listings_quantity_non_negative check (quantity >= 0 and quantity <= 9999)
);

create index if not exists listings_feed_idx
  on public.listings (status, created_at desc);
create index if not exists listings_seller_idx
  on public.listings (seller_id, created_at desc);
create index if not exists listings_title_trgm_idx
  on public.listings using gin (title gin_trgm_ops);
create index if not exists listings_description_trgm_idx
  on public.listings using gin (description gin_trgm_ops);

create table if not exists public.orders (
  id                 uuid primary key default gen_random_uuid(),
  buyer_id           uuid not null references public.profiles (id) on delete cascade,
  seller_id          uuid not null references public.profiles (id) on delete cascade,
  total_amount       numeric(12, 2) not null check (total_amount >= 0),
  status             public.order_status not null default 'pending',
  delivery_location  text,
  contact_phone      text,
  created_at         timestamptz not null default now(),
  constraint orders_distinct_parties check (buyer_id <> seller_id)
);

create index if not exists orders_buyer_idx on public.orders (buyer_id, created_at desc);
create index if not exists orders_seller_idx on public.orders (seller_id, created_at desc);
create index if not exists orders_status_idx on public.orders (status);

create table if not exists public.order_items (
  id                 uuid primary key default gen_random_uuid(),
  order_id           uuid not null references public.orders (id) on delete cascade,
  listing_id         uuid references public.listings (id) on delete set null,
  quantity           integer not null check (quantity between 1 and 99),
  price_at_purchase  numeric(12, 2) not null check (price_at_purchase >= 0),
  unique (order_id, listing_id)
);

create index if not exists order_items_order_idx on public.order_items (order_id);
create index if not exists order_items_listing_idx on public.order_items (listing_id);

create table if not exists public.subscriptions (
  id           uuid primary key default gen_random_uuid(),
  seller_id    uuid not null references public.profiles (id) on delete cascade,
  plan         public.subscription_plan not null,
  status       public.subscription_status not null default 'pending',
  amount       numeric(12, 2) not null default 0 check (amount >= 0),
  expires_at   timestamptz,
  mpesa_code   text not null,
  created_at   timestamptz not null default now(),
  approved_at  timestamptz,
  constraint subscriptions_mpesa_format check (mpesa_code ~ '^[A-Za-z0-9]{6,20}$')
);

create index if not exists subscriptions_seller_idx
  on public.subscriptions (seller_id, created_at desc);
create index if not exists subscriptions_pending_idx
  on public.subscriptions (status, created_at) where status = 'pending';
create unique index if not exists subscriptions_mpesa_ci_key
  on public.subscriptions (upper(mpesa_code));

create table if not exists public.messages (
  id           uuid primary key default gen_random_uuid(),
  sender_id    uuid not null references public.profiles (id) on delete cascade,
  receiver_id  uuid not null references public.profiles (id) on delete cascade,
  listing_id   uuid references public.listings (id) on delete set null,
  content      text not null,
  is_read      boolean not null default false,
  created_at   timestamptz not null default now(),
  constraint messages_content_length check (char_length(content) between 1 and 2000),
  constraint messages_distinct_parties check (sender_id <> receiver_id)
);

create index if not exists messages_thread_idx
  on public.messages (sender_id, receiver_id, created_at);
create index if not exists messages_receiver_unread_idx
  on public.messages (receiver_id, is_read) where is_read = false;

create table if not exists public.reviews (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null unique references public.orders (id) on delete cascade,
  buyer_id    uuid not null references public.profiles (id) on delete cascade,
  seller_id   uuid not null references public.profiles (id) on delete cascade,
  rating      smallint not null,
  comment     text,
  created_at  timestamptz not null default now(),
  constraint reviews_rating_range check (rating between 1 and 5),
  constraint reviews_comment_length check (comment is null or char_length(comment) <= 1000),
  constraint reviews_distinct_parties check (buyer_id <> seller_id)
);

create index if not exists reviews_seller_idx
  on public.reviews (seller_id, created_at desc);
create index if not exists reviews_buyer_idx
  on public.reviews (buyer_id, created_at desc);

-- ----------------------------------------------------------------------------
-- 3. AUTHORIZATION HELPERS
--    SECURITY DEFINER avoids recursive RLS lookups on public.profiles.
-- ----------------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role = 'admin'
      and p.is_suspended = false
  );
$$;

create or replace function public.is_seller()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role = 'seller'
      and p.is_suspended = false
  );
$$;

create or replace function public.is_active_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.is_suspended = false
  );
$$;

create or replace function public.is_username_available(p_username text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when p_username is null then false
    when p_username !~ '^[a-zA-Z0-9_]{3,20}$' then false
    else not exists (
      select 1 from public.profiles p where lower(p.username) = lower(p_username)
    )
  end;
$$;

-- Supabase Auth signs in with an email, so username login resolves the
-- handle to its account email first. Usernames are public marketplace data.
create or replace function public.login_email_for_username(p_username text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select p.email
  from public.profiles p
  where lower(p.username) = lower(trim(p_username))
  limit 1;
$$;

-- get_my_profile gains a column, so drop first to keep the script re-runnable.
drop function if exists public.get_my_profile();

create or replace function public.get_my_profile()
returns table (
  id uuid,
  username text,
  full_name text,
  email text,
  role public.user_role,
  avatar_url text,
  phone text,
  location text,
  is_suspended boolean,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.username, p.full_name, p.email, p.role,
         p.avatar_url, p.phone, p.location, p.is_suspended, p.created_at
  from public.profiles p
  where p.id = auth.uid();
$$;

-- Public badge feed: exposes only seller_id + plan for live subscriptions.
create or replace function public.get_seller_badges()
returns table (seller_id uuid, plan public.subscription_plan, expires_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select distinct on (s.seller_id)
         s.seller_id, s.plan, s.expires_at
  from public.subscriptions s
  where s.status = 'active'
    and s.expires_at > now()
  order by s.seller_id,
           case s.plan when 'pro_max' then 2 else 1 end desc,
           s.expires_at desc;
$$;

-- Aggregate ratings are public; individual reviews stay private to the parties.
create or replace function public.get_seller_ratings()
returns table (seller_id uuid, average_rating numeric, review_count bigint)
language sql
stable
security definer
set search_path = public
as $$
  select r.seller_id,
         round(avg(r.rating)::numeric, 2) as average_rating,
         count(*)::bigint as review_count
  from public.reviews r
  group by r.seller_id;
$$;

-- ----------------------------------------------------------------------------
-- 4. PROFILE & AUTH TRIGGERS
-- ----------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_username  text;
  v_full_name text;
  v_role      public.user_role;
  v_phone     text;
begin
  v_full_name := left(
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
             split_part(coalesce(new.email, 'member'), '@', 1)),
    80
  );

  v_username := lower(coalesce(nullif(trim(new.raw_user_meta_data ->> 'username'), ''),
                               split_part(coalesce(new.email, 'member'), '@', 1)));
  v_username := regexp_replace(v_username, '[^a-z0-9_]', '', 'g');
  if char_length(v_username) < 3 then
    v_username := 'user_' || substr(new.id::text, 1, 8);
  end if;
  if char_length(v_username) > 20 then
    v_username := substr(v_username, 1, 20);
  end if;
  if exists (select 1 from public.profiles where lower(username) = v_username) then
    v_username := substr(v_username, 1, 12) || '_' || substr(new.id::text, 1, 6);
  end if;

  v_role := case
    when new.raw_user_meta_data ->> 'role' = 'seller' then 'seller'::public.user_role
    else 'buyer'::public.user_role
  end;

  v_phone := nullif(trim(new.raw_user_meta_data ->> 'phone'), '');

  insert into public.profiles (id, username, full_name, email, role, phone)
  values (new.id, v_username, v_full_name, coalesce(new.email, ''), v_role, v_phone)
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- A non-admin can never escalate their role, unsuspend themselves, or edit email.
create or replace function public.protect_profile_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.username := lower(trim(new.username));
  new.full_name := trim(new.full_name);

  if auth.uid() is not null and not public.is_admin() then
    if new.role is distinct from old.role then
      raise exception 'ROLE_CHANGE_FORBIDDEN' using errcode = '42501';
    end if;
    if new.is_suspended is distinct from old.is_suspended then
      raise exception 'SUSPENSION_CHANGE_FORBIDDEN' using errcode = '42501';
    end if;
    if new.email is distinct from old.email then
      raise exception 'EMAIL_CHANGE_FORBIDDEN' using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists protect_profile_fields on public.profiles;
create trigger protect_profile_fields
  before update on public.profiles
  for each row execute function public.protect_profile_fields();

-- ----------------------------------------------------------------------------
-- 5. LISTING, ORDER & MESSAGE GUARDS
-- ----------------------------------------------------------------------------
create or replace function public.protect_listing_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.title := trim(new.title);

  if auth.uid() is not null and not public.is_admin() then
    if new.seller_id is distinct from old.seller_id then
      raise exception 'LISTING_SELLER_IMMUTABLE' using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists protect_listing_fields on public.listings;
create trigger protect_listing_fields
  before update on public.listings
  for each row execute function public.protect_listing_fields();

create or replace function public.validate_order_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or public.is_admin() then
    return new;
  end if;

  if new.buyer_id is distinct from old.buyer_id
     or new.seller_id is distinct from old.seller_id
     or new.total_amount is distinct from old.total_amount
     or new.created_at is distinct from old.created_at then
    raise exception 'ORDER_FIELDS_IMMUTABLE' using errcode = '42501';
  end if;

  if new.status = old.status then
    return new;
  end if;

  if auth.uid() = old.seller_id
     and old.status = 'pending'
     and new.status in ('delivered', 'cancelled') then
    return new;
  end if;

  if auth.uid() = old.buyer_id
     and old.status = 'pending'
     and new.status = 'cancelled' then
    return new;
  end if;

  if auth.uid() = old.buyer_id
     and old.status = 'delivered'
     and new.status = 'completed' then
    return new;
  end if;

  raise exception 'INVALID_ORDER_TRANSITION' using errcode = '22000';
end;
$$;

drop trigger if exists validate_order_update on public.orders;
create trigger validate_order_update
  before update on public.orders
  for each row execute function public.validate_order_update();

-- Stock is reserved when the order is created. Cancelling a pending order puts
-- the units back and relists a sold-out item.
drop trigger if exists handle_order_delivered on public.orders;
drop function if exists public.handle_order_delivered();

create or replace function public.handle_order_cancelled()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'cancelled' and old.status = 'pending' then
    update public.listings l
       set quantity = l.quantity + agg.quantity,
           status = case
             when l.status = 'sold' and l.quantity + agg.quantity > 0
               then 'active'::public.listing_status
             else l.status
           end
      from (
        select oi.listing_id, sum(oi.quantity)::integer as quantity
        from public.order_items oi
        where oi.order_id = new.id
          and oi.listing_id is not null
        group by oi.listing_id
      ) agg
     where l.id = agg.listing_id;
  end if;
  return new;
end;
$$;

drop trigger if exists handle_order_cancelled on public.orders;
create trigger handle_order_cancelled
  after update on public.orders
  for each row execute function public.handle_order_cancelled();

create or replace function public.protect_message_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.content := trim(new.content);

  if auth.uid() is not null and not public.is_admin() then
    if new.sender_id is distinct from old.sender_id
       or new.receiver_id is distinct from old.receiver_id
       or new.listing_id is distinct from old.listing_id
       or new.content is distinct from old.content
       or new.created_at is distinct from old.created_at then
      raise exception 'MESSAGE_IMMUTABLE' using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists protect_message_fields on public.messages;
create trigger protect_message_fields
  before update on public.messages
  for each row execute function public.protect_message_fields();

-- Subscription prices are authoritative in the database. The client cannot
-- submit a cheaper amount for Pro or Pro Max, and every request starts pending.
create or replace function public.set_subscription_amount()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.plan = 'pro' then
    new.amount := 100.00;
  elsif new.plan = 'pro_max' then
    new.amount := 300.00;
  end if;

  new.mpesa_code := upper(trim(new.mpesa_code));

  if tg_op = 'INSERT' then
    new.status := 'pending';
    new.expires_at := null;
    new.approved_at := null;
  end if;

  return new;
end;
$$;

drop trigger if exists set_subscription_amount on public.subscriptions;
create trigger set_subscription_amount
  before insert or update on public.subscriptions
  for each row execute function public.set_subscription_amount();

-- ----------------------------------------------------------------------------
-- 6. CHECKOUT RPC
--    Prices are read from the database — the client can never set the amount.
-- ----------------------------------------------------------------------------
create or replace function public.create_order(
  p_seller_id uuid,
  p_items jsonb,
  p_delivery_location text default null,
  p_contact_phone text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_buyer    uuid := auth.uid();
  v_order_id uuid;
  v_total    numeric(12, 2) := 0;
  v_item     record;
  v_listing  record;
begin
  if v_buyer is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;

  if not exists (
    select 1 from public.profiles
    where id = v_buyer and is_suspended = false
  ) then
    raise exception 'ACCOUNT_SUSPENDED' using errcode = '42501';
  end if;

  if p_seller_id is null or p_seller_id = v_buyer then
    raise exception 'INVALID_SELLER' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.profiles
    where id = p_seller_id and is_suspended = false
  ) then
    raise exception 'SELLER_UNAVAILABLE' using errcode = '22023';
  end if;

  if p_items is null
     or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception 'EMPTY_CART' using errcode = '22023';
  end if;

  if jsonb_array_length(p_items) > 20 then
    raise exception 'TOO_MANY_ITEMS' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_items) as x(listing_id uuid, quantity integer)
    where x.listing_id is null
       or x.quantity is null
       or x.quantity < 1
       or x.quantity > 99
  ) then
    raise exception 'INVALID_QUANTITY' using errcode = '22023';
  end if;

  for v_item in
    select x.listing_id, sum(x.quantity)::integer as quantity
    from jsonb_to_recordset(p_items) as x(listing_id uuid, quantity integer)
    group by x.listing_id
  loop
    if v_item.quantity > 99 then
      raise exception 'INVALID_QUANTITY' using errcode = '22023';
    end if;

    select l.id, l.seller_id, l.price, l.status, l.quantity
      into v_listing
      from public.listings l
     where l.id = v_item.listing_id
       for update;

    if not found then
      raise exception 'LISTING_NOT_FOUND' using errcode = '22023';
    end if;

    if v_listing.seller_id <> p_seller_id then
      raise exception 'SELLER_MISMATCH' using errcode = '22023';
    end if;

    if v_listing.status <> 'active' then
      raise exception 'LISTING_UNAVAILABLE' using errcode = '22023';
    end if;

    if v_listing.quantity < v_item.quantity then
      raise exception 'INSUFFICIENT_STOCK' using errcode = '22023';
    end if;

    v_total := v_total + (v_listing.price * v_item.quantity);
  end loop;

  insert into public.orders (
    buyer_id, seller_id, total_amount, status, delivery_location, contact_phone
  ) values (
    v_buyer,
    p_seller_id,
    v_total,
    'pending',
    nullif(trim(coalesce(p_delivery_location, '')), ''),
    nullif(trim(coalesce(p_contact_phone, '')), '')
  )
  returning id into v_order_id;

  insert into public.order_items (order_id, listing_id, quantity, price_at_purchase)
  select v_order_id,
         x.listing_id,
         sum(x.quantity)::integer,
         l.price
    from jsonb_to_recordset(p_items) as x(listing_id uuid, quantity integer)
    join public.listings l on l.id = x.listing_id
   group by x.listing_id, l.price;

  -- Reserve stock immediately. When the last unit is reserved, the listing
  -- moves to "sold" and leaves the public feed.
  update public.listings l
     set quantity = l.quantity - agg.quantity,
         status = case
           when l.quantity - agg.quantity <= 0
             then 'sold'::public.listing_status
           else l.status
         end
    from (
      select oi.listing_id, sum(oi.quantity)::integer as quantity
      from public.order_items oi
      where oi.order_id = v_order_id
        and oi.listing_id is not null
      group by oi.listing_id
    ) agg
   where l.id = agg.listing_id;

  return v_order_id;
end;
$$;

-- ----------------------------------------------------------------------------
-- 7. ADMIN RPCs
-- ----------------------------------------------------------------------------
create or replace function public.admin_list_users()
returns table (
  id uuid,
  username text,
  full_name text,
  email text,
  role public.user_role,
  avatar_url text,
  phone text,
  is_suspended boolean,
  created_at timestamptz,
  last_sign_in_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  return query
    select p.id, p.username, p.full_name, p.email, p.role,
           p.avatar_url, p.phone, p.is_suspended, p.created_at,
           u.last_sign_in_at
    from public.profiles p
    join auth.users u on u.id = p.id
    order by p.created_at desc;
end;
$$;

create or replace function public.admin_set_suspension(p_user_id uuid, p_suspended boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'CANNOT_SUSPEND_SELF' using errcode = '22023';
  end if;

  update public.profiles
     set is_suspended = p_suspended
   where id = p_user_id;

  if not found then
    raise exception 'USER_NOT_FOUND' using errcode = '22023';
  end if;
end;
$$;

create or replace function public.admin_delete_user(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'CANNOT_DELETE_SELF' using errcode = '22023';
  end if;

  delete from auth.users where id = p_user_id;

  if not found then
    raise exception 'USER_NOT_FOUND' using errcode = '22023';
  end if;
end;
$$;

create or replace function public.admin_stats()
returns table (
  total_revenue numeric,
  total_orders bigint,
  active_users bigint,
  active_listings bigint,
  pending_subscriptions bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  return query
    select
      coalesce((select sum(o.total_amount)
                from public.orders o
                where o.status in ('delivered', 'completed')), 0)::numeric,
      (select count(*) from public.orders),
      (select count(*) from public.profiles where is_suspended = false),
      (select count(*)
         from public.listings l
         join public.profiles p on p.id = l.seller_id
        where l.status = 'active' and p.is_suspended = false),
      (select count(*) from public.subscriptions where status = 'pending');
end;
$$;

-- ----------------------------------------------------------------------------
-- 8. ROW LEVEL SECURITY
-- ----------------------------------------------------------------------------
alter table public.profiles        enable row level security;
alter table public.listings        enable row level security;
alter table public.orders          enable row level security;
alter table public.order_items     enable row level security;
alter table public.subscriptions   enable row level security;
alter table public.messages        enable row level security;
alter table public.reviews         enable row level security;

-- PROFILES -------------------------------------------------------------------
drop policy if exists "Profiles are publicly readable" on public.profiles;
create policy "Profiles are publicly readable"
  on public.profiles for select
  using (true);

drop policy if exists "Users can insert their own profile" on public.profiles;
create policy "Users can insert their own profile"
  on public.profiles for insert to authenticated
  with check (
    id = auth.uid()
    and role in ('buyer', 'seller')
    and is_suspended = false
  );

drop policy if exists "Users can update their own profile" on public.profiles;
create policy "Users can update their own profile"
  on public.profiles for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

drop policy if exists "Admins can update any profile" on public.profiles;
create policy "Admins can update any profile"
  on public.profiles for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "Admins can delete profiles" on public.profiles;
create policy "Admins can delete profiles"
  on public.profiles for delete to authenticated
  using (public.is_admin());

-- LISTINGS -------------------------------------------------------------------
drop policy if exists "Anyone can read active listings" on public.listings;
create policy "Anyone can read active listings"
  on public.listings for select
  using (
    status = 'active'
    and quantity > 0
    and exists (
      select 1
      from public.profiles p
      where p.id = listings.seller_id
        and p.is_suspended = false
    )
  );

drop policy if exists "Sellers can read their own listings" on public.listings;
create policy "Sellers can read their own listings"
  on public.listings for select to authenticated
  using (seller_id = auth.uid());

drop policy if exists "Buyers can read listings they ordered" on public.listings;
create policy "Buyers can read listings they ordered"
  on public.listings for select to authenticated
  using (
    exists (
      select 1
      from public.order_items oi
      join public.orders o on o.id = oi.order_id
      where oi.listing_id = listings.id
        and o.buyer_id = auth.uid()
    )
  );

drop policy if exists "Admins can read all listings" on public.listings;
create policy "Admins can read all listings"
  on public.listings for select to authenticated
  using (public.is_admin());

drop policy if exists "Sellers can create listings" on public.listings;
create policy "Sellers can create listings"
  on public.listings for insert to authenticated
  with check (
    seller_id = auth.uid()
    and public.is_seller()
    and status in ('active', 'sold')
  );

drop policy if exists "Sellers can update their own listings" on public.listings;
create policy "Sellers can update their own listings"
  on public.listings for update to authenticated
  using (seller_id = auth.uid() and public.is_seller())
  with check (seller_id = auth.uid());

drop policy if exists "Admins can update any listing" on public.listings;
create policy "Admins can update any listing"
  on public.listings for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "Admins can delete listings" on public.listings;
create policy "Admins can delete listings"
  on public.listings for delete to authenticated
  using (public.is_admin());

-- ORDERS ---------------------------------------------------------------------
drop policy if exists "Buyers and sellers can read their orders" on public.orders;
create policy "Buyers and sellers can read their orders"
  on public.orders for select to authenticated
  using (
    buyer_id = auth.uid()
    or seller_id = auth.uid()
    or public.is_admin()
  );

-- Inserts happen only through public.create_order() (SECURITY DEFINER).
drop policy if exists "Buyers and sellers can update their orders" on public.orders;
create policy "Buyers and sellers can update their orders"
  on public.orders for update to authenticated
  using (
    public.is_admin()
    or (
      (buyer_id = auth.uid() or seller_id = auth.uid())
      and public.is_active_user()
    )
  )
  with check (
    public.is_admin()
    or (
      (buyer_id = auth.uid() or seller_id = auth.uid())
      and public.is_active_user()
    )
  );

drop policy if exists "Admins can delete orders" on public.orders;
create policy "Admins can delete orders"
  on public.orders for delete to authenticated
  using (public.is_admin());

-- ORDER ITEMS ----------------------------------------------------------------
drop policy if exists "Order items follow order visibility" on public.order_items;
create policy "Order items follow order visibility"
  on public.order_items for select to authenticated
  using (
    exists (
      select 1
      from public.orders o
      where o.id = order_items.order_id
        and (o.buyer_id = auth.uid() or o.seller_id = auth.uid())
    )
    or public.is_admin()
  );

drop policy if exists "Admins can insert order items" on public.order_items;
create policy "Admins can insert order items"
  on public.order_items for insert to authenticated
  with check (public.is_admin());

drop policy if exists "Admins can modify order items" on public.order_items;
create policy "Admins can modify order items"
  on public.order_items for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "Admins can delete order items" on public.order_items;
create policy "Admins can delete order items"
  on public.order_items for delete to authenticated
  using (public.is_admin());

-- SUBSCRIPTIONS ---------------------------------------------------------------
drop policy if exists "Sellers can read their subscriptions" on public.subscriptions;
create policy "Sellers can read their subscriptions"
  on public.subscriptions for select to authenticated
  using (seller_id = auth.uid() or public.is_admin());

drop policy if exists "Sellers can request a subscription" on public.subscriptions;
create policy "Sellers can request a subscription"
  on public.subscriptions for insert to authenticated
  with check (
    seller_id = auth.uid()
    and public.is_seller()
    and status = 'pending'
    and expires_at is null
  );

drop policy if exists "Admins can manage subscriptions" on public.subscriptions;
create policy "Admins can manage subscriptions"
  on public.subscriptions for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "Admins can delete subscriptions" on public.subscriptions;
create policy "Admins can delete subscriptions"
  on public.subscriptions for delete to authenticated
  using (public.is_admin());

-- MESSAGES -------------------------------------------------------------------
drop policy if exists "Users can read their messages" on public.messages;
create policy "Users can read their messages"
  on public.messages for select to authenticated
  using (
    sender_id = auth.uid()
    or receiver_id = auth.uid()
    or public.is_admin()
  );

drop policy if exists "Users can send messages" on public.messages;
create policy "Users can send messages"
  on public.messages for insert to authenticated
  with check (
    sender_id = auth.uid()
    and public.is_active_user()
  );

drop policy if exists "Receivers can mark messages read" on public.messages;
create policy "Receivers can mark messages read"
  on public.messages for update to authenticated
  using (receiver_id = auth.uid() or public.is_admin())
  with check (receiver_id = auth.uid() or public.is_admin());

drop policy if exists "Admins can delete messages" on public.messages;
create policy "Admins can delete messages"
  on public.messages for delete to authenticated
  using (public.is_admin());

-- REVIEWS --------------------------------------------------------------------
drop policy if exists "Buyers and sellers can read their reviews" on public.reviews;
create policy "Buyers and sellers can read their reviews"
  on public.reviews for select to authenticated
  using (
    buyer_id = auth.uid()
    or seller_id = auth.uid()
    or public.is_admin()
  );

drop policy if exists "Buyers can review completed orders" on public.reviews;
create policy "Buyers can review completed orders"
  on public.reviews for insert to authenticated
  with check (
    buyer_id = auth.uid()
    and rating between 1 and 5
    and exists (
      select 1
      from public.orders o
      where o.id = reviews.order_id
        and o.buyer_id = auth.uid()
        and o.seller_id = reviews.seller_id
        and o.status = 'completed'
    )
  );

drop policy if exists "Admins can manage reviews" on public.reviews;
create policy "Admins can manage reviews"
  on public.reviews for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ----------------------------------------------------------------------------
-- 9. FUNCTION PERMISSIONS
-- ----------------------------------------------------------------------------
revoke all on function public.create_order(uuid, jsonb, text, text) from public;
revoke all on function public.create_order(uuid, jsonb, text, text) from anon;
grant execute on function public.create_order(uuid, jsonb, text, text) to authenticated;

revoke all on function public.admin_list_users() from public;
revoke all on function public.admin_list_users() from anon;
grant execute on function public.admin_list_users() to authenticated;

revoke all on function public.admin_set_suspension(uuid, boolean) from public;
revoke all on function public.admin_set_suspension(uuid, boolean) from anon;
grant execute on function public.admin_set_suspension(uuid, boolean) to authenticated;

revoke all on function public.admin_delete_user(uuid) from public;
revoke all on function public.admin_delete_user(uuid) from anon;
grant execute on function public.admin_delete_user(uuid) to authenticated;

revoke all on function public.admin_stats() from public;
revoke all on function public.admin_stats() from anon;
grant execute on function public.admin_stats() to authenticated;

revoke all on function public.get_my_profile() from public;
revoke all on function public.get_my_profile() from anon;
grant execute on function public.get_my_profile() to authenticated;

grant execute on function public.get_seller_badges() to anon, authenticated;
grant execute on function public.get_seller_ratings() to anon, authenticated;
grant execute on function public.is_username_available(text) to anon, authenticated;

revoke all on function public.login_email_for_username(text) from public;
grant execute on function public.login_email_for_username(text) to anon, authenticated;

grant execute on function public.is_admin() to authenticated;
grant execute on function public.is_seller() to authenticated;
grant execute on function public.is_active_user() to authenticated;

-- Public seller columns only. Email/phone are exposed through get_my_profile()
-- and admin_list_users(), never through a broad table read.
revoke all on public.profiles from anon, authenticated;
grant select (id, username, full_name, role, avatar_url, location, is_suspended, created_at)
  on public.profiles to anon, authenticated;
grant insert on public.profiles to authenticated;
grant update (username, full_name, avatar_url, phone, location)
  on public.profiles to authenticated;

-- Reviews: RLS restricts rows; the aggregate RPC is the public surface.
grant select, insert, update, delete on public.reviews to authenticated;

-- ----------------------------------------------------------------------------
-- 10. STORAGE (listing photos)
-- ----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'listing-images',
  'listing-images',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp', 'image/avif']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Public can view listing images" on storage.objects;
create policy "Public can view listing images"
  on storage.objects for select
  using (bucket_id = 'listing-images');

drop policy if exists "Sellers can upload listing images" on storage.objects;
create policy "Sellers can upload listing images"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'listing-images'
    and (storage.foldername(name))[1] = auth.uid()::text
    and public.is_seller()
  );

drop policy if exists "Sellers can update listing images" on storage.objects;
create policy "Sellers can update listing images"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'listing-images'
    and (storage.foldername(name))[1] = auth.uid()::text
    and public.is_seller()
  )
  with check (
    bucket_id = 'listing-images'
    and (storage.foldername(name))[1] = auth.uid()::text
    and public.is_seller()
  );

drop policy if exists "Sellers can delete listing images" on storage.objects;
create policy "Sellers can delete listing images"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'listing-images'
    and (storage.foldername(name))[1] = auth.uid()::text
    and public.is_seller()
  );

drop policy if exists "Admins can manage listing images" on storage.objects;
create policy "Admins can manage listing images"
  on storage.objects for all to authenticated
  using (bucket_id = 'listing-images' and public.is_admin())
  with check (bucket_id = 'listing-images' and public.is_admin());

-- ----------------------------------------------------------------------------
-- 11. REALTIME (chat)
-- ----------------------------------------------------------------------------
alter table public.messages replica identity full;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 12. POST-INSTALL CHECKLIST
-- ----------------------------------------------------------------------------
-- 1) Create your account in the app (Register), then promote it to admin:
--      update public.profiles set role = 'admin' where email = 'you@maseno.ac.ke';
-- 2) Sign out and back in so the new role is loaded.
-- 3) Optional: schedule subscription expiry with pg_cron:
--      select cron.schedule(
--        'expire-subscriptions', '0 3 * * *',
--        $$update public.subscriptions
--             set status = 'expired'
--           where status = 'active' and expires_at < now()$$
--      );
-- 4) Realtime is enabled on public.messages above. Public feed badges are
--    resolved through public.get_seller_badges().

```

## 1.2b Username-login migration

If the project already had the schema before username login was added, run this short migration once:

```sql
-- ============================================================================
--  M-HUSTLE · Username sign-in migration
--  Run this once in Supabase Dashboard → SQL Editor if your project was
--  created before username login was added.
-- ============================================================================

create or replace function public.login_email_for_username(p_username text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select p.email
  from public.profiles p
  where lower(p.username) = lower(trim(p_username))
  limit 1;
$$;

revoke all on function public.login_email_for_username(text) from public;
grant execute on function public.login_email_for_username(text) to anon, authenticated;

-- Ask PostgREST to pick up the new function immediately.
notify pgrst, 'reload schema';

-- Verify (replace with a real username):
-- select public.login_email_for_username('amina_maseno');

```

The login form accepts an email or a username. Values without `@` are resolved to the account
email by this function, then handed to Supabase Auth's normal password grant. Usernames are public
marketplace handles, so the function intentionally treats them as non-private data.

## 1.2c Quantities, ratings and profile-location migration

For a project created before these features, run this once in the SQL Editor:

```sql
-- ============================================================================
--  M-HUSTLE · Migration 002
--  Hostel locations, listing quantities, seller ratings and stock-aware orders.
--  Run once in Supabase Dashboard → SQL Editor on the existing project.
-- ============================================================================

-- 1. PROFILE LOCATION ---------------------------------------------------------
alter table public.profiles
  add column if not exists location text;

do $$
begin
  alter table public.profiles
    add constraint profiles_location_check check (
      location is null or location in (
        'Kilimanjaro', 'Niles', 'Nyabundi', 'ACV', 'Equator', 'Elgon',
        'Mara 1', 'Mara 2', 'Mara 3', 'Mara 4', 'Rusinga', 'Ndeere', 'Victoria'
      )
    );
exception when duplicate_object then null;
end $$;

grant select (location) on public.profiles to anon, authenticated;
grant update (location) on public.profiles to authenticated;

-- 2. LISTING QUANTITY ---------------------------------------------------------
alter table public.listings
  add column if not exists quantity integer not null default 1;

do $$
begin
  alter table public.listings
    add constraint listings_quantity_non_negative
    check (quantity >= 0 and quantity <= 9999);
exception when duplicate_object then null;
end $$;

drop policy if exists "Anyone can read active listings" on public.listings;
create policy "Anyone can read active listings"
  on public.listings for select
  using (
    status = 'active'
    and quantity > 0
    and exists (
      select 1
      from public.profiles p
      where p.id = listings.seller_id
        and p.is_suspended = false
    )
  );

-- 3. REVIEWS ------------------------------------------------------------------
create table if not exists public.reviews (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null unique references public.orders (id) on delete cascade,
  buyer_id    uuid not null references public.profiles (id) on delete cascade,
  seller_id   uuid not null references public.profiles (id) on delete cascade,
  rating      smallint not null,
  comment     text,
  created_at  timestamptz not null default now(),
  constraint reviews_rating_range check (rating between 1 and 5),
  constraint reviews_comment_length check (comment is null or char_length(comment) <= 1000),
  constraint reviews_distinct_parties check (buyer_id <> seller_id)
);

create index if not exists reviews_seller_idx
  on public.reviews (seller_id, created_at desc);
create index if not exists reviews_buyer_idx
  on public.reviews (buyer_id, created_at desc);

alter table public.reviews enable row level security;

drop policy if exists "Buyers and sellers can read their reviews" on public.reviews;
create policy "Buyers and sellers can read their reviews"
  on public.reviews for select to authenticated
  using (
    buyer_id = auth.uid()
    or seller_id = auth.uid()
    or public.is_admin()
  );

drop policy if exists "Buyers can review completed orders" on public.reviews;
create policy "Buyers can review completed orders"
  on public.reviews for insert to authenticated
  with check (
    buyer_id = auth.uid()
    and rating between 1 and 5
    and exists (
      select 1
      from public.orders o
      where o.id = reviews.order_id
        and o.buyer_id = auth.uid()
        and o.seller_id = reviews.seller_id
        and o.status = 'completed'
    )
  );

drop policy if exists "Admins can manage reviews" on public.reviews;
create policy "Admins can manage reviews"
  on public.reviews for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

grant select, insert, update, delete on public.reviews to authenticated;

-- 4. PROFILE RPC (adds location) ---------------------------------------------
drop function if exists public.get_my_profile();

create or replace function public.get_my_profile()
returns table (
  id uuid,
  username text,
  full_name text,
  email text,
  role public.user_role,
  avatar_url text,
  phone text,
  location text,
  is_suspended boolean,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.username, p.full_name, p.email, p.role,
         p.avatar_url, p.phone, p.location, p.is_suspended, p.created_at
  from public.profiles p
  where p.id = auth.uid();
$$;

revoke all on function public.get_my_profile() from public;
revoke all on function public.get_my_profile() from anon;
grant execute on function public.get_my_profile() to authenticated;

-- 5. PUBLIC RATING AGGREGATE -------------------------------------------------
create or replace function public.get_seller_ratings()
returns table (seller_id uuid, average_rating numeric, review_count bigint)
language sql
stable
security definer
set search_path = public
as $$
  select r.seller_id,
         round(avg(r.rating)::numeric, 2) as average_rating,
         count(*)::bigint as review_count
  from public.reviews r
  group by r.seller_id;
$$;

grant execute on function public.get_seller_ratings() to anon, authenticated;

-- 6. STOCK-AWARE ORDER LIFECYCLE ---------------------------------------------
drop trigger if exists handle_order_delivered on public.orders;
drop function if exists public.handle_order_delivered();

create or replace function public.handle_order_cancelled()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'cancelled' and old.status = 'pending' then
    update public.listings l
       set quantity = l.quantity + agg.quantity,
           status = case
             when l.status = 'sold' and l.quantity + agg.quantity > 0
               then 'active'::public.listing_status
             else l.status
           end
      from (
        select oi.listing_id, sum(oi.quantity)::integer as quantity
        from public.order_items oi
        where oi.order_id = new.id
          and oi.listing_id is not null
        group by oi.listing_id
      ) agg
     where l.id = agg.listing_id;
  end if;
  return new;
end;
$$;

drop trigger if exists handle_order_cancelled on public.orders;
create trigger handle_order_cancelled
  after update on public.orders
  for each row execute function public.handle_order_cancelled();

create or replace function public.create_order(
  p_seller_id uuid,
  p_items jsonb,
  p_delivery_location text default null,
  p_contact_phone text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_buyer    uuid := auth.uid();
  v_order_id uuid;
  v_total    numeric(12, 2) := 0;
  v_item     record;
  v_listing  record;
begin
  if v_buyer is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;

  if not exists (
    select 1 from public.profiles
    where id = v_buyer and is_suspended = false
  ) then
    raise exception 'ACCOUNT_SUSPENDED' using errcode = '42501';
  end if;

  if p_seller_id is null or p_seller_id = v_buyer then
    raise exception 'INVALID_SELLER' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.profiles
    where id = p_seller_id and is_suspended = false
  ) then
    raise exception 'SELLER_UNAVAILABLE' using errcode = '22023';
  end if;

  if p_items is null
     or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception 'EMPTY_CART' using errcode = '22023';
  end if;

  if jsonb_array_length(p_items) > 20 then
    raise exception 'TOO_MANY_ITEMS' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_items) as x(listing_id uuid, quantity integer)
    where x.listing_id is null
       or x.quantity is null
       or x.quantity < 1
       or x.quantity > 99
  ) then
    raise exception 'INVALID_QUANTITY' using errcode = '22023';
  end if;

  for v_item in
    select x.listing_id, sum(x.quantity)::integer as quantity
    from jsonb_to_recordset(p_items) as x(listing_id uuid, quantity integer)
    group by x.listing_id
  loop
    if v_item.quantity > 99 then
      raise exception 'INVALID_QUANTITY' using errcode = '22023';
    end if;

    select l.id, l.seller_id, l.price, l.status, l.quantity
      into v_listing
      from public.listings l
     where l.id = v_item.listing_id
       for update;

    if not found then
      raise exception 'LISTING_NOT_FOUND' using errcode = '22023';
    end if;

    if v_listing.seller_id <> p_seller_id then
      raise exception 'SELLER_MISMATCH' using errcode = '22023';
    end if;

    if v_listing.status <> 'active' then
      raise exception 'LISTING_UNAVAILABLE' using errcode = '22023';
    end if;

    if v_listing.quantity < v_item.quantity then
      raise exception 'INSUFFICIENT_STOCK' using errcode = '22023';
    end if;

    v_total := v_total + (v_listing.price * v_item.quantity);
  end loop;

  insert into public.orders (
    buyer_id, seller_id, total_amount, status, delivery_location, contact_phone
  ) values (
    v_buyer,
    p_seller_id,
    v_total,
    'pending',
    nullif(trim(coalesce(p_delivery_location, '')), ''),
    nullif(trim(coalesce(p_contact_phone, '')), '')
  )
  returning id into v_order_id;

  insert into public.order_items (order_id, listing_id, quantity, price_at_purchase)
  select v_order_id,
         x.listing_id,
         sum(x.quantity)::integer,
         l.price
    from jsonb_to_recordset(p_items) as x(listing_id uuid, quantity integer)
    join public.listings l on l.id = x.listing_id
   group by x.listing_id, l.price;

  update public.listings l
     set quantity = l.quantity - agg.quantity,
         status = case
           when l.quantity - agg.quantity <= 0
             then 'sold'::public.listing_status
           else l.status
         end
    from (
      select oi.listing_id, sum(oi.quantity)::integer as quantity
      from public.order_items oi
      where oi.order_id = v_order_id
        and oi.listing_id is not null
      group by oi.listing_id
    ) agg
   where l.id = agg.listing_id;

  return v_order_id;
end;
$$;

revoke all on function public.create_order(uuid, jsonb, text, text) from public;
revoke all on function public.create_order(uuid, jsonb, text, text) from anon;
grant execute on function public.create_order(uuid, jsonb, text, text) to authenticated;

notify pgrst, 'reload schema';

```

The full `schema.sql` above already contains everything in both migrations, so a fresh project
does not need to run them separately.

## 1.3 Storage setup

The SQL above creates the `listing-images` bucket and all policies. If you prefer to create it manually:

| Setting | Value |
| --- | --- |
| Bucket name | `listing-images` |
| Public | yes |
| File size limit | 5 MB |
| Allowed MIME types | `image/jpeg`, `image/png`, `image/webp`, `image/avif` |

Uploads go to `{auth.uid()}/{uuid}.{ext}`. Policies allow:

- anyone to read listing images;
- active sellers to insert, update and delete files inside their own UID folder;
- admins to manage every object in the bucket.

The browser uploads with the anon key. The stored object URL is written to `listings.image_url`.
No service-role key is ever used in the frontend.

## 1.4 Environment template

Create `.env` from the template below. Vite only reads environment variables at boot, so restart the dev server after editing.

```env
# ---------------------------------------------------------------------------
# M-HUSTLE · Supabase credentials
# Copy this file to `.env` and fill in the values from:
# Supabase Dashboard → Project Settings → API
#
# The URL must be exactly https://<project-ref>.supabase.co.
# Never prefix it with "your-project-" — that host does not exist and causes
# ERR_NAME_NOT_RESOLVED / "Cannot reach the server" in the browser.
# ---------------------------------------------------------------------------
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-public-key

```

## 1.5 Create the first admin

Register normally in the app, then run this in the SQL Editor using the username you chose:

```sql
update public.profiles
set role = 'admin'
where lower(username) = lower('your_username');
```

Sign out and back in. Then go directly to `/admin`. The admin entry is intentionally hidden from
the navbar and home page; the protected URL is the only way in. Admin accounts cannot be created
from the registration form: the profile trigger only accepts `buyer` and `seller`, and a trigger
blocks client-side role escalation.

## 1.6 Authorization matrix

| Table | Read | Insert | Update | Delete |
| --- | --- | --- | --- | --- |
| `profiles` | public safe columns | own profile as buyer/seller | own profile; admins any | admins |
| `listings` | active listings from active sellers; own; ordered; admins | own, seller role | own, seller role; admins | admins |
| `orders` | buyer, seller, admins | checkout RPC only | buyer/seller with guarded transitions; admins | admins |
| `order_items` | follows order visibility | checkout RPC / admins | admins | admins |
| `subscriptions` | own; admins | own `pending` request, seller role | admins only | admins |
| `messages` | sender, receiver, admins | sender only, active accounts | receiver may mark read; admins | admins |

Order transitions enforced by trigger:

```text
pending   → delivered   (seller)
pending   → cancelled   (buyer or seller)
delivered → completed   (buyer, "Confirm receipt")
anything else           (admin only)
```

Marking an order delivered also marks every related active listing `sold`, which removes it from
the public feed.

---

# SECTION 2 — Frontend configuration

## 2.1 package.json

```json
{
  "name": "m-hustle",
  "private": true,
  "version": "1.0.0",
  "type": "module",
  "description": "M-Hustle — the premium campus marketplace for Maseno University. A HartTech product.",
  "author": "HartTech",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview --port 4173"
  },
  "dependencies": {
    "@supabase/supabase-js": "^2.45.4",
    "date-fns": "^3.6.0",
    "lucide-react": "^0.454.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.26.2"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.2",
    "autoprefixer": "^10.4.20",
    "postcss": "^8.4.47",
    "tailwindcss": "^3.4.13",
    "vite": "^5.4.8"
  }
}

```

## 2.2 vite.config.js

```js
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// M-Hustle is a static SPA: no custom backend, no server middleware.
// Everything talks directly to Supabase through the anon key + RLS.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
  },
  preview: {
    port: 4173,
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-supabase': ['@supabase/supabase-js'],
        },
      },
    },
  },
})

```

## 2.3 tailwind.config.js

```js
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          950: '#06060b',
          900: '#0a0a12',
          850: '#0d0d17',
          800: '#11111c',
          700: '#171724',
          600: '#1f1f2e',
        },
        brand: {
          orange: '#f97316',
          amber: '#f59e0b',
          pink: '#ec4899',
          rose: '#f43f5e',
        },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        display: ['Sora', 'Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        '4xl': '2rem',
      },
      boxShadow: {
        glow: '0 0 60px -15px rgba(249, 115, 22, 0.35)',
        'glow-pink': '0 0 60px -15px rgba(236, 72, 153, 0.35)',
        card: '0 24px 60px -30px rgba(0, 0, 0, 0.9)',
      },
      keyframes: {
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(14px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
        float: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-10px)' },
        },
        'pulse-soft': {
          '0%, 100%': { opacity: '0.5' },
          '50%': { opacity: '1' },
        },
      },
      animation: {
        'fade-up': 'fade-up 0.55s cubic-bezier(0.22, 1, 0.36, 1) both',
        'fade-in': 'fade-in 0.4s ease both',
        shimmer: 'shimmer 1.6s infinite',
        float: 'float 7s ease-in-out infinite',
        'pulse-soft': 'pulse-soft 2.8s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}

```

## 2.4 postcss.config.js

```js
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
}

```

## 2.5 index.html

```html
<!doctype html>
<html lang="en" class="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="theme-color" content="#0a0a12" />
    <meta name="author" content="HartTech" />
    <meta property="og:site_name" content="M-Hustle by HartTech" />
    <meta
      name="description"
      content="M-Hustle is the premium campus marketplace for Maseno University. Buy and sell textbooks, tech, fashion, food and hostel essentials with verified student sellers."
    />
    <meta property="og:title" content="M-Hustle — Maseno University Marketplace" />
    <meta
      property="og:description"
      content="Your campus. Your hustle. A premium, verified marketplace built exclusively for Maseno University."
    />
    <meta property="og:type" content="website" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Sora:wght@400;500;600;700;800&display=swap"
      rel="stylesheet"
    />
    <link
      rel="icon"
      href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='64' y2='64'%3E%3Cstop stop-color='%23f97316'/%3E%3Cstop offset='1' stop-color='%23ec4899'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='64' height='64' rx='18' fill='%230a0a12'/%3E%3Cpath d='M18 46V18h6.5l7.5 13 7.5-13H46v28h-6V29.5l-6.2 10.4h-4.6L23 29.5V46z' fill='url(%23g)'/%3E%3C/svg%3E"
    />
    <title>M-Hustle — Maseno University Marketplace</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>

```

## 2.6 src/main.jsx

```jsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { AuthProvider } from './hooks/useAuth'
import { CartProvider } from './context/CartContext'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <AuthProvider>
        <CartProvider>
          <App />
        </CartProvider>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>,
)

```

## 2.7 src/App.jsx

```jsx
import { lazy, Suspense } from 'react'
import { Link, Route, Routes } from 'react-router-dom'
import {
  ArrowRight,
  Database,
  KeyRound,
  LogOut,
  ShieldAlert,
  Terminal,
} from 'lucide-react'
import Navbar from './components/Navbar'
import Footer from './components/Footer'
import ScrollToTop from './components/ScrollToTop'
import ProtectedRoute from './components/ProtectedRoute'
import { PageLoader } from './components/ui'
import { useAuth } from './hooks/useAuth'
import { isSupabaseConfigured } from './lib/supabase'
import { SUPPORT_EMAIL } from './lib/constants'

import Home from './pages/Home'
import Login from './pages/Login'
import Register from './pages/Register'

// Route-level code splitting keeps the first marketplace paint light.
const ProductDetail = lazy(() => import('./pages/ProductDetail'))
const Cart = lazy(() => import('./pages/Cart'))
const Checkout = lazy(() => import('./pages/Checkout'))
const BuyerOrders = lazy(() => import('./pages/BuyerOrders'))
const Messages = lazy(() => import('./pages/Messages'))
const EditProfile = lazy(() => import('./pages/EditProfile'))
const SellerDashboard = lazy(() => import('./pages/SellerDashboard'))
const AdminDashboard = lazy(() => import('./pages/AdminDashboard'))
const NotFound = lazy(() => import('./pages/NotFound'))

export default function App() {
  const { isSuspended, signOut } = useAuth()

  if (!isSupabaseConfigured) {
    return <SetupScreen />
  }

  return (
    <div id="top" className="flex min-h-screen flex-col">
      <ScrollToTop />
      <Navbar />

      <main className="flex-1">
        <Suspense fallback={<PageLoader label="Loading M-Hustle…" />}>
          {isSuspended ? (
            <SuspendedScreen onSignOut={signOut} />
          ) : (
            <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />
            <Route path="/product/:id" element={<ProductDetail />} />
            <Route path="/cart" element={<Cart />} />
            <Route
              path="/checkout"
              element={
                <ProtectedRoute>
                  <Checkout />
                </ProtectedRoute>
              }
            />
            <Route
              path="/orders"
              element={
                <ProtectedRoute>
                  <BuyerOrders />
                </ProtectedRoute>
              }
            />
            <Route
              path="/messages"
              element={
                <ProtectedRoute>
                  <Messages />
                </ProtectedRoute>
              }
            />
            <Route
              path="/profile"
              element={
                <ProtectedRoute>
                  <EditProfile />
                </ProtectedRoute>
              }
            />
            <Route
              path="/seller"
              element={
                <ProtectedRoute roles={['seller']}>
                  <SellerDashboard />
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin"
              element={
                <ProtectedRoute roles={['admin']}>
                  <AdminDashboard />
                </ProtectedRoute>
              }
            />
            <Route path="*" element={<NotFound />} />
          </Routes>
          )}
        </Suspense>
      </main>

      <Footer />
    </div>
  )
}

function SuspendedScreen({ onSignOut }) {
  return (
    <div className="mx-auto flex min-h-[70vh] max-w-lg flex-col items-center justify-center px-4 text-center">
      <span className="grid h-16 w-16 place-items-center rounded-3xl border border-red-500/25 bg-red-500/10 text-red-300">
        <ShieldAlert size={30} />
      </span>
      <h1 className="mt-6 text-2xl font-semibold text-white">Account suspended</h1>
      <p className="mt-3 text-sm leading-relaxed text-gray-400">
        Buy, sell and messaging are paused on this account. If you believe this is a mistake,
        contact the M-Hustle campus desk at{' '}
        <a href={`mailto:${SUPPORT_EMAIL}`} className="link">
          {SUPPORT_EMAIL}
        </a>
        .
      </p>
      <div className="mt-7 flex flex-wrap justify-center gap-2">
        <button type="button" onClick={onSignOut} className="btn-secondary">
          <LogOut size={16} />
          Sign out
        </button>
        <Link to="/" className="btn-primary">
          Back to marketplace
          <ArrowRight size={16} />
        </Link>
      </div>
    </div>
  )
}

function SetupScreen() {
  return (
    <div className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-4 py-16 sm:px-6">
      <div className="flex items-center gap-3">
        <span className="grid h-11 w-11 place-items-center rounded-2xl bg-gradient-to-br from-orange-500 to-pink-500 font-display text-lg font-extrabold text-white">
          M
        </span>
        <div>
          <p className="font-display text-lg font-bold text-white">M-Hustle</p>
          <p className="text-[10px] uppercase tracking-[0.22em] text-gray-500">
            A HartTech product · setup required
          </p>
        </div>
      </div>

      <h1 className="mt-10 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
        Connect your Supabase project
      </h1>
      <p className="mt-3 max-w-xl text-sm leading-relaxed text-gray-400">
        M-Hustle talks to Supabase directly from the browser. Add your project credentials,
        apply the schema, and this screen will be replaced by the marketplace.
      </p>

      <div className="mt-8 space-y-3">
        <Step
          icon={Terminal}
          title="1 · Create the environment file"
          body="Duplicate .env.example as .env in the project root, then paste your Project URL and anon public key."
        />
        <Step
          icon={Database}
          title="2 · Run the schema"
          body="Open the Supabase SQL Editor and run supabase/schema.sql. It creates the tables, RLS policies, RPCs, storage bucket and realtime publication."
        />
        <Step
          icon={KeyRound}
          title="3 · Restart the dev server"
          body="Vite only reads environment variables on boot. Stop the server, run npm run dev again, and sign up your first account."
        />
      </div>

      <div className="mt-8 rounded-2xl border border-white/10 bg-black/40 p-4 font-mono text-xs leading-relaxed text-gray-300">
        <p className="text-gray-500"># .env</p>
        <p>VITE_SUPABASE_URL=https://your-project-ref.supabase.co</p>
        <p>VITE_SUPABASE_ANON_KEY=your-anon-public-key</p>
      </div>

      <p className="mt-6 text-xs text-gray-500">
        Never place the service-role key in this app. The browser only needs the anon key;
        Row Level Security protects every table.
      </p>
      <p className="mt-3 text-xs text-gray-600">
        M-Hustle is designed and maintained by HartTech. Support:{' '}
        <a href={`mailto:${SUPPORT_EMAIL}`} className="link">
          {SUPPORT_EMAIL}
        </a>
      </p>
    </div>
  )
}

function Step({ icon: Icon, title, body }) {
  return (
    <div className="flex gap-4 rounded-2xl border border-white/[0.08] bg-white/[0.02] p-4">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-white/10 bg-white/[0.04] text-orange-300">
        <Icon size={16} />
      </span>
      <div>
        <p className="text-sm font-semibold text-white">{title}</p>
        <p className="mt-1 text-xs leading-relaxed text-gray-400">{body}</p>
      </div>
    </div>
  )
}

```

## 2.8 src/index.css

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

/* ==========================================================================
   M-HUSTLE DESIGN SYSTEM
   Ink-black canvas · warm radial glows · glass surfaces · editorial type
   ========================================================================== */

@layer base {
  :root {
    color-scheme: dark;
    --ink: 10 10 18;
    --glass: 20 20 30;
    --hairline: 255 255 255;
  }

  * {
    -webkit-tap-highlight-color: transparent;
  }

  html {
    scroll-behavior: smooth;
  }

  body {
    @apply min-h-screen bg-ink-900 font-sans text-white antialiased;
    background-image:
      radial-gradient(52rem 42rem at 8% -12%, rgba(249, 115, 22, 0.18), transparent 62%),
      radial-gradient(46rem 40rem at 96% -4%, rgba(236, 72, 153, 0.15), transparent 60%),
      radial-gradient(60rem 48rem at 50% 118%, rgba(139, 92, 246, 0.12), transparent 65%),
      linear-gradient(180deg, #0a0a12 0%, #08080f 55%, #0a0a12 100%);
    background-attachment: fixed;
  }

  h1,
  h2,
  h3,
  h4,
  h5,
  h6 {
    @apply font-display tracking-tight text-white;
  }

  ::selection {
    background: rgba(249, 115, 22, 0.35);
    color: #fff;
  }

  :focus-visible {
    outline: 2px solid rgba(249, 115, 22, 0.75);
    outline-offset: 2px;
  }

  ::-webkit-scrollbar {
    width: 10px;
    height: 10px;
  }

  ::-webkit-scrollbar-track {
    background: transparent;
  }

  ::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.12);
    border-radius: 9999px;
    border: 2px solid transparent;
    background-clip: content-box;
  }

  ::-webkit-scrollbar-thumb:hover {
    background: rgba(255, 255, 255, 0.22);
    background-clip: content-box;
  }

  input[type='number']::-webkit-outer-spin-button,
  input[type='number']::-webkit-inner-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }

  input[type='number'] {
    -moz-appearance: textfield;
  }
}

@layer components {
  /* ---------------------------------------------------------------- surfaces */
  .glass {
    background: rgba(20, 20, 30, 0.7);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    border: 1px solid rgba(255, 255, 255, 0.08);
  }

  .glass-soft {
    background: rgba(20, 20, 30, 0.45);
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    border: 1px solid rgba(255, 255, 255, 0.06);
  }

  .glass-hover {
    transition:
      border-color 220ms ease,
      background-color 220ms ease,
      transform 220ms ease,
      box-shadow 220ms ease;
  }

  .glass-hover:hover {
    border-color: rgba(249, 115, 22, 0.28);
    background: rgba(27, 27, 40, 0.78);
    box-shadow: 0 24px 60px -32px rgba(0, 0, 0, 0.95);
  }

  .card {
    @apply glass rounded-3xl;
  }

  .hairline {
    border-color: rgba(255, 255, 255, 0.08);
  }

  /* ---------------------------------------------------------------- buttons */
  .btn {
    @apply inline-flex select-none items-center justify-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-50;
  }

  .btn-primary {
    @apply btn bg-gradient-to-r from-orange-500 to-pink-500 text-white shadow-[0_10px_40px_-16px_rgba(236,72,153,0.8)] hover:brightness-110 active:scale-[0.985];
  }

  .btn-seller {
    @apply btn bg-gradient-to-r from-green-500 to-emerald-500 text-ink-950 shadow-[0_10px_40px_-16px_rgba(16,185,129,0.7)] hover:brightness-110 active:scale-[0.985];
  }

  .btn-admin {
    @apply btn bg-gradient-to-r from-purple-500 to-blue-500 text-white shadow-[0_10px_40px_-16px_rgba(99,102,241,0.8)] hover:brightness-110 active:scale-[0.985];
  }

  .btn-secondary {
    @apply btn border border-white/10 bg-white/[0.04] text-white hover:border-white/20 hover:bg-white/[0.08];
  }

  .btn-ghost {
    @apply btn text-gray-300 hover:bg-white/[0.06] hover:text-white;
  }

  .btn-danger {
    @apply btn border border-red-500/25 bg-red-500/10 text-red-300 hover:border-red-500/40 hover:bg-red-500/20;
  }

  .btn-sm {
    @apply px-3.5 py-2 text-xs;
  }

  .icon-btn {
    @apply inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-gray-300 transition hover:border-white/20 hover:bg-white/[0.08] hover:text-white;
  }

  /* ----------------------------------------------------------------- inputs */
  .label {
    @apply mb-1.5 block text-xs font-medium uppercase tracking-[0.14em] text-gray-400;
  }

  .input {
    @apply w-full rounded-2xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-white placeholder-gray-500 transition focus:border-orange-400/60 focus:bg-black/40 focus:outline-none focus:ring-2 focus:ring-orange-500/15;
  }

  .input-error {
    @apply border-red-500/50 focus:border-red-400 focus:ring-red-500/20;
  }

  .textarea {
    @apply input min-h-[120px] resize-y leading-relaxed;
  }

  .select {
    @apply input appearance-none pr-10;
  }

  .field-hint {
    @apply mt-1.5 text-xs leading-relaxed text-gray-500;
  }

  .field-error {
    @apply mt-1.5 flex items-center gap-1.5 text-xs text-red-400;
  }

  /* ------------------------------------------------------------------ chips */
  .chip {
    @apply inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-xs font-medium text-gray-300 transition hover:border-white/20 hover:text-white;
  }

  .chip-active {
    @apply border-orange-400/40 bg-orange-500/15 text-orange-200;
  }

  .badge {
    @apply inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium tracking-wide;
  }

  /* ------------------------------------------------------------------ text */
  .gradient-text {
    @apply bg-gradient-to-r from-orange-400 via-pink-400 to-rose-400 bg-clip-text text-transparent;
  }

  .eyebrow {
    @apply text-[11px] font-semibold uppercase tracking-[0.28em] text-orange-300/80;
  }

  .muted {
    @apply text-gray-400;
  }

  .link {
    @apply text-orange-300 underline-offset-4 transition hover:text-orange-200 hover:underline;
  }

  /* ---------------------------------------------------------------- skeleton */
  .skeleton {
    @apply relative overflow-hidden rounded-2xl bg-white/[0.055];
  }

  .skeleton::after {
    content: '';
    position: absolute;
    inset: 0;
    transform: translateX(-100%);
    background: linear-gradient(
      90deg,
      transparent,
      rgba(255, 255, 255, 0.06),
      transparent
    );
    animation: shimmer 1.6s infinite;
  }

  /* --------------------------------------------------------------- utilities */
  .no-scrollbar {
    -ms-overflow-style: none;
    scrollbar-width: none;
  }

  .no-scrollbar::-webkit-scrollbar {
    display: none;
  }

  .divide-hairline > :not([hidden]) ~ :not([hidden]) {
    border-color: rgba(255, 255, 255, 0.07);
  }

  .safe-bottom {
    padding-bottom: env(safe-area-inset-bottom);
  }
}

@layer utilities {
  .text-balance {
    text-wrap: balance;
  }

  .text-pretty {
    text-wrap: pretty;
  }

  .mask-fade-r {
    -webkit-mask-image: linear-gradient(to right, black 85%, transparent 100%);
    mask-image: linear-gradient(to right, black 85%, transparent 100%);
  }
}

```

---

# SECTION 3 — Supabase helpers and components

## 3.1 src/lib/supabase.js

```js
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

const looksLikePlaceholder =
  !supabaseUrl ||
  !supabaseAnonKey ||
  /your-project|your-anon|example\.supabase\.co|public-anon-key-not-configured/i.test(
    `${supabaseUrl} ${supabaseAnonKey}`,
  )

/**
 * True only when both environment variables are present and do not contain the
 * shipped placeholder values. The UI renders a setup screen instead of a
 * broken marketplace when this is false.
 */
export const isSupabaseConfigured = Boolean(
  supabaseUrl && supabaseAnonKey && !looksLikePlaceholder,
)

if (supabaseUrl && supabaseAnonKey && looksLikePlaceholder) {
  console.warn(
    '[M-Hustle] Supabase credentials still contain placeholder text. Update .env and restart the dev server.',
  )
}

// The fallback values keep module evaluation safe so the configuration screen
// can render. No request is ever made until Supabase is configured.
export const supabase = createClient(
  supabaseUrl || 'http://localhost:54321',
  supabaseAnonKey || 'public-anon-key-not-configured',
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storageKey: 'm-hustle-auth',
    },
    global: {
      headers: {
        'x-application-name': 'm-hustle',
      },
    },
  },
)

export const LISTING_IMAGES_BUCKET = 'listing-images'

```

## 3.2 src/lib/constants.js

```js
import {
  BedDouble,
  BookOpen,
  Dumbbell,
  Laptop,
  Package,
  PenLine,
  Shirt,
  Sparkles,
  UtensilsCrossed,
  Wrench,
} from 'lucide-react'

/** Exact Maseno hostel list used by the Edit Profile location dropdown. */
export const HOSTELS = [
  'Kilimanjaro',
  'Niles',
  'Nyabundi',
  'ACV',
  'Equator',
  'Elgon',
  'Mara 1',
  'Mara 2',
  'Mara 3',
  'Mara 4',
  'Rusinga',
  'Ndeere',
  'Victoria',
]

/** Category values are stored as plain text in public.listings.category. */
export const CATEGORIES = [
  { value: 'Electronics', icon: Laptop },
  { value: 'Textbooks', icon: BookOpen },
  { value: 'Fashion', icon: Shirt },
  { value: 'Food', icon: UtensilsCrossed },
  { value: 'Hostel & Living', icon: BedDouble },
  { value: 'Services', icon: Wrench },
  { value: 'Stationery', icon: PenLine },
  { value: 'Sports & Fitness', icon: Dumbbell },
  { value: 'Other', icon: Package },
]

export function categoryIcon(category) {
  return CATEGORIES.find((item) => item.value === category)?.icon ?? Sparkles
}

export const PLANS = [
  {
    id: 'pro',
    name: 'Pro',
    price: 100,
    tagline: 'Stand out from the crowd',
    description: 'A blue verified badge on every listing and priority placement above free sellers.',
    accent: 'from-blue-500 to-cyan-400',
    ring: 'border-blue-400/30',
    glow: 'shadow-[0_0_60px_-18px_rgba(59,130,246,0.65)]',
    badge: 'pro',
    features: [
      'Blue verified badge',
      'Priority above free listings',
      '30 days of visibility',
      'Unlimited active listings',
    ],
  },
  {
    id: 'pro_max',
    name: 'Pro Max',
    price: 300,
    tagline: 'The top of the feed',
    description: 'The gold badge, first position in search, and the strongest seller presence on campus.',
    accent: 'from-amber-400 to-yellow-500',
    ring: 'border-amber-400/40',
    glow: 'shadow-[0_0_60px_-18px_rgba(245,158,11,0.7)]',
    badge: 'pro_max',
    features: [
      'Gold verified badge',
      'Top priority in search and feed',
      '30 days of visibility',
      'Unlimited active listings',
    ],
  },
]

export const PLAN_BY_ID = Object.fromEntries(PLANS.map((plan) => [plan.id, plan]))

// Live M-Pesa collection details for subscription upgrades.
export const MPESA_PAYBILL = '400200'
export const MPESA_ACCOUNT = '1211964'
export const ORGANISATION = 'HartTech'
export const SUPPORT_EMAIL = 'helloharttech@gmail.com'

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif']

```

## 3.3 src/lib/utils.js

```js
import { format, formatDistanceToNow, isToday, isYesterday } from 'date-fns'

/** Join conditional class names without pulling in another dependency. */
export function cn(...classes) {
  return classes.filter(Boolean).join(' ')
}

/** KES 12,500 — never "$" and never a bare number. */
export function formatKES(value, { compact = false } = {}) {
  const amount = Number(value ?? 0)
  if (!Number.isFinite(amount)) return 'KES 0'

  if (compact && Math.abs(amount) >= 1_000_000) {
    const millions = amount / 1_000_000
    return `KES ${trimZeros(millions.toFixed(1))}M`
  }
  if (compact && Math.abs(amount) >= 10_000) {
    const thousands = amount / 1_000
    return `KES ${trimZeros(thousands.toFixed(1))}K`
  }

  const hasCents = Math.round(amount * 100) % 100 !== 0
  return `KES ${new Intl.NumberFormat('en-KE', {
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(amount)}`
}

function trimZeros(text) {
  return text.replace(/\.0$/, '')
}

/** "12 Mar 2025" */
export function formatDate(value) {
  if (!value) return '—'
  try {
    return format(new Date(value), 'd MMM yyyy')
  } catch {
    return '—'
  }
}

/** "12 Mar 2025, 14:08" */
export function formatDateTime(value) {
  if (!value) return '—'
  try {
    return format(new Date(value), 'd MMM yyyy, HH:mm')
  } catch {
    return '—'
  }
}

/** "3 hours ago" */
export function timeAgo(value) {
  if (!value) return ''
  try {
    return formatDistanceToNow(new Date(value), { addSuffix: true })
  } catch {
    return ''
  }
}

/** Chat timestamps: "14:08", "Yesterday", "12 Mar" */
export function chatTime(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  if (isToday(date)) return format(date, 'HH:mm')
  if (isYesterday(date)) return 'Yesterday'
  return format(date, 'd MMM')
}

export function initials(name = '') {
  return (
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('') || 'MH'
  )
}

export function truncate(text = '', length = 120) {
  if (text.length <= length) return text
  return `${text.slice(0, length).trimEnd()}…`
}

/** Returns the best live plan for a seller id, or null. */
export function planForSeller(badges, sellerId) {
  if (!badges || !sellerId) return null
  const badge = badges[sellerId]
  return badge ?? null
}

/** Paid plans always rank above free listings. */
export function planRank(plan) {
  if (plan === 'pro_max') return 2
  if (plan === 'pro') return 1
  return 0
}

export function sortListingsByPriority(listings, badges, ratings = {}) {
  return [...listings].sort((a, b) => {
    const rankDiff =
      planRank(badges?.[b.seller_id]?.plan) - planRank(badges?.[a.seller_id]?.plan)
    if (rankDiff !== 0) return rankDiff

    const ratingA = Number(ratings?.[a.seller_id]?.average_rating ?? 0)
    const ratingB = Number(ratings?.[b.seller_id]?.average_rating ?? 0)
    if (ratingB !== ratingA) return ratingB - ratingA

    const reviewsA = Number(ratings?.[a.seller_id]?.review_count ?? 0)
    const reviewsB = Number(ratings?.[b.seller_id]?.review_count ?? 0)
    if (reviewsB !== reviewsA) return reviewsB - reviewsA

    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  })
}

export function groupBySeller(items) {
  const groups = new Map()
  for (const item of items) {
    if (!groups.has(item.seller_id)) {
      groups.set(item.seller_id, {
        sellerId: item.seller_id,
        sellerName: item.seller_name || 'Seller',
        items: [],
      })
    }
    groups.get(item.seller_id).items.push(item)
  }
  return [...groups.values()]
}

const ERROR_MESSAGES = {
  LISTING_UNAVAILABLE: 'One of these items was just sold. Remove it from your cart and try again.',
  LISTING_NOT_FOUND: 'One of these listings no longer exists.',
  INSUFFICIENT_STOCK: 'One of these items no longer has enough stock. Reduce the quantity and try again.',
  SELLER_MISMATCH: 'This cart contains items from a different seller.',
  INVALID_QUANTITY: 'One item has an invalid quantity.',
  EMPTY_CART: 'Your cart is empty.',
  TOO_MANY_ITEMS: 'You can order at most 20 different items from one seller at a time.',
  AUTH_REQUIRED: 'Please sign in to continue.',
  ACCOUNT_SUSPENDED: 'This account is suspended. Contact the M-Hustle team.',
  INVALID_SELLER: 'You cannot buy from this seller.',
  SELLER_UNAVAILABLE: 'This seller is not accepting orders right now.',
  USERNAME_LOGIN_UNAVAILABLE:
    'Username sign-in is not enabled in the database yet. Run the latest schema update, or sign in with your email.',
  ROLE_CHANGE_FORBIDDEN: 'You are not allowed to change your role.',
  SUSPENSION_CHANGE_FORBIDDEN: 'You are not allowed to change account status.',
  EMAIL_CHANGE_FORBIDDEN: 'Email addresses cannot be changed here.',
  INVALID_ORDER_TRANSITION: 'That order status change is not allowed.',
  ORDER_FIELDS_IMMUTABLE: 'Order totals and parties cannot be edited.',
  MESSAGE_IMMUTABLE: 'Messages can only be marked as read.',
  CANNOT_SUSPEND_SELF: 'You cannot suspend your own admin account.',
  CANNOT_DELETE_SELF: 'You cannot delete your own account from the console.',
  FORBIDDEN: 'You do not have permission to perform this action.',
  USER_NOT_FOUND: 'That user no longer exists.',
}

/** Turn Postgres / Supabase errors into copy a student can act on. */
export function friendlyError(error, fallback = 'Something went wrong. Please try again.') {
  if (!error) return fallback
  const message = typeof error === 'string' ? error : error.message || ''

  for (const [key, copy] of Object.entries(ERROR_MESSAGES)) {
    if (message.includes(key)) return copy
  }

  if (message.includes('duplicate key') && message.includes('reviews_order_id')) {
    return 'You have already reviewed this order.'
  }
  if (message.includes('duplicate key') && message.includes('mpesa')) {
    return 'That M-Pesa code has already been submitted.'
  }
  if (message.includes('duplicate key') && message.includes('username')) {
    return 'That username is already taken.'
  }
  if (message.includes('duplicate key')) {
    return 'That record already exists.'
  }
  if (message.includes('row-level security') || message.includes('permission denied')) {
    return 'Your account does not have permission for that action.'
  }
  if (message.includes('Failed to fetch') || message.includes('NetworkError')) {
    return 'Cannot reach the server. Check your connection and try again.'
  }
  if (message.includes('JWT') || message.includes('session')) {
    return 'Your session expired. Please sign in again.'
  }

  return message || fallback
}

export const ORDER_STATUS_META = {
  pending: {
    label: 'Pending',
    className: 'border-amber-400/25 bg-amber-400/10 text-amber-300',
    dot: 'bg-amber-400',
  },
  delivered: {
    label: 'Delivered',
    className: 'border-sky-400/25 bg-sky-400/10 text-sky-300',
    dot: 'bg-sky-400',
  },
  completed: {
    label: 'Completed',
    className: 'border-emerald-400/25 bg-emerald-400/10 text-emerald-300',
    dot: 'bg-emerald-400',
  },
  cancelled: {
    label: 'Cancelled',
    className: 'border-red-400/25 bg-red-400/10 text-red-300',
    dot: 'bg-red-400',
  },
}

export const LISTING_STATUS_META = {
  active: {
    label: 'Active',
    className: 'border-emerald-400/25 bg-emerald-400/10 text-emerald-300',
  },
  sold: {
    label: 'Sold',
    className: 'border-sky-400/25 bg-sky-400/10 text-sky-300',
  },
  deleted: {
    label: 'Removed',
    className: 'border-red-400/25 bg-red-400/10 text-red-300',
  },
}

export const SUBSCRIPTION_STATUS_META = {
  pending: {
    label: 'Awaiting approval',
    className: 'border-amber-400/25 bg-amber-400/10 text-amber-300',
  },
  active: {
    label: 'Active',
    className: 'border-emerald-400/25 bg-emerald-400/10 text-emerald-300',
  },
  expired: {
    label: 'Expired',
    className: 'border-white/15 bg-white/5 text-gray-400',
  },
}

```

## 3.4 src/hooks/useAuth.jsx

```jsx
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { supabase } from '../lib/supabase'

const AuthContext = createContext(null)

const PROFILE_COLUMNS =
  'id, username, full_name, role, avatar_url, location, is_suspended, created_at'

/**
 * Loads the signed-in user's full profile through a SECURITY DEFINER RPC.
 * Email and phone are not readable from a broad `profiles` table read, so
 * this is the only path for the owner's private fields.
 *
 * The profile row is created by an auth trigger. The short retry loop covers
 * the small window between the auth insert and the trigger commit.
 */
async function fetchOwnProfile(userId) {
  if (!userId) return null

  let lastError = null

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { data, error } = await supabase.rpc('get_my_profile')

    if (error) {
      lastError = error
      // PGRST202 = function not found (schema.sql not applied yet).
      if (error.code === 'PGRST202') break
    } else {
      const row = Array.isArray(data) ? data[0] : data
      if (row) return row
    }

    await new Promise((resolve) => setTimeout(resolve, 350))
  }

  // Defensive fallback for projects where the RPC is not installed yet.
  const { data, error } = await supabase
    .from('profiles')
    .select(PROFILE_COLUMNS)
    .eq('id', userId)
    .maybeSingle()

  if (error) throw lastError || error
  if (!data) return null

  return { ...data, email: null, phone: null }
}

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null)
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)
  const [profileError, setProfileError] = useState(null)

  const activeRef = useRef(true)
  const requestRef = useRef(0)

  const loadProfile = useCallback(async (userId) => {
    if (!userId) {
      setProfile(null)
      return null
    }

    const requestId = requestRef.current + 1
    requestRef.current = requestId
    setProfileError(null)

    try {
      const row = await fetchOwnProfile(userId)
      if (activeRef.current && requestRef.current === requestId) {
        setProfile(row)
        if (!row) setProfileError('Your profile could not be loaded.')
      }
      return row
    } catch (error) {
      if (activeRef.current && requestRef.current === requestId) {
        setProfile(null)
        setProfileError(error?.message || 'Your profile could not be loaded.')
      }
      return null
    }
  }, [])

  useEffect(() => {
    activeRef.current = true
    let active = true

    const bootstrap = async () => {
      const {
        data: { session: initialSession },
      } = await supabase.auth.getSession()

      if (!active) return

      setSession(initialSession)

      if (initialSession?.user) {
        await loadProfile(initialSession.user.id)
      }

      if (active) setLoading(false)
    }

    void bootstrap()

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (!active) return

      setSession(nextSession)

      if (!nextSession?.user || event === 'SIGNED_OUT') {
        setProfile(null)
        setProfileError(null)
        setLoading(false)
        return
      }

      if (event === 'SIGNED_IN' || event === 'USER_UPDATED') {
        void loadProfile(nextSession.user.id)
      }

      setLoading(false)
    })

    return () => {
      active = false
      activeRef.current = false
      subscription.unsubscribe()
    }
  }, [loadProfile])

  const signIn = useCallback(
    async (identifier, password) => {
      const handle = identifier.trim()
      let loginEmail = handle

      // A value without "@" is treated as a username. Resolve it to the
      // account email that Supabase Auth expects, then use the normal
      // password grant. Usernames are unique and case-insensitive.
      if (!handle.includes('@')) {
        const { data: resolved, error: lookupError } = await supabase.rpc(
          'login_email_for_username',
          { p_username: handle },
        )

        if (lookupError) {
          if (lookupError.code === 'PGRST202') {
            return {
              data: null,
              profile: null,
              error: new Error('USERNAME_LOGIN_UNAVAILABLE'),
            }
          }
          return { data: null, profile: null, error: lookupError }
        }

        const resolvedEmail = Array.isArray(resolved)
          ? resolved[0]?.email ?? resolved[0]
          : resolved

        if (!resolvedEmail) {
          return {
            data: null,
            profile: null,
            error: new Error('Invalid login credentials'),
          }
        }

        loginEmail = resolvedEmail
      }

      const { data, error } = await supabase.auth.signInWithPassword({
        email: loginEmail,
        password,
      })

      if (error) return { data: null, profile: null, error }

      const nextProfile = data.user ? await loadProfile(data.user.id) : null
      return { data, profile: nextProfile, error: null }
    },
    [loadProfile],
  )

  const signUp = useCallback(
    async ({ email, password, fullName, username, role, phone }) => {
      const { data, error } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: {
          data: {
            full_name: fullName.trim(),
            username: username.trim().toLowerCase(),
            role: role === 'seller' ? 'seller' : 'buyer',
            phone: phone?.trim() || null,
          },
        },
      })

      if (error) return { data: null, profile: null, error }

      if (data.session?.user) {
        const nextProfile = await loadProfile(data.session.user.id)
        return { data, profile: nextProfile, error: null }
      }

      return { data, profile: null, error: null }
    },
    [loadProfile],
  )

  const signOut = useCallback(async () => {
    await supabase.auth.signOut()
    setSession(null)
    setProfile(null)
    setProfileError(null)
  }, [])

  const updateProfile = useCallback(
    async (patch) => {
      const userId = session?.user?.id
      if (!userId) return { error: new Error('Not signed in') }

      const { error } = await supabase
        .from('profiles')
        .update(patch)
        .eq('id', userId)

      if (error) return { error }

      await loadProfile(userId)
      return { error: null }
    },
    [loadProfile, session?.user?.id],
  )

  const refreshProfile = useCallback(async () => {
    if (!session?.user?.id) return null
    return loadProfile(session.user.id)
  }, [loadProfile, session?.user?.id])

  const value = useMemo(() => {
    const user = session?.user ?? null
    return {
      session,
      user,
      profile,
      loading,
      profileError,
      isAdmin: profile?.role === 'admin',
      isSeller: profile?.role === 'seller',
      isSuspended: Boolean(profile?.is_suspended),
      signIn,
      signUp,
      signOut,
      updateProfile,
      refreshProfile,
    }
  }, [
    session,
    profile,
    loading,
    profileError,
    signIn,
    signUp,
    signOut,
    updateProfile,
    refreshProfile,
  ])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used inside <AuthProvider>')
  }
  return context
}

```

## 3.5 src/context/CartContext.jsx

```jsx
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'

const CART_KEY = 'm-hustle-cart-v1'
const CartContext = createContext(null)

function readCart() {
  try {
    const raw = localStorage.getItem(CART_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item) =>
        item &&
        typeof item.id === 'string' &&
        typeof item.seller_id === 'string' &&
        Number.isFinite(Number(item.price)) &&
        Number.isFinite(Number(item.quantity)),
    )
  } catch {
    return []
  }
}

export function CartProvider({ children }) {
  const [items, setItems] = useState(readCart)

  useEffect(() => {
    try {
      localStorage.setItem(CART_KEY, JSON.stringify(items))
    } catch {
      // Storage can be unavailable in private mode; the in-memory cart still works.
    }
  }, [items])

  const addItem = useCallback((listing, quantity = 1, sellerName = '') => {
    const stock = Math.max(0, Number(listing.quantity ?? 1))
    if (stock <= 0) return false

    const amount = Math.min(Math.max(Number(quantity) || 1, 1), 99, stock)

    setItems((current) => {
      const existing = current.find((item) => item.id === listing.id)

      if (existing) {
        return current.map((item) =>
          item.id === listing.id
            ? {
                ...item,
                stock,
                quantity: Math.min(item.quantity + amount, 99, stock),
              }
            : item,
        )
      }

      return [
        ...current,
        {
          id: listing.id,
          title: listing.title,
          price: Number(listing.price),
          image_url: listing.image_url ?? null,
          category: listing.category ?? 'Other',
          seller_id: listing.seller_id,
          seller_name: sellerName || listing.seller?.full_name || listing.seller?.username || 'Seller',
          stock,
          quantity: amount,
        },
      ]
    })

    return true
  }, [])

  const removeItem = useCallback((listingId) => {
    setItems((current) => current.filter((item) => item.id !== listingId))
  }, [])

  const setQuantity = useCallback((listingId, quantity) => {
    const amount = Number(quantity)
    if (!Number.isFinite(amount) || amount < 1) return

    setItems((current) =>
      current.map((item) =>
        item.id === listingId
          ? {
              ...item,
              quantity: Math.min(
                Math.floor(amount),
                99,
                Math.max(1, Number(item.stock ?? 99)),
              ),
            }
          : item,
      ),
    )
  }, [])

  const clearCart = useCallback(() => setItems([]), [])

  const { count, subtotal } = useMemo(() => {
    return items.reduce(
      (acc, item) => {
        acc.count += item.quantity
        acc.subtotal += Number(item.price) * item.quantity
        return acc
      },
      { count: 0, subtotal: 0 },
    )
  }, [items])

  const value = useMemo(
    () => ({
      items,
      count,
      subtotal,
      addItem,
      removeItem,
      setQuantity,
      clearCart,
    }),
    [items, count, subtotal, addItem, removeItem, setQuantity, clearCart],
  )

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>
}

export function useCart() {
  const context = useContext(CartContext)
  if (!context) {
    throw new Error('useCart must be used inside <CartProvider>')
  }
  return context
}

```

## 3.6 src/components/VerifiedBadge.jsx

```jsx
import { useId } from 'react'

/**
 * Meta-style scalloped verification seal.
 *
 * The 12-lobe path is generated from a smooth Catmull-Rom curve through
 * alternating radii, which produces the familiar "seal" silhouette without
 * any raster assets. Blue = Pro, gold = Pro Max.
 */
const SEAL_PATH =
  'M12 1.8 C12.74 1.8 13.38 3.47 14.23 3.69 C15.08 3.92 16.46 2.8 17.1 3.17 C17.74 3.54 17.46 5.3 18.08 5.92 C18.7 6.54 20.46 6.26 20.83 6.9 C21.2 7.54 20.08 8.92 20.31 9.77 C20.53 10.62 22.2 11.26 22.2 12 C22.2 12.74 20.53 13.38 20.31 14.23 C20.08 15.08 21.2 16.46 20.83 17.1 C20.46 17.74 18.7 17.46 18.08 18.08 C17.46 18.7 17.74 20.46 17.1 20.83 C16.46 21.2 15.08 20.08 14.23 20.31 C13.38 20.53 12.74 22.2 12 22.2 C11.26 22.2 10.62 20.53 9.77 20.31 C8.92 20.08 7.54 21.2 6.9 20.83 C6.26 20.46 6.54 18.7 5.92 18.08 C5.3 17.46 3.54 17.74 3.17 17.1 C2.8 16.46 3.92 15.08 3.69 14.23 C3.47 13.38 1.8 12.74 1.8 12 C1.8 11.26 3.47 10.62 3.69 9.77 C3.92 8.92 2.8 7.54 3.17 6.9 C3.54 6.26 5.3 6.54 5.92 5.92 C6.54 5.3 6.26 3.54 6.9 3.17 C7.54 2.8 8.92 3.92 9.77 3.69 C10.62 3.47 11.26 1.8 12 1.8 Z'

const PLAN_THEME = {
  pro: {
    label: 'Pro seller',
    from: '#93c5fd',
    to: '#2563eb',
    stroke: 'rgba(37, 99, 235, 0.55)',
  },
  pro_max: {
    label: 'Pro Max seller',
    from: '#fde68a',
    to: '#d97706',
    stroke: 'rgba(217, 119, 6, 0.55)',
  },
}

export default function VerifiedBadge({
  plan = 'pro',
  size = 16,
  className = '',
  withLabel = false,
  labelClassName = '',
}) {
  const reactId = useId().replace(/[:]/g, '')
  const theme = PLAN_THEME[plan] ?? PLAN_THEME.pro
  const gradientId = `mh-badge-${plan}-${reactId}`

  const seal = (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      role="img"
      aria-label={theme.label}
      className={className}
      style={{ flexShrink: 0 }}
    >
      <defs>
        <linearGradient
          id={gradientId}
          x1="0"
          y1="0"
          x2="24"
          y2="24"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor={theme.from} />
          <stop offset="100%" stopColor={theme.to} />
        </linearGradient>
      </defs>
      <path
        d={SEAL_PATH}
        fill={`url(#${gradientId})`}
        stroke={theme.stroke}
        strokeWidth="0.7"
      />
      <path
        d="M7.45 12.25 10.4 15.2 16.6 8.85"
        fill="none"
        stroke="#ffffff"
        strokeWidth="2.15"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )

  if (!withLabel) return seal

  return (
    <span className={`inline-flex items-center gap-1.5 ${labelClassName}`}>
      {seal}
      <span className="text-[11px] font-semibold uppercase tracking-[0.12em]">
        {theme.label.replace(' seller', '')}
      </span>
    </span>
  )
}

```

## 3.7 src/components/Navbar.jsx

```jsx
import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import {
  ChevronDown,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageSquare,
  Package,
  Search,
  ShoppingBag,
  Store,
  UserRound,
  X,
} from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { useCart } from '../context/CartContext'
import { supabase } from '../lib/supabase'
import { cn } from '../lib/utils'
import { Avatar } from './ui'

export function Brand({ compact = false }) {
  return (
    <Link to="/" className="group flex items-center gap-2.5" aria-label="M-Hustle home">
      <span className="relative grid h-10 w-10 place-items-center overflow-hidden rounded-2xl bg-gradient-to-br from-orange-500 to-pink-500 shadow-[0_10px_30px_-12px_rgba(236,72,153,0.9)] transition group-hover:brightness-110">
        <span className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgba(255,255,255,0.35),transparent_55%)]" />
        <span className="relative font-display text-lg font-extrabold text-white">M</span>
      </span>
      {!compact ? (
        <span className="leading-none">
          <span className="block font-display text-[17px] font-bold tracking-tight text-white">
            M-Hustle
          </span>
          <span className="mt-1 hidden text-[9px] font-medium uppercase tracking-[0.24em] text-gray-500 sm:block">
            Maseno Marketplace
          </span>
        </span>
      ) : null}
    </Link>
  )
}

const NAV_LINKS = [
  { to: '/', label: 'Marketplace', icon: Store },
  { to: '/orders', label: 'Orders', icon: Package, auth: true },
  { to: '/messages', label: 'Messages', icon: MessageSquare, auth: true },
]

export default function Navbar() {
  const { user, profile, signOut, isAdmin, isSeller } = useAuth()
  const { count } = useCart()
  const location = useLocation()
  const navigate = useNavigate()

  const [search, setSearch] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [unread, setUnread] = useState(0)
  const menuRef = useRef(null)

  const username = profile?.username
  const role = profile?.role

  useEffect(() => {
    const params = new URLSearchParams(location.search)
    setSearch(params.get('q') ?? '')
    setMobileOpen(false)
    setMenuOpen(false)
  }, [location.pathname, location.search])

  useEffect(() => {
    if (!user) {
      setUnread(0)
      return undefined
    }

    let cancelled = false

    const loadUnread = async () => {
      const { count: unreadCount } = await supabase
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .eq('receiver_id', user.id)
        .eq('is_read', false)

      if (!cancelled) setUnread(unreadCount ?? 0)
    }

    void loadUnread()

    const channel = supabase
      .channel(`navbar-unread-${user.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'messages' },
        () => void loadUnread(),
      )
      .subscribe()

    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [user])

  useEffect(() => {
    if (!menuOpen) return undefined

    const handler = (event) => {
      if (!menuRef.current?.contains(event.target)) setMenuOpen(false)
    }

    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [menuOpen])

  const onSearch = (event) => {
    event.preventDefault()
    const term = search.trim()
    navigate(term ? `/?q=${encodeURIComponent(term)}` : '/')
  }

  const workspace = isSeller
    ? { to: '/seller', label: 'Seller studio', icon: LayoutDashboard }
    : null

  const roleLabel = isAdmin ? 'Admin' : isSeller ? 'Seller' : 'Buyer'

  const closeAll = () => {
    setMobileOpen(false)
    setMenuOpen(false)
  }

  return (
    <header className="sticky top-0 z-50 border-b border-white/[0.06] bg-ink-900/75 backdrop-blur-2xl">
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-3 px-4 sm:px-6 lg:px-8">
        <Brand />

        <nav className="ml-4 hidden items-center gap-1 lg:flex">
          {NAV_LINKS.filter((link) => !link.auth || user).map(({ to, label }) => {
            const active = to === '/' ? location.pathname === '/' : location.pathname.startsWith(to)
            return (
              <Link
                key={to}
                to={to}
                className={cn(
                  'rounded-full px-3.5 py-2 text-sm font-medium transition',
                  active
                    ? 'bg-white/[0.07] text-white'
                    : 'text-gray-400 hover:bg-white/[0.04] hover:text-white',
                )}
              >
                {label}
              </Link>
            )
          })}
        </nav>

        <form onSubmit={onSearch} className="ml-auto hidden max-w-md flex-1 md:block lg:ml-6">
          <div className="group relative">
            <Search
              size={16}
              className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-500 transition group-focus-within:text-orange-300"
            />
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search textbooks, tech, food…"
              aria-label="Search listings"
              className="h-10 w-full rounded-full border border-white/10 bg-black/25 pl-10 pr-4 text-sm text-white placeholder-gray-500 transition focus:border-orange-400/50 focus:bg-black/40 focus:outline-none focus:ring-2 focus:ring-orange-500/10"
            />
          </div>
        </form>

        <div className="ml-auto flex items-center gap-1.5 md:ml-2">
          {user ? (
            <Link
              to="/messages"
              className="icon-btn relative hidden sm:inline-flex"
              aria-label={`Messages${unread ? `, ${unread} unread` : ''}`}
            >
              <MessageSquare size={18} />
              {unread > 0 ? (
                <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-gradient-to-r from-orange-500 to-pink-500 px-1 text-[10px] font-bold text-white">
                  {unread > 9 ? '9+' : unread}
                </span>
              ) : null}
            </Link>
          ) : null}

          <Link
            to="/cart"
            className="icon-btn relative"
            aria-label={`Cart${count ? `, ${count} items` : ''}`}
          >
            <ShoppingBag size={18} />
            {count > 0 ? (
              <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-gradient-to-r from-orange-500 to-pink-500 px-1 text-[10px] font-bold text-white">
                {count > 9 ? '9+' : count}
              </span>
            ) : null}
          </Link>

          {user ? (
            <div ref={menuRef} className="relative">
              <button
                type="button"
                onClick={() => setMenuOpen((open) => !open)}
                className="flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] p-1 pr-2 transition hover:border-white/20 hover:bg-white/[0.07]"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
              >
                <Avatar profile={profile} size={30} />
                <ChevronDown
                  size={14}
                  className={cn('text-gray-400 transition', menuOpen && 'rotate-180')}
                />
              </button>

              {menuOpen ? (
                <div
                  role="menu"
                  className="glass absolute right-0 mt-2 w-64 animate-fade-up overflow-hidden rounded-2xl p-2 shadow-card"
                >
                  <div className="flex items-center gap-3 rounded-xl px-2.5 py-2.5">
                    <Avatar profile={profile} size={38} />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-white">
                        {profile?.full_name ?? 'M-Hustle member'}
                      </p>
                      <p className="truncate text-xs text-gray-500">
                        @{username ?? 'member'} · {roleLabel}
                      </p>
                    </div>
                  </div>

                  <div className="my-1 h-px bg-white/[0.07]" />

                  <MenuLink to="/orders" icon={Package} onClick={closeAll} label="My orders" />
                  <MenuLink to="/messages" icon={MessageSquare} onClick={closeAll} label="Messages">
                    {unread > 0 ? (
                      <span className="ml-auto rounded-full bg-orange-500/15 px-2 py-0.5 text-[10px] font-semibold text-orange-300">
                        {unread}
                      </span>
                    ) : null}
                  </MenuLink>
                  {workspace ? (
                    <MenuLink
                      to={workspace.to}
                      icon={workspace.icon}
                      onClick={closeAll}
                      label={workspace.label}
                    />
                  ) : null}
                  <MenuLink
                    to="/profile"
                    icon={UserRound}
                    onClick={closeAll}
                    label="Edit profile"
                  />

                  <div className="my-1 h-px bg-white/[0.07]" />

                  <button
                    type="button"
                    role="menuitem"
                    onClick={async () => {
                      closeAll()
                      await signOut()
                      navigate('/')
                    }}
                    className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-sm text-gray-300 transition hover:bg-white/[0.06] hover:text-white"
                  >
                    <LogOut size={16} className="text-gray-500" />
                    Sign out
                  </button>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="hidden items-center gap-2 sm:flex">
              <Link to="/login" className="btn-ghost px-4 py-2 text-sm">
                Sign in
              </Link>
              <Link to="/register" className="btn-primary btn-sm">
                Join M-Hustle
              </Link>
            </div>
          )}

          <button
            type="button"
            className="icon-btn lg:hidden"
            onClick={() => setMobileOpen((open) => !open)}
            aria-label="Toggle navigation menu"
            aria-expanded={mobileOpen}
          >
            {mobileOpen ? <X size={18} /> : <Menu size={18} />}
          </button>
        </div>
      </div>

      {mobileOpen ? (
        <div className="animate-fade-in border-t border-white/[0.06] bg-ink-900/95 px-4 pb-5 pt-4 backdrop-blur-2xl lg:hidden">
          <form onSubmit={onSearch} className="relative">
            <Search
              size={16}
              className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-500"
            />
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search the marketplace…"
              aria-label="Search listings"
              className="h-11 w-full rounded-2xl border border-white/10 bg-black/30 pl-10 pr-4 text-sm text-white placeholder-gray-500 focus:border-orange-400/50 focus:outline-none"
            />
          </form>

          <nav className="mt-4 grid gap-1">
            {NAV_LINKS.filter((link) => !link.auth || user).map(({ to, label, icon: Icon }) => (
              <Link
                key={to}
                to={to}
                onClick={closeAll}
                className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-gray-300 transition hover:bg-white/[0.06] hover:text-white"
              >
                <Icon size={17} className="text-gray-500" />
                {label}
                {to === '/messages' && unread > 0 ? (
                  <span className="ml-auto rounded-full bg-orange-500/15 px-2 py-0.5 text-[10px] font-semibold text-orange-300">
                    {unread}
                  </span>
                ) : null}
              </Link>
            ))}
            {workspace ? (
              <Link
                to={workspace.to}
                onClick={closeAll}
                className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-gray-300 transition hover:bg-white/[0.06] hover:text-white"
              >
                <span className="text-gray-500">
                  <LayoutDashboard size={17} />
                </span>
                {workspace.label}
              </Link>
            ) : null}
            <Link
              to="/profile"
              onClick={closeAll}
              className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-gray-300 transition hover:bg-white/[0.06] hover:text-white"
            >
              <UserRound size={17} className="text-gray-500" />
              Edit profile
            </Link>
          </nav>

          <div className="mt-4 flex items-center gap-2 border-t border-white/[0.07] pt-4">
            {user ? (
              <button
                type="button"
                onClick={async () => {
                  closeAll()
                  await signOut()
                  navigate('/')
                }}
                className="btn-secondary w-full"
              >
                <LogOut size={16} />
                Sign out
              </button>
            ) : (
              <>
                <Link to="/login" onClick={closeAll} className="btn-secondary flex-1">
                  Sign in
                </Link>
                <Link to="/register" onClick={closeAll} className="btn-primary flex-1">
                  Join M-Hustle
                </Link>
              </>
            )}
          </div>
        </div>
      ) : null}

      {user && profile?.is_suspended ? (
        <div className="border-t border-red-500/20 bg-red-500/10 px-4 py-2 text-center text-xs text-red-200">
          Your account is suspended. Listing, buying and messaging are disabled.
        </div>
      ) : null}
    </header>
  )
}

function MenuLink({ to, icon: Icon, label, onClick, children }) {
  return (
    <Link
      to={to}
      role="menuitem"
      onClick={onClick}
      className="flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-sm text-gray-300 transition hover:bg-white/[0.06] hover:text-white"
    >
      <Icon size={16} className="text-gray-500" />
      {label}
      {children}
    </Link>
  )
}

```

## 3.8 src/components/Footer.jsx

```jsx
import { Link } from 'react-router-dom'
import { ArrowUpRight, Mail, ShieldCheck } from 'lucide-react'
import { Brand } from './Navbar'
import { ORGANISATION, SUPPORT_EMAIL } from '../lib/constants'

export default function Footer() {
  return (
    <footer className="mt-20 border-t border-white/[0.06] bg-ink-950/40">
      <div className="mx-auto grid max-w-7xl gap-10 px-4 py-12 sm:px-6 md:grid-cols-[1.4fr_1fr_1fr] lg:px-8">
        <div>
          <Brand />
          <p className="mt-5 max-w-sm text-sm leading-relaxed text-gray-400">
            The premium campus marketplace built for Maseno University. Buy from verified
            students, sell what you no longer need, and keep every shilling on campus.
          </p>
          <div className="mt-5 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-[11px] text-gray-400">
            <ShieldCheck size={13} className="text-emerald-400" />
            Student-verified sellers · Secure campus handover
          </div>
          <p className="mt-3 text-[10px] uppercase tracking-[0.18em] text-gray-600">
            A product of {ORGANISATION}
          </p>
        </div>

        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-gray-500">
            Marketplace
          </p>
          <ul className="mt-4 space-y-2.5 text-sm">
            <li>
              <Link to="/" className="text-gray-400 transition hover:text-white">
                Browse listings
              </Link>
            </li>
            <li>
              <Link to="/register?role=seller" className="text-gray-400 transition hover:text-white">
                Start selling
              </Link>
            </li>
            <li>
              <Link to="/orders" className="text-gray-400 transition hover:text-white">
                My orders
              </Link>
            </li>
            <li>
              <Link to="/cart" className="text-gray-400 transition hover:text-white">
                Cart
              </Link>
            </li>
          </ul>
        </div>

        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-gray-500">
            Campus desk
          </p>
          <ul className="mt-4 space-y-2.5 text-sm">
            <li className="flex items-center gap-2 text-gray-400">
              <Mail size={14} className="text-gray-600" />
              <a href={`mailto:${SUPPORT_EMAIL}`} className="transition hover:text-white">
                {SUPPORT_EMAIL}
              </a>
            </li>
            <li className="text-gray-500">Maseno University, Kisumu</li>
            <li className="text-gray-500">Mon–Sat · 08:00–20:00 EAT</li>
            <li>
              <a
                href="#top"
                className="inline-flex items-center gap-1 text-orange-300 transition hover:text-orange-200"
              >
                Back to top
                <ArrowUpRight size={13} />
              </a>
            </li>
          </ul>
        </div>
      </div>

      <div className="border-t border-white/[0.06]">
        <div className="mx-auto flex max-w-7xl flex-col gap-2 px-4 py-5 text-[11px] text-gray-500 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
          <p>© {new Date().getFullYear()} M-Hustle. Built by {ORGANISATION} for Maseno University.</p>
          <p className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            All prices in Kenyan Shillings
          </p>
        </div>
      </div>
    </footer>
  )
}

```

## 3.9 src/components/ListingCard.jsx

```jsx
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ImageOff } from 'lucide-react'
import { categoryIcon } from '../lib/constants'
import { cn, formatKES, timeAgo } from '../lib/utils'
import { Avatar, SellerRating } from './ui'
import VerifiedBadge from './VerifiedBadge'

export default function ListingCard({ listing, badge = null, rating = null, className = '' }) {
  const [imageFailed, setImageFailed] = useState(false)
  const Icon = categoryIcon(listing.category)
  const seller = listing.seller
  const plan = badge?.plan

  useEffect(() => {
    setImageFailed(false)
  }, [listing.image_url])

  return (
    <Link
      to={`/product/${listing.id}`}
      className={cn(
        'group glass glass-hover flex flex-col overflow-hidden rounded-3xl',
        className,
      )}
    >
      <div className="relative aspect-[4/3] overflow-hidden bg-ink-800">
        {listing.image_url && !imageFailed ? (
          <img
            src={listing.image_url}
            alt={listing.title}
            loading="lazy"
            onError={() => setImageFailed(true)}
            className="h-full w-full object-cover transition duration-700 ease-out group-hover:scale-[1.045]"
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-[radial-gradient(circle_at_50%_20%,rgba(249,115,22,0.16),transparent_65%)] text-gray-600">
            {imageFailed ? <ImageOff size={28} /> : <Icon size={30} />}
            <span className="text-[10px] uppercase tracking-[0.2em] text-gray-600">
              {listing.category}
            </span>
          </div>
        )}

        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-ink-950/75 via-transparent to-black/10" />

        <div className="absolute left-3 top-3 flex items-center gap-1.5 rounded-full border border-white/10 bg-black/45 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.12em] text-gray-200 backdrop-blur-md">
          <Icon size={11} className="text-orange-300" />
          {listing.category}
        </div>

        {plan ? (
          <div
            className={cn(
              'absolute right-3 top-3 flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.1em] backdrop-blur-md',
              plan === 'pro_max'
                ? 'border-amber-300/30 bg-amber-500/15 text-amber-200'
                : 'border-blue-300/30 bg-blue-500/15 text-blue-200',
            )}
          >
            <VerifiedBadge plan={plan} size={13} />
            {plan === 'pro_max' ? 'Pro Max' : 'Pro'}
          </div>
        ) : null}
      </div>

      <div className="flex flex-1 flex-col p-4">
        <h3 className="line-clamp-2 min-h-[2.6rem] text-[15px] font-semibold leading-snug text-white transition group-hover:text-orange-100">
          {listing.title}
        </h3>

        <p className="mt-2 font-display text-lg font-semibold tracking-tight text-white">
          {formatKES(listing.price)}
        </p>

        <div className="mt-4 flex items-center gap-2 border-t border-white/[0.07] pt-3">
          <Avatar profile={seller} size={22} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs text-gray-400">
              {seller?.full_name || seller?.username || 'M-Hustle seller'}
            </p>
            {rating ? (
              <SellerRating rating={rating} className="mt-0.5" />
            ) : (
              <p className="mt-0.5 text-[10px] text-gray-600">New seller</p>
            )}
          </div>
          {plan ? <VerifiedBadge plan={plan} size={14} /> : null}
        </div>

        <div className="mt-2 flex items-center justify-between gap-2 text-[10px] uppercase tracking-[0.12em] text-gray-600">
          <span>{timeAgo(listing.created_at)}</span>
          <span>
            {Number(listing.quantity) === 0
              ? 'Sold out'
              : `${listing.quantity ?? 1} available`}
          </span>
        </div>
      </div>
    </Link>
  )
}

```

## 3.10 src/components/ui.jsx

```jsx
import { useEffect } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  Info,
  Inbox,
  Loader2,
  Minus,
  Plus,
  Star,
  X,
} from 'lucide-react'
import { cn, initials } from '../lib/utils'

/* ------------------------------------------------------------------ spinner */
export function Spinner({ size = 18, className = '' }) {
  return (
    <Loader2
      size={size}
      className={cn('animate-spin', className)}
      aria-hidden="true"
    />
  )
}

export function PageLoader({ label = 'Loading M-Hustle…' }) {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-6 text-center">
      <span className="grid h-12 w-12 place-items-center rounded-2xl border border-white/10 bg-white/[0.04]">
        <Spinner size={22} className="text-orange-300" />
      </span>
      <p className="text-sm text-gray-400">{label}</p>
    </div>
  )
}

/* -------------------------------------------------------------------- alert */
const ALERT_STYLES = {
  error: {
    wrapper: 'border-red-500/25 bg-red-500/[0.08] text-red-200',
    icon: AlertCircle,
    iconClass: 'text-red-400',
  },
  success: {
    wrapper: 'border-emerald-500/25 bg-emerald-500/[0.08] text-emerald-200',
    icon: CheckCircle2,
    iconClass: 'text-emerald-400',
  },
  info: {
    wrapper: 'border-sky-500/25 bg-sky-500/[0.08] text-sky-200',
    icon: Info,
    iconClass: 'text-sky-400',
  },
  warning: {
    wrapper: 'border-amber-500/25 bg-amber-500/[0.08] text-amber-200',
    icon: AlertCircle,
    iconClass: 'text-amber-400',
  },
}

export function Alert({ variant = 'error', title, children, className, onClose }) {
  const styles = ALERT_STYLES[variant] ?? ALERT_STYLES.error
  const Icon = styles.icon

  return (
    <div
      role="alert"
      className={cn(
        'flex items-start gap-3 rounded-2xl border px-4 py-3.5 text-sm leading-relaxed',
        styles.wrapper,
        className,
      )}
    >
      <Icon size={18} className={cn('mt-0.5 shrink-0', styles.iconClass)} />
      <div className="min-w-0 flex-1">
        {title ? <p className="font-semibold text-white">{title}</p> : null}
        {children ? <div className={title ? 'mt-1 opacity-90' : ''}>{children}</div> : null}
      </div>
      {onClose ? (
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded-full p-1 text-white/60 transition hover:bg-white/10 hover:text-white"
          aria-label="Dismiss message"
        >
          <X size={15} />
        </button>
      ) : null}
    </div>
  )
}

/* --------------------------------------------------------------- empty state */
export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  action,
  className,
}) {
  return (
    <div
      className={cn(
        'glass flex flex-col items-center justify-center rounded-3xl px-6 py-14 text-center',
        className,
      )}
    >
      <span className="grid h-14 w-14 place-items-center rounded-2xl border border-white/10 bg-white/[0.04] text-gray-400">
        <Icon size={24} />
      </span>
      <h3 className="mt-5 text-lg font-semibold text-white">{title}</h3>
      {description ? (
        <p className="mt-2 max-w-md text-sm leading-relaxed text-gray-400">{description}</p>
      ) : null}
      {action ? <div className="mt-6">{action}</div> : null}
    </div>
  )
}

/* ------------------------------------------------------------------- avatar */
export function Avatar({ profile, size = 40, className = '' }) {
  const name = profile?.full_name || profile?.username || 'M-Hustle'
  const dimension = typeof size === 'number' ? `${size}px` : size

  if (profile?.avatar_url) {
    return (
      <img
        src={profile.avatar_url}
        alt={name}
        width={size}
        height={size}
        loading="lazy"
        referrerPolicy="no-referrer"
        className={cn('shrink-0 rounded-full border border-white/10 object-cover', className)}
        style={{ width: dimension, height: dimension }}
      />
    )
  }

  return (
    <span
      className={cn(
        'grid shrink-0 place-items-center rounded-full border border-white/10 bg-gradient-to-br from-orange-500/25 to-pink-500/25 font-display font-semibold text-orange-100',
        className,
      )}
      style={{
        width: dimension,
        height: dimension,
        fontSize: `calc(${dimension} * 0.36)`,
      }}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  )
}

/* -------------------------------------------------------------- status pill */
export function StatusPill({ meta, className }) {
  if (!meta) return null
  return (
    <span className={cn('badge', meta.className, className)}>
      {meta.dot ? <span className={cn('h-1.5 w-1.5 rounded-full', meta.dot)} /> : null}
      {meta.label}
    </span>
  )
}

/* ------------------------------------------------------------------- stats */
export function StatCard({ icon: Icon, label, value, hint, accent = 'orange' }) {
  const accents = {
    orange: 'from-orange-500/20 to-pink-500/10 text-orange-300',
    green: 'from-emerald-500/20 to-teal-500/10 text-emerald-300',
    purple: 'from-purple-500/20 to-blue-500/10 text-purple-300',
    amber: 'from-amber-500/20 to-yellow-500/10 text-amber-300',
  }

  return (
    <div className="card glass-hover p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-gray-500">
            {label}
          </p>
          <p className="mt-2 truncate font-display text-2xl font-semibold text-white">{value}</p>
        </div>
        <span
          className={cn(
            'grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-white/10 bg-gradient-to-br',
            accents[accent] ?? accents.orange,
          )}
        >
          {Icon ? <Icon size={18} /> : null}
        </span>
      </div>
      {hint ? <p className="mt-3 text-xs leading-relaxed text-gray-500">{hint}</p> : null}
    </div>
  )
}

/* ------------------------------------------------------------------- modal */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}) {
  useEffect(() => {
    if (!open) return undefined

    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose?.()
    }

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', onKeyDown)

    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, onClose])

  if (!open) return null

  const sizes = {
    sm: 'max-w-sm',
    md: 'max-w-md',
    lg: 'max-w-lg',
    xl: 'max-w-2xl',
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center px-4 pb-4 sm:items-center sm:pb-0">
      <button
        type="button"
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
        aria-label="Close dialog"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title || 'Dialog'}
        className={cn(
          'glass relative w-full animate-fade-up rounded-3xl p-6 shadow-card sm:p-7',
          sizes[size] ?? sizes.md,
        )}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            {title ? <h3 className="text-lg font-semibold text-white">{title}</h3> : null}
            {description ? (
              <p className="mt-1.5 text-sm leading-relaxed text-gray-400">{description}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1.5 text-gray-500 transition hover:bg-white/10 hover:text-white"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>
        {children ? <div className="mt-5">{children}</div> : null}
        {footer ? <div className="mt-6 flex flex-wrap justify-end gap-2">{footer}</div> : null}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------ section header */
export function SectionHeading({ eyebrow, title, description, action }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="max-w-2xl">
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h2 className="mt-2 text-2xl font-semibold tracking-tight text-white sm:text-3xl">
          {title}
        </h2>
        {description ? (
          <p className="mt-2 text-sm leading-relaxed text-gray-400">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  )
}

/* ---------------------------------------------------------------- quantity */
export function QuantityStepper({ value, onChange, min = 1, max = 99, disabled = false }) {
  const decrement = () => onChange(Math.max(min, value - 1))
  const increment = () => onChange(Math.min(max, value + 1))

  return (
    <div className="inline-flex items-center rounded-full border border-white/10 bg-black/30">
      <button
        type="button"
        onClick={decrement}
        disabled={disabled || value <= min}
        className="grid h-9 w-9 place-items-center rounded-full text-gray-300 transition hover:bg-white/10 hover:text-white disabled:opacity-30"
        aria-label="Decrease quantity"
      >
        <Minus size={14} />
      </button>
      <span className="w-8 text-center text-sm font-semibold tabular-nums text-white">
        {value}
      </span>
      <button
        type="button"
        onClick={increment}
        disabled={disabled || value >= max}
        className="grid h-9 w-9 place-items-center rounded-full text-gray-300 transition hover:bg-white/10 hover:text-white disabled:opacity-30"
        aria-label="Increase quantity"
      >
        <Plus size={14} />
      </button>
    </div>
  )
}

/* ------------------------------------------------------------------ ratings */
export function RatingStars({
  value = 0,
  onChange = null,
  size = 14,
  className = '',
}) {
  const active = Math.round(Number(value) || 0)

  return (
    <div className={cn('inline-flex items-center gap-0.5', className)}>
      {[1, 2, 3, 4, 5].map((star) => {
        const filled = star <= active
        const icon = (
          <Star
            size={size}
            className={filled ? 'text-amber-400' : 'text-gray-700'}
            fill={filled ? 'currentColor' : 'none'}
          />
        )

        if (!onChange) {
          return <span key={star}>{icon}</span>
        }

        return (
          <button
            key={star}
            type="button"
            onClick={() => onChange(star)}
            className="rounded p-0.5 transition hover:scale-110"
            aria-label={`Rate ${star} out of 5`}
          >
            {icon}
          </button>
        )
      })}
    </div>
  )
}

export function SellerRating({ rating, size = 12, className = '' }) {
  if (!rating || !Number(rating.review_count)) return null

  return (
    <span
      className={cn('inline-flex items-center gap-1 text-[11px] text-gray-400', className)}
      title={`${Number(rating.average_rating).toFixed(1)} from ${rating.review_count} review${Number(rating.review_count) === 1 ? '' : 's'}`}
    >
      <Star size={size} className="text-amber-400" fill="currentColor" />
      {Number(rating.average_rating).toFixed(1)}
      <span className="text-gray-600">({rating.review_count})</span>
    </span>
  )
}

```

## 3.11 src/components/ProtectedRoute.jsx

```jsx
import { Navigate, useLocation } from 'react-router-dom'
import { LogOut, RefreshCw, ShieldAlert } from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { PageLoader } from './ui'

/**
 * Route guard. Waits for the session + profile, redirects unauthenticated
 * visitors to /login (remembering where they were going), and enforces roles.
 */
export default function ProtectedRoute({ children, roles }) {
  const { user, profile, loading, profileError, refreshProfile, signOut } = useAuth()
  const location = useLocation()

  if (loading) {
    return <PageLoader label="Checking your session…" />
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />
  }

  if (!profile && profileError) {
    return (
      <div className="mx-auto flex min-h-[60vh] max-w-lg flex-col items-center justify-center px-4 text-center">
        <span className="grid h-14 w-14 place-items-center rounded-2xl border border-amber-400/20 bg-amber-400/10 text-amber-300">
          <ShieldAlert size={26} />
        </span>
        <h1 className="mt-5 text-xl font-semibold text-white">We could not load your profile</h1>
        <p className="mt-2 text-sm leading-relaxed text-gray-400">
          {profileError} This usually means the Supabase schema has not been applied yet, or
          your session needs a refresh.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button type="button" onClick={() => refreshProfile()} className="btn-primary">
            <RefreshCw size={16} />
            Try again
          </button>
          <button type="button" onClick={() => signOut()} className="btn-secondary">
            <LogOut size={16} />
            Sign out
          </button>
        </div>
      </div>
    )
  }

  if (!profile) {
    return <PageLoader label="Preparing your account…" />
  }

  if (roles && !roles.includes(profile.role)) {
    return <Navigate to={profile.role === 'admin' ? '/admin' : '/'} replace />
  }

  return children
}

```

## 3.12 src/components/AuthShell.jsx

```jsx
import { Link } from 'react-router-dom'
import { ArrowLeft, BadgeCheck, ShieldCheck, Smartphone } from 'lucide-react'
import { Brand } from './Navbar'
import { ORGANISATION } from '../lib/constants'

const FEATURES = [
  {
    icon: BadgeCheck,
    title: 'Verified campus sellers',
    body: 'Pro and Pro Max badges separate trusted hustlers from the noise.',
  },
  {
    icon: ShieldCheck,
    title: 'Built on real accounts',
    body: 'Every buyer and seller is backed by a Supabase-authenticated identity.',
  },
  {
    icon: Smartphone,
    title: 'M-Pesa native',
    body: 'Upgrade visibility with a transaction code reviewed by the campus desk.',
  },
]

export default function AuthShell({ title, subtitle, children, footer }) {
  return (
    <div className="mx-auto grid w-full max-w-6xl gap-8 px-4 py-10 sm:px-6 lg:grid-cols-[1.02fr_1fr] lg:items-center lg:gap-12 lg:py-16">
      <aside className="relative hidden overflow-hidden rounded-4xl border border-white/[0.08] bg-[radial-gradient(circle_at_20%_0%,rgba(249,115,22,0.22),transparent_55%),radial-gradient(circle_at_90%_85%,rgba(236,72,153,0.18),transparent_55%)] p-10 lg:block">
        <div className="absolute -right-16 -top-16 h-52 w-52 rounded-full bg-orange-500/10 blur-3xl" />
        <div className="absolute -bottom-20 -left-10 h-56 w-56 rounded-full bg-pink-500/10 blur-3xl" />

        <div className="relative">
          <Brand />

          <p className="eyebrow mt-14">Maseno University · Campus marketplace</p>
          <h1 className="mt-4 max-w-md text-balance font-display text-4xl font-semibold leading-[1.08] tracking-tight text-white">
            Your campus.
            <br />
            <span className="gradient-text">Your hustle.</span>
          </h1>
          <p className="mt-5 max-w-sm text-sm leading-relaxed text-gray-400">
            The premium marketplace for Maseno students. Textbooks, tech, hostel essentials
            and services — all from people you already share a campus with.
          </p>

          <div className="mt-10 space-y-5">
            {FEATURES.map(({ icon: Icon, title: featureTitle, body }) => (
              <div key={featureTitle} className="flex gap-3.5">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-white/10 bg-white/[0.04] text-orange-300">
                  <Icon size={16} />
                </span>
                <div>
                  <p className="text-sm font-medium text-white">{featureTitle}</p>
                  <p className="mt-0.5 text-xs leading-relaxed text-gray-500">{body}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-12 flex items-center gap-2 text-[11px] text-gray-500">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            Live marketplace · real listings, real sellers · built by {ORGANISATION}
          </div>
        </div>
      </aside>

      <section className="glass relative w-full rounded-4xl p-6 shadow-card sm:p-9">
        <div className="mb-7 flex items-center justify-between gap-4 lg:hidden">
          <Brand />
          <Link to="/" className="btn-ghost btn-sm">
            <ArrowLeft size={14} />
            Home
          </Link>
        </div>

        <div>
          <p className="eyebrow">M-Hustle account</p>
          <h2 className="mt-3 text-2xl font-semibold tracking-tight text-white sm:text-3xl">
            {title}
          </h2>
          {subtitle ? (
            <p className="mt-2 text-sm leading-relaxed text-gray-400">{subtitle}</p>
          ) : null}
        </div>

        <div className="mt-7">{children}</div>

        {footer ? <div className="mt-7 border-t border-white/[0.07] pt-6">{footer}</div> : null}
      </section>
    </div>
  )
}

```

## 3.13 src/components/ScrollToTop.jsx

```jsx
import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'

export default function ScrollToTop() {
  const { pathname } = useLocation()

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'auto' })
  }, [pathname])

  return null
}

```

---

# SECTION 4 — Pages

## 4.1 src/pages/Login.jsx

```jsx
import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { ArrowRight, Eye, EyeOff, Lock, UserRound } from 'lucide-react'
import AuthShell from '../components/AuthShell'
import { Alert, Spinner } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import { friendlyError } from '../lib/utils'

function destinationFor(role) {
  if (role === 'admin') return '/admin'
  if (role === 'seller') return '/seller'
  return '/'
}

export default function Login() {
  const { profile, signIn } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()

  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const from = location.state?.from
  const redirectTo = from && from !== '/login' ? from : null

  useEffect(() => {
    if (profile) {
      navigate(redirectTo || destinationFor(profile.role), { replace: true })
    }
  }, [profile, navigate, redirectTo])

  const onSubmit = async (event) => {
    event.preventDefault()
    setError('')

    if (!identifier.trim() || !password) {
      setError('Enter your email or username and password to continue.')
      return
    }

    setSubmitting(true)
    const { error: authError, profile: nextProfile } = await signIn(identifier, password)
    setSubmitting(false)

    if (authError) {
      const message = authError.message || ''
      if (message.toLowerCase().includes('invalid login')) {
        setError('Email, username or password is incorrect. Check both and try again.')
      } else if (message.toLowerCase().includes('email not confirmed')) {
        setError(
          'This account still needs email confirmation. An admin can disable confirmation in Supabase, or confirm the email once.',
        )
      } else if (message.toLowerCase().includes('rate limit')) {
        setError('Too many attempts. Wait a minute, then try again.')
      } else {
        setError(friendlyError(authError, 'We could not sign you in. Please try again.'))
      }
      return
    }

    navigate(redirectTo || destinationFor(nextProfile?.role), { replace: true })
  }

  return (
    <AuthShell
      title="Welcome back"
      subtitle="Sign in with your email or username to pick up your cart, track orders and keep the hustle moving."
      footer={
        <p className="text-center text-sm text-gray-400">
          New to M-Hustle?{' '}
          <Link to="/register" className="link font-medium">
            Create an account
          </Link>
        </p>
      }
    >
      <form onSubmit={onSubmit} className="space-y-5" noValidate>
        {error ? <Alert variant="error">{error}</Alert> : null}

        <div>
          <label htmlFor="identifier" className="label">
            Email or username
          </label>
          <div className="relative">
            <UserRound
              size={16}
              className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-gray-500"
            />
            <input
              id="identifier"
              type="text"
              autoComplete="username"
              value={identifier}
              onChange={(event) => setIdentifier(event.target.value)}
              placeholder="you@maseno.ac.ke or amina_maseno"
              className="input pl-11"
              required
            />
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between">
            <label htmlFor="password" className="label">
              Password
            </label>
            <span className="mb-1.5 text-[11px] text-gray-500">Minimum 8 characters</span>
          </div>
          <div className="relative">
            <Lock
              size={16}
              className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-gray-500"
            />
            <input
              id="password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Enter your password"
              className="input px-11"
              required
            />
            <button
              type="button"
              onClick={() => setShowPassword((visible) => !visible)}
              className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-1.5 text-gray-500 transition hover:bg-white/10 hover:text-white"
              aria-label={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </div>

        <button type="submit" disabled={submitting} className="btn-primary w-full py-3">
          {submitting ? (
            <>
              <Spinner size={16} />
              Signing in…
            </>
          ) : (
            <>
              Sign in
              <ArrowRight size={16} />
            </>
          )}
        </button>

        <p className="text-center text-[11px] leading-relaxed text-gray-500">
          By signing in you agree to the M-Hustle campus trading rules. Meet in public,
          inspect before paying, and keep conversations inside the app.
        </p>
      </form>
    </AuthShell>
  )
}

```

## 4.2 src/pages/Register.jsx

```jsx
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import {
  ArrowRight,
  Check,
  CircleAlert,
  Eye,
  EyeOff,
  Loader2,
  Lock,
  Mail,
  MailCheck,
  Phone,
  ShoppingBag,
  Store,
  UserRound,
} from 'lucide-react'
import AuthShell from '../components/AuthShell'
import { Alert, Spinner } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import { supabase } from '../lib/supabase'
import { cn, friendlyError } from '../lib/utils'

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/

function scorePassword(password) {
  const checks = [
    password.length >= 8,
    /[A-Z]/.test(password),
    /[0-9]/.test(password),
    /[^A-Za-z0-9]/.test(password),
  ]
  return checks.filter(Boolean).length
}

function destinationFor(role) {
  return role === 'seller' ? '/seller' : '/'
}

export default function Register() {
  const { signUp } = useAuth()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  const [form, setForm] = useState({
    fullName: '',
    username: '',
    email: '',
    phone: '',
    password: '',
    confirmPassword: '',
    role: searchParams.get('role') === 'seller' ? 'seller' : 'buyer',
  })
  const [showPassword, setShowPassword] = useState(false)
  const [usernameStatus, setUsernameStatus] = useState({ state: 'idle', message: '' })
  const [accepted, setAccepted] = useState(false)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false)

  const strength = useMemo(() => scorePassword(form.password), [form.password])

  const update = (field) => (event) => {
    const value = event.target.value
    setForm((current) => ({ ...current, [field]: value }))
  }

  useEffect(() => {
    const username = form.username.trim().toLowerCase()

    if (!username) {
      setUsernameStatus({ state: 'idle', message: '' })
      return undefined
    }

    if (!USERNAME_RE.test(username)) {
      setUsernameStatus({
        state: 'invalid',
        message: '3–20 characters: letters, numbers and underscores only.',
      })
      return undefined
    }

    setUsernameStatus({ state: 'checking', message: 'Checking availability…' })
    let cancelled = false

    const timer = setTimeout(async () => {
      const { data, error: rpcError } = await supabase.rpc('is_username_available', {
        p_username: username,
      })

      if (cancelled) return

      if (rpcError) {
        setUsernameStatus({
          state: 'error',
          message: 'Availability check unavailable — you can still try.',
        })
        return
      }

      setUsernameStatus(
        data
          ? { state: 'available', message: 'Username is available.' }
          : { state: 'taken', message: 'That username is already taken.' },
      )
    }, 450)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [form.username])

  const onSubmit = async (event) => {
    event.preventDefault()
    setError('')

    const fullName = form.fullName.trim()
    const username = form.username.trim().toLowerCase()
    const email = form.email.trim()

    if (fullName.length < 2) {
      setError('Enter your full name as it appears on your student ID.')
      return
    }
    if (!USERNAME_RE.test(username)) {
      setError('Choose a username with 3–20 letters, numbers or underscores.')
      return
    }
    if (usernameStatus.state === 'taken') {
      setError('That username is already taken. Try another one.')
      return
    }
    if (usernameStatus.state === 'checking') {
      setError('Give us a second while we check that username.')
      return
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError('Enter a valid email address.')
      return
    }
    if (form.phone.trim() && !/^\+?[0-9]{9,15}$/.test(form.phone.trim())) {
      setError('Enter a valid phone number, for example 0712 345 678.')
      return
    }
    if (form.password.length < 8) {
      setError('Your password must be at least 8 characters long.')
      return
    }
    if (form.password !== form.confirmPassword) {
      setError('The two passwords do not match.')
      return
    }
    if (!accepted) {
      setError('Accept the campus trading rules to continue.')
      return
    }

    setSubmitting(true)
    const { data, error: signUpError } = await signUp({
      email,
      password: form.password,
      fullName,
      username,
      role: form.role,
      phone: form.phone.trim(),
    })
    setSubmitting(false)

    if (signUpError) {
      const message = signUpError.message || ''
      if (message.toLowerCase().includes('already registered')) {
        setError('An account with this email already exists. Sign in instead.')
      } else if (message.toLowerCase().includes('duplicate') && message.includes('username')) {
        setError('That username was just taken. Choose another.')
      } else if (message.toLowerCase().includes('password')) {
        setError('That password does not meet the project security requirements.')
      } else {
        setError(friendlyError(signUpError, 'We could not create your account. Try again.'))
      }
      return
    }

    if (!data?.session) {
      setAwaitingConfirmation(true)
      return
    }

    navigate(destinationFor(form.role), { replace: true })
  }

  if (awaitingConfirmation) {
    return (
      <AuthShell
        title="Check your inbox"
        subtitle="One last step before you enter the marketplace."
        footer={
          <p className="text-center text-sm text-gray-400">
            Already confirmed?{' '}
            <Link to="/login" className="link font-medium">
              Sign in
            </Link>
          </p>
        }
      >
        <div className="rounded-3xl border border-emerald-400/20 bg-emerald-400/[0.06] p-6 text-center">
          <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl border border-emerald-400/25 bg-emerald-400/10 text-emerald-300">
            <MailCheck size={26} />
          </span>
          <h3 className="mt-5 text-lg font-semibold text-white">Confirm {form.email.trim()}</h3>
          <p className="mt-2 text-sm leading-relaxed text-gray-400">
            We sent a confirmation link to your email. Open it, then return here to sign in.
            Check spam if it has not arrived within a few minutes.
          </p>
          <Link to="/login" className="btn-primary mt-6">
            Go to sign in
            <ArrowRight size={16} />
          </Link>
        </div>
      </AuthShell>
    )
  }

  return (
    <AuthShell
      title="Create your account"
      subtitle="Join the marketplace in under a minute. Buy, sell, or do both."
      footer={
        <p className="text-center text-sm text-gray-400">
          Already have an account?{' '}
          <Link to="/login" className="link font-medium">
            Sign in
          </Link>
        </p>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {error ? <Alert variant="error">{error}</Alert> : null}

        <div>
          <span className="label">I am joining as</span>
          <div className="grid grid-cols-2 gap-2.5">
            <RoleOption
              active={form.role === 'buyer'}
              icon={ShoppingBag}
              title="Buyer"
              description="Shop campus deals"
              onClick={() => setForm((current) => ({ ...current, role: 'buyer' }))}
              accent="orange"
            />
            <RoleOption
              active={form.role === 'seller'}
              icon={Store}
              title="Seller"
              description="List and earn"
              onClick={() => setForm((current) => ({ ...current, role: 'seller' }))}
              accent="emerald"
            />
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="fullName" className="label">
              Full name
            </label>
            <div className="relative">
              <UserRound
                size={16}
                className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-gray-500"
              />
              <input
                id="fullName"
                type="text"
                autoComplete="name"
                value={form.fullName}
                onChange={update('fullName')}
                placeholder="Amina Otieno"
                className="input pl-11"
                required
              />
            </div>
          </div>

          <div>
            <label htmlFor="username" className="label">
              Username
            </label>
            <div className="relative">
              <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-sm text-gray-500">
                @
              </span>
              <input
                id="username"
                type="text"
                autoComplete="username"
                value={form.username}
                onChange={update('username')}
                placeholder="amina_maseno"
                className={cn(
                  'input pl-9 pr-10',
                  (usernameStatus.state === 'taken' || usernameStatus.state === 'invalid') &&
                    'input-error',
                )}
                maxLength={20}
                required
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2">
                {usernameStatus.state === 'checking' ? (
                  <Loader2 size={15} className="animate-spin text-gray-500" />
                ) : usernameStatus.state === 'available' ? (
                  <Check size={16} className="text-emerald-400" />
                ) : usernameStatus.state === 'taken' ? (
                  <CircleAlert size={15} className="text-red-400" />
                ) : null}
              </span>
            </div>
            {usernameStatus.message ? (
              <p
                className={cn(
                  'mt-1.5 text-xs',
                  usernameStatus.state === 'available'
                    ? 'text-emerald-400'
                    : usernameStatus.state === 'taken' || usernameStatus.state === 'invalid'
                      ? 'text-red-400'
                      : 'text-gray-500',
                )}
              >
                {usernameStatus.message}
              </p>
            ) : (
              <p className="field-hint">This is how buyers will see you.</p>
            )}
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="email" className="label">
              Email
            </label>
            <div className="relative">
              <Mail
                size={16}
                className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-gray-500"
              />
              <input
                id="email"
                type="email"
                autoComplete="email"
                value={form.email}
                onChange={update('email')}
                placeholder="you@maseno.ac.ke"
                className="input pl-11"
                required
              />
            </div>
          </div>

          <div>
            <label htmlFor="phone" className="label">
              Phone <span className="normal-case tracking-normal text-gray-600">(optional)</span>
            </label>
            <div className="relative">
              <Phone
                size={16}
                className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-gray-500"
              />
              <input
                id="phone"
                type="tel"
                autoComplete="tel"
                value={form.phone}
                onChange={update('phone')}
                placeholder="0712 345 678"
                className="input pl-11"
              />
            </div>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="password" className="label">
              Password
            </label>
            <div className="relative">
              <Lock
                size={16}
                className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-gray-500"
              />
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="new-password"
                value={form.password}
                onChange={update('password')}
                placeholder="At least 8 characters"
                className="input px-11"
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword((visible) => !visible)}
                className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-1.5 text-gray-500 transition hover:bg-white/10 hover:text-white"
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            <div className="mt-2 flex gap-1" aria-hidden="true">
              {[1, 2, 3, 4].map((level) => (
                <span
                  key={level}
                  className={cn(
                    'h-1 flex-1 rounded-full transition',
                    strength >= level
                      ? strength <= 2
                        ? 'bg-orange-400'
                        : 'bg-emerald-400'
                      : 'bg-white/10',
                  )}
                />
              ))}
            </div>
          </div>

          <div>
            <label htmlFor="confirmPassword" className="label">
              Confirm password
            </label>
            <div className="relative">
              <Lock
                size={16}
                className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-gray-500"
              />
              <input
                id="confirmPassword"
                type={showPassword ? 'text' : 'password'}
                autoComplete="new-password"
                value={form.confirmPassword}
                onChange={update('confirmPassword')}
                placeholder="Repeat password"
                className={cn(
                  'input pl-11',
                  form.confirmPassword &&
                    form.confirmPassword !== form.password &&
                    'input-error',
                )}
                required
              />
            </div>
            {form.confirmPassword && form.confirmPassword !== form.password ? (
              <p className="field-error">Passwords do not match.</p>
            ) : (
              <p className="field-hint">Use a mix of letters, numbers and a symbol.</p>
            )}
          </div>
        </div>

        <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
          <input
            type="checkbox"
            checked={accepted}
            onChange={(event) => setAccepted(event.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-white/20 bg-black/40 accent-orange-500"
          />
          <span className="text-xs leading-relaxed text-gray-400">
            I agree to meet in public campus spaces, inspect items before paying, and follow
            the M-Hustle trading rules.
          </span>
        </label>

        <button type="submit" disabled={submitting} className="btn-primary w-full py-3">
          {submitting ? (
            <>
              <Spinner size={16} />
              Creating your account…
            </>
          ) : (
            <>
              Create account
              <ArrowRight size={16} />
            </>
          )}
        </button>
      </form>
    </AuthShell>
  )
}

function RoleOption({ active, icon: Icon, title, description, onClick, accent }) {
  const activeStyles =
    accent === 'emerald'
      ? 'border-emerald-400/45 bg-emerald-400/10'
      : 'border-orange-400/45 bg-orange-400/10'

  const iconStyles =
    accent === 'emerald'
      ? 'text-emerald-300 border-emerald-400/25 bg-emerald-400/10'
      : 'text-orange-300 border-orange-400/25 bg-orange-400/10'

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex items-center gap-3 rounded-2xl border p-3.5 text-left transition',
        active ? activeStyles : 'border-white/10 bg-white/[0.02] hover:border-white/20',
      )}
    >
      <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-xl border', iconStyles)}>
        <Icon size={16} />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-white">{title}</span>
        <span className="block truncate text-[11px] text-gray-500">{description}</span>
      </span>
    </button>
  )
}

```

## 4.3 src/pages/Home.jsx

```jsx
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  ArrowRight,
  BadgeCheck,
  ChevronRight,
  MapPin,
  RefreshCw,
  Search,
  ShieldCheck,
  ShoppingBag,
  Smartphone,
  Store,
  X,
} from 'lucide-react'
import ListingCard from '../components/ListingCard'
import VerifiedBadge from '../components/VerifiedBadge'
import { Alert, EmptyState, Spinner } from '../components/ui'
import { CATEGORIES } from '../lib/constants'
import { supabase } from '../lib/supabase'
import { cn, formatKES, sortListingsByPriority, timeAgo } from '../lib/utils'
import { useAuth } from '../hooks/useAuth'

const PAGE_SIZE = 24

const LISTING_SELECT = `
  id, title, description, price, category, image_url, quantity, status, created_at, seller_id,
  seller:profiles!listings_seller_id_fkey(id, username, full_name, role, avatar_url)
`

export default function Home() {
  const { user, isSeller, isAdmin } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()

  const q = searchParams.get('q')?.trim() ?? ''
  const category = searchParams.get('category') ?? 'All'

  const [searchInput, setSearchInput] = useState(q)
  const [listings, setListings] = useState([])
  const [badges, setBadges] = useState({})
  const [ratings, setRatings] = useState({})
  const [total, setTotal] = useState(0)
  const [sellerCount, setSellerCount] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')

  const requestRef = useRef(0)
  const badgesRef = useRef({})
  const ratingsRef = useRef({})

  useEffect(() => {
    setSearchInput(q)
  }, [q])

  useEffect(() => {
    let active = true

    const loadSellerCount = async () => {
      const { count } = await supabase
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .eq('role', 'seller')
        .eq('is_suspended', false)

      if (active) setSellerCount(count ?? 0)
    }

    void loadSellerCount()
    return () => {
      active = false
    }
  }, [])

  const fetchFeed = useCallback(
    async ({ append = false, offset = 0 } = {}) => {
      const requestId = requestRef.current + 1
      requestRef.current = requestId

      if (append) setLoadingMore(true)
      else setLoading(true)
      setError('')

      let query = supabase
        .from('listings')
        .select(LISTING_SELECT, { count: 'exact' })
        .eq('status', 'active')

      const term = q.replace(/[%,()]/g, ' ').replace(/\s+/g, ' ').trim()
      if (term) {
        query = query.or(`title.ilike.%${term}%,description.ilike.%${term}%`)
      }
      if (category !== 'All') {
        query = query.eq('category', category)
      }

      const [feedResult, badgeResult, ratingResult] = await Promise.all([
        query.order('created_at', { ascending: false }).range(offset, offset + PAGE_SIZE - 1),
        supabase.rpc('get_seller_badges'),
        supabase.rpc('get_seller_ratings'),
      ])

      if (requestRef.current !== requestId) return

      if (feedResult.error) {
        setError(feedResult.error.message)
        if (!append) setListings([])
        setLoading(false)
        setLoadingMore(false)
        return
      }

      const badgeMap = {}
      for (const row of badgeResult.data ?? []) {
        badgeMap[row.seller_id] = row
      }

      const nextBadges = append ? { ...badgesRef.current, ...badgeMap } : badgeMap
      badgesRef.current = nextBadges
      setBadges(nextBadges)

      const ratingMap = {}
      for (const row of ratingResult.data ?? []) {
        ratingMap[row.seller_id] = row
      }
      const nextRatings = append ? { ...ratingsRef.current, ...ratingMap } : ratingMap
      ratingsRef.current = nextRatings
      setRatings(nextRatings)

      const rows = feedResult.data ?? []
      setListings((current) => {
        const base = append ? current : []
        const seen = new Set(base.map((item) => item.id))
        const merged = [...base, ...rows.filter((item) => !seen.has(item.id))]
        return sortListingsByPriority(merged, nextBadges, nextRatings)
      })
      setTotal(feedResult.count ?? rows.length)
      setLoading(false)
      setLoadingMore(false)
    },
    [q, category],
  )

  useEffect(() => {
    void fetchFeed()
  }, [fetchFeed])

  const updateParams = (nextQuery, nextCategory) => {
    const params = new URLSearchParams(searchParams)
    if (nextQuery?.trim()) params.set('q', nextQuery.trim())
    else params.delete('q')

    if (nextCategory && nextCategory !== 'All') params.set('category', nextCategory)
    else params.delete('category')

    setSearchParams(params, { replace: true })
  }

  const onSearch = (event) => {
    event.preventDefault()
    updateParams(searchInput, category)
  }

  const clearFilters = () => {
    setSearchInput('')
    setSearchParams({}, { replace: true })
  }

  const featured = listings[0] ?? null
  const hasFilters = Boolean(q) || category !== 'All'

  return (
    <div className="pb-8">
      {/* ------------------------------------------------------------- hero */}
      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(249,115,22,0.09),transparent_55%)]" />
        <div className="relative mx-auto grid max-w-7xl gap-10 px-4 pb-14 pt-12 sm:px-6 sm:pt-16 lg:grid-cols-[1.08fr_0.92fr] lg:items-center lg:gap-14 lg:px-8 lg:pb-20 lg:pt-20">
          <div className="animate-fade-up">
            <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-[11px] text-gray-300">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
              </span>
              Maseno University · campus marketplace
            </div>

            <h1 className="mt-6 text-balance font-display text-4xl font-semibold leading-[1.04] tracking-tight text-white sm:text-5xl lg:text-6xl">
              The campus marketplace,
              <br />
              <span className="gradient-text">properly done.</span>
            </h1>

            <p className="mt-6 max-w-xl text-pretty text-sm leading-relaxed text-gray-400 sm:text-base">
              Textbooks, tech, hostel essentials, food and services from verified Maseno
              students. Fair prices in KES, real sellers, and a handover that happens right
              on campus.
            </p>

            <form onSubmit={onSearch} className="mt-8 max-w-xl">
              <div className="group flex items-center gap-2 rounded-2xl border border-white/10 bg-black/30 p-1.5 backdrop-blur-xl transition focus-within:border-orange-400/50 focus-within:ring-2 focus-within:ring-orange-500/10">
                <Search size={18} className="ml-3 shrink-0 text-gray-500" />
                <input
                  type="search"
                  value={searchInput}
                  onChange={(event) => setSearchInput(event.target.value)}
                  placeholder="What are you looking for today?"
                  aria-label="Search listings"
                  className="h-11 min-w-0 flex-1 bg-transparent px-1 text-sm text-white placeholder-gray-500 focus:outline-none"
                />
                {searchInput ? (
                  <button
                    type="button"
                    onClick={() => {
                      setSearchInput('')
                      updateParams('', category)
                    }}
                    className="rounded-full p-2 text-gray-500 transition hover:bg-white/10 hover:text-white"
                    aria-label="Clear search"
                  >
                    <X size={15} />
                  </button>
                ) : null}
                <button type="submit" className="btn-primary h-11 shrink-0 px-5">
                  Search
                </button>
              </div>
            </form>

            <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3 text-xs text-gray-500">
              <span className="inline-flex items-center gap-1.5">
                <BadgeCheck size={14} className="text-blue-400" />
                Verified Pro sellers
              </span>
              <span className="inline-flex items-center gap-1.5">
                <ShieldCheck size={14} className="text-emerald-400" />
                Student-verified accounts
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Smartphone size={14} className="text-orange-300" />
                M-Pesa upgrades
              </span>
            </div>

            <div className="mt-10 flex flex-wrap gap-3">
              <a href="#feed" className="btn-primary">
                Explore the feed
                <ArrowRight size={16} />
              </a>
              {isSeller ? (
                <Link to="/seller?tab=new" className="btn-secondary">
                  <Store size={16} />
                  List an item
                </Link>
              ) : isAdmin ? null : user ? (
                <Link to="/orders" className="btn-secondary">
                  <ShoppingBag size={16} />
                  View my orders
                </Link>
              ) : (
                <Link to="/register?role=seller" className="btn-secondary">
                  <ShoppingBag size={16} />
                  Become a seller
                </Link>
              )}
            </div>
          </div>

          {/* editorial featured card */}
          <div className="relative mx-auto w-full max-w-[430px] animate-fade-up lg:max-w-none">
            <div className="pointer-events-none absolute -inset-8 rounded-[3rem] bg-gradient-to-br from-orange-500/20 via-pink-500/10 to-transparent blur-3xl" />

            <div className="glass relative rounded-4xl p-3 shadow-card">
              <div className="flex items-center justify-between px-2 pb-2.5 pt-1">
                <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-gray-500">
                  <span className="h-1.5 w-1.5 rounded-full bg-orange-400" />
                  From the feed
                </span>
                <span className="text-[10px] uppercase tracking-[0.14em] text-gray-600">
                  {total > 0 ? `${total} live listings` : 'Fresh finds'}
                </span>
              </div>

              {loading && !featured ? (
                <div className="space-y-3">
                  <div className="skeleton aspect-[4/3] w-full rounded-3xl" />
                  <div className="skeleton h-4 w-2/3" />
                  <div className="skeleton h-5 w-1/3" />
                </div>
              ) : featured ? (
                <Link
                  to={`/product/${featured.id}`}
                  className="group block overflow-hidden rounded-3xl border border-white/[0.06] bg-ink-800"
                >
                  <div className="relative aspect-[4/3] overflow-hidden">
                    {featured.image_url ? (
                      <img
                        src={featured.image_url}
                        alt={featured.title}
                        className="h-full w-full object-cover transition duration-700 group-hover:scale-[1.04]"
                      />
                    ) : (
                      <div className="grid h-full w-full place-items-center bg-[radial-gradient(circle_at_50%_30%,rgba(249,115,22,0.2),transparent_65%)]">
                        <ShoppingBag size={36} className="text-orange-300/60" />
                      </div>
                    )}
                    <div className="absolute inset-0 bg-gradient-to-t from-ink-950/80 via-transparent to-transparent" />
                    <span className="absolute left-3 top-3 rounded-full border border-white/10 bg-black/40 px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] text-gray-200 backdrop-blur-md">
                      {featured.category}
                    </span>
                    {badges[featured.seller_id]?.plan ? (
                      <span className="absolute right-3 top-3 flex items-center gap-1.5 rounded-full border border-white/15 bg-black/40 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-white backdrop-blur-md">
                        <VerifiedBadge plan={badges[featured.seller_id].plan} size={13} />
                        {badges[featured.seller_id].plan === 'pro_max' ? 'Pro Max' : 'Pro'}
                      </span>
                    ) : null}
                    <div className="absolute bottom-3 left-3 right-3 flex items-end justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-white">{featured.title}</p>
                        <p className="mt-1 text-[10px] uppercase tracking-[0.14em] text-gray-400">
                          {featured.seller?.full_name || featured.seller?.username || 'Campus seller'}
                        </p>
                      </div>
                      <span className="shrink-0 rounded-full bg-white px-3 py-1 text-xs font-bold text-ink-950">
                        {formatKES(featured.price)}
                      </span>
                    </div>
                  </div>
                </Link>
              ) : (
                <div className="grid aspect-[4/3] place-items-center rounded-3xl border border-dashed border-white/10 bg-white/[0.02] px-8 text-center">
                  <div>
                    <ShoppingBag size={30} className="mx-auto text-gray-600" />
                    <p className="mt-3 text-sm font-medium text-white">No listings yet</p>
                    <p className="mt-1 text-xs leading-relaxed text-gray-500">
                      Be the first seller to put something on the feed.
                    </p>
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between gap-3 px-2 pb-1 pt-3.5">
                <div className="flex items-center gap-1.5 text-[11px] text-gray-500">
                  <MapPin size={12} className="text-orange-300" />
                  Campus handover
                </div>
                <span className="inline-flex items-center gap-1 text-[11px] text-gray-500">
                  {featured ? timeAgo(featured.created_at) : 'Updated in real time'}
                </span>
              </div>
            </div>

            <div className="glass absolute -left-3 bottom-20 hidden rounded-2xl px-3.5 py-2.5 shadow-card sm:block">
              <div className="flex items-center gap-2">
                <span className="grid h-8 w-8 place-items-center rounded-xl border border-blue-400/20 bg-blue-400/10 text-blue-300">
                  <BadgeCheck size={15} />
                </span>
                <div>
                  <p className="text-[11px] font-semibold text-white">Verified sellers</p>
                  <p className="text-[10px] text-gray-500">Blue and gold badges</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------- feed */}
      <section id="feed" className="mx-auto max-w-7xl scroll-mt-24 px-4 sm:px-6 lg:px-8">
        <div className="glass-soft rounded-4xl border border-white/[0.06] px-4 py-6 sm:px-6">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="eyebrow">Browse the marketplace</p>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight text-white sm:text-3xl">
                {q ? (
                  <>
                    Results for <span className="gradient-text">“{q}”</span>
                  </>
                ) : (
                  'Fresh on campus'
                )}
              </h2>
              <p className="mt-1.5 text-sm text-gray-500">
                {loading
                  ? 'Loading listings…'
                  : `${total} listing${total === 1 ? '' : 's'}${
                      category !== 'All' ? ` in ${category}` : ''
                    }`}
                {sellerCount !== null ? ` · ${sellerCount} sellers` : ''}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void fetchFeed()}
                disabled={loading}
                className="btn-secondary btn-sm"
              >
                <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
                Refresh
              </button>
              {hasFilters ? (
                <button type="button" onClick={clearFilters} className="btn-ghost btn-sm">
                  <X size={13} />
                  Clear filters
                </button>
              ) : null}
            </div>
          </div>

          <div className="no-scrollbar mt-6 flex gap-2 overflow-x-auto pb-1">
            <button
              type="button"
              onClick={() => updateParams(q, 'All')}
              className={cn('chip shrink-0', category === 'All' && 'chip-active')}
            >
              All items
            </button>
            {CATEGORIES.map(({ value, icon: Icon }) => (
              <button
                key={value}
                type="button"
                onClick={() => updateParams(q, value)}
                className={cn('chip shrink-0', category === value && 'chip-active')}
              >
                <Icon size={13} />
                {value}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-8">
          {error ? (
            <Alert variant="error" title="The feed could not load">
              {error}
              <button
                type="button"
                onClick={() => void fetchFeed()}
                className="btn-secondary btn-sm mt-3"
              >
                <RefreshCw size={13} />
                Try again
              </button>
            </Alert>
          ) : loading && listings.length === 0 ? (
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {Array.from({ length: 8 }).map((_, index) => (
                <div key={index} className="glass overflow-hidden rounded-3xl">
                  <div className="skeleton aspect-[4/3] rounded-none" />
                  <div className="space-y-3 p-4">
                    <div className="skeleton h-4 w-5/6" />
                    <div className="skeleton h-5 w-1/3" />
                    <div className="flex items-center gap-2 pt-2">
                      <div className="skeleton h-6 w-6 rounded-full" />
                      <div className="skeleton h-3 w-1/2" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : listings.length === 0 ? (
            <EmptyState
              icon={Search}
              title={q ? 'No matches on campus yet' : 'The feed is waiting for its first listing'}
              description={
                q
                  ? 'Try a broader search, remove the category filter, or check back soon — new items land every day.'
                  : 'Everything here comes from real Maseno sellers. If you have something to sell, create the first listing.'
              }
              action={
                hasFilters ? (
                  <button type="button" onClick={clearFilters} className="btn-primary">
                    Clear filters
                  </button>
                ) : (
                  <Link to="/register?role=seller" className="btn-primary">
                    <Store size={16} />
                    Start selling
                  </Link>
                )
              }
            />
          ) : (
            <>
              <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {listings.map((listing) => (
                  <ListingCard
                    key={listing.id}
                    listing={listing}
                    badge={badges[listing.seller_id] ?? null}
                    rating={ratings[listing.seller_id] ?? null}
                  />
                ))}
              </div>

              <div className="mt-10 flex flex-col items-center gap-3">
                {listings.length < total ? (
                  <button
                    type="button"
                    onClick={() => void fetchFeed({ append: true, offset: listings.length })}
                    disabled={loadingMore}
                    className="btn-secondary"
                  >
                    {loadingMore ? (
                      <>
                        <Spinner size={15} />
                        Loading more…
                      </>
                    ) : (
                      <>
                        Load more listings
                        <ChevronRight size={15} />
                      </>
                    )}
                  </button>
                ) : (
                  <p className="text-xs text-gray-600">
                    You have reached the end of the feed.
                  </p>
                )}
                <p className="text-[10px] uppercase tracking-[0.14em] text-gray-700">
                  Pro Max listings appear first · then Pro · then newest
                </p>
              </div>
            </>
          )}
        </div>
      </section>

      {/* --------------------------------------------------------- seller CTA */}
      {!user || isSeller ? (
        <section className="mx-auto mt-16 max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="relative overflow-hidden rounded-4xl border border-white/[0.08] bg-[radial-gradient(circle_at_15%_10%,rgba(249,115,22,0.16),transparent_50%),radial-gradient(circle_at_90%_90%,rgba(236,72,153,0.13),transparent_55%)] p-8 sm:p-10">
            <div className="relative flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
              <div className="max-w-xl">
                <p className="eyebrow">For student hustlers</p>
                <h2 className="mt-2 text-2xl font-semibold tracking-tight text-white sm:text-3xl">
                  Turn what you know into income.
                </h2>
                <p className="mt-2 text-sm leading-relaxed text-gray-400">
                  List in minutes, chat directly with buyers, and upgrade to Pro or Pro Max for
                  a verified badge and top placement in the feed.
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                {isSeller ? (
                  <Link to="/seller?tab=new" className="btn-primary">
                    Open seller studio
                    <ArrowRight size={16} />
                  </Link>
                ) : (
                  <Link to="/register?role=seller" className="btn-primary">
                    Open a seller account
                    <ArrowRight size={16} />
                  </Link>
                )}
                <Link
                  to={isSeller ? '/seller?tab=subscription' : '/register?role=seller'}
                  className="btn-secondary"
                >
                  <BadgeCheck size={16} />
                  See plans
                </Link>
              </div>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  )
}

```

## 4.4 src/pages/ProductDetail.jsx

```jsx
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Clock3,
  ImageOff,
  MapPin,
  MessageSquare,
  RefreshCw,
  Share2,
  ShieldCheck,
  ShoppingBag,
  Store,
  Tag,
} from 'lucide-react'
import ListingCard from '../components/ListingCard'
import VerifiedBadge from '../components/VerifiedBadge'
import { Alert, Avatar, EmptyState, PageLoader, QuantityStepper, SellerRating } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import { useCart } from '../context/CartContext'
import { supabase } from '../lib/supabase'
import {
  categoryIcon,
} from '../lib/constants'
import { formatDate, formatKES, timeAgo, cn } from '../lib/utils'

const DETAIL_SELECT = `
  id, title, description, price, category, image_url, quantity, status, created_at, seller_id,
  seller:profiles!listings_seller_id_fkey(id, username, full_name, role, avatar_url, location, created_at)
`

export default function ProductDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { user, profile, isSuspended } = useAuth()
  const { addItem } = useCart()

  const [listing, setListing] = useState(null)
  const [badge, setBadge] = useState(null)
  const [rating, setRating] = useState(null)
  const [ratings, setRatings] = useState({})
  const [related, setRelated] = useState([])
  const [quantity, setQuantity] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notFound, setNotFound] = useState(false)
  const [added, setAdded] = useState(false)
  const [copied, setCopied] = useState(false)
  const [imageFailed, setImageFailed] = useState(false)

  const addedTimer = useRef(null)
  const copiedTimer = useRef(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    setNotFound(false)
    setImageFailed(false)

    const { data, error: fetchError } = await supabase
      .from('listings')
      .select(DETAIL_SELECT)
      .eq('id', id)
      .maybeSingle()

    if (fetchError) {
      setError(fetchError.message)
      setLoading(false)
      return
    }

    if (!data) {
      setNotFound(true)
      setLoading(false)
      return
    }

    setListing(data)
    setQuantity(1)

    const [badgeResult, ratingResult, relatedResult] = await Promise.all([
      supabase.rpc('get_seller_badges'),
      supabase.rpc('get_seller_ratings'),
      supabase
        .from('listings')
        .select(
          'id, title, price, category, image_url, quantity, created_at, status, seller_id, seller:profiles!listings_seller_id_fkey(id, username, full_name, avatar_url)',
        )
        .eq('status', 'active')
        .eq('category', data.category)
        .neq('id', data.id)
        .order('created_at', { ascending: false })
        .limit(4),
    ])

    const badgeRows = badgeResult.data ?? []
    setBadge(badgeRows.find((row) => row.seller_id === data.seller_id) ?? null)

    const ratingMap = {}
    for (const row of ratingResult.data ?? []) ratingMap[row.seller_id] = row
    setRatings(ratingMap)
    setRating(ratingMap[data.seller_id] ?? null)

    setRelated(relatedResult.data ?? [])
    setLoading(false)
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    return () => {
      if (addedTimer.current) clearTimeout(addedTimer.current)
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
    }
  }, [])

  if (loading) {
    return <PageLoader label="Opening this listing…" />
  }

  if (notFound) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-20">
        <EmptyState
          icon={ShoppingBag}
          title="This listing is not available"
          description="It may have been sold, removed by the seller, or the link is incorrect. The rest of the campus feed is still open."
          action={
            <Link to="/" className="btn-primary">
              <ArrowLeft size={16} />
              Back to marketplace
            </Link>
          }
        />
      </div>
    )
  }

  if (error || !listing) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-20">
        <Alert variant="error" title="Could not load this listing">
          {error}
          <button type="button" onClick={() => void load()} className="btn-secondary btn-sm mt-3">
            <RefreshCw size={13} />
            Try again
          </button>
        </Alert>
      </div>
    )
  }

  const seller = listing.seller
  const isOwner = user?.id === listing.seller_id
  const stock = Math.max(0, Number(listing.quantity ?? 1))
  const isSold = listing.status !== 'active' || stock <= 0
  const Icon = categoryIcon(listing.category)
  const canBuy = !isSold && !isOwner && !isSuspended

  const flashAdded = () => {
    setAdded(true)
    if (addedTimer.current) clearTimeout(addedTimer.current)
    addedTimer.current = setTimeout(() => setAdded(false), 2200)
  }

  const onAddToCart = () => {
    if (!canBuy) return
    addItem(listing, quantity, seller?.full_name || seller?.username)
    flashAdded()
  }

  const onBuyNow = () => {
    if (!canBuy) return
    addItem(listing, quantity, seller?.full_name || seller?.username)
    if (!user) {
      navigate('/login', { state: { from: '/checkout' } })
      return
    }
    navigate('/checkout')
  }

  const onChat = () => {
    if (!user) {
      navigate('/login', {
        state: { from: `/messages?user=${listing.seller_id}&listing=${listing.id}` },
      })
      return
    }
    navigate(`/messages?user=${listing.seller_id}&listing=${listing.id}`)
  }

  const onShare = async () => {
    const url = window.location.href
    try {
      if (navigator.share) {
        await navigator.share({ title: listing.title, text: `Available on M-Hustle: ${listing.title}`, url })
        return
      }
      await navigator.clipboard.writeText(url)
      setCopied(true)
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopied(false), 2000)
    } catch {
      // User dismissed the share sheet — nothing to do.
    }
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <nav className="flex flex-wrap items-center gap-1.5 text-xs text-gray-500">
        <Link to="/" className="transition hover:text-white">
          Marketplace
        </Link>
        <ChevronRight size={12} />
        <Link
          to={`/?category=${encodeURIComponent(listing.category)}`}
          className="transition hover:text-white"
        >
          {listing.category}
        </Link>
        <ChevronRight size={12} />
        <span className="max-w-[220px] truncate text-gray-400">{listing.title}</span>
      </nav>

      <div className="mt-6 grid gap-8 lg:grid-cols-[1.05fr_0.95fr] lg:gap-12">
        {/* ---------------------------------------------------------- media */}
        <div>
          <div className="glass relative overflow-hidden rounded-4xl p-2.5">
            <div className="relative aspect-[4/3] overflow-hidden rounded-3xl bg-ink-800">
              {listing.image_url && !imageFailed ? (
                <img
                  src={listing.image_url}
                  alt={listing.title}
                  onError={() => setImageFailed(true)}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-[radial-gradient(circle_at_50%_30%,rgba(249,115,22,0.18),transparent_65%)] text-gray-600">
                  {imageFailed ? <ImageOff size={40} /> : <Icon size={44} />}
                  <span className="text-[10px] uppercase tracking-[0.2em]">
                    {listing.category}
                  </span>
                </div>
              )}

              {isSold ? (
                <div className="absolute inset-0 flex items-center justify-center bg-ink-950/70 backdrop-blur-[2px]">
                  <span className="rounded-full border border-white/15 bg-black/60 px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-white">
                    No longer available
                  </span>
                </div>
              ) : null}
            </div>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <TrustItem icon={ShieldCheck} title="Campus handover" body="Meet in a public place" />
            <TrustItem icon={MessageSquare} title="Chat first" body="Ask every question" />
            <TrustItem icon={Tag} title="Fair pricing" body="Listed in KES" />
          </div>
        </div>

        {/* --------------------------------------------------------- details */}
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              to={`/?category=${encodeURIComponent(listing.category)}`}
              className="badge border-orange-400/25 bg-orange-400/10 text-orange-200"
            >
              <Icon size={12} />
              {listing.category}
            </Link>
            <span className="text-[11px] text-gray-500">
              {isSold ? 'Listing closed' : `Listed ${timeAgo(listing.created_at)}`}
            </span>
          </div>

          <h1 className="mt-4 text-balance font-display text-3xl font-semibold leading-tight tracking-tight text-white sm:text-4xl">
            {listing.title}
          </h1>

          <div className="mt-4 flex flex-wrap items-baseline gap-3">
            <p className="font-display text-3xl font-semibold tracking-tight text-white">
              {formatKES(listing.price)}
            </p>
            <span className="text-xs text-gray-500">Price is fixed by the seller</span>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span
              className={cn(
                'badge',
                stock > 0
                  ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-300'
                  : 'border-red-400/20 bg-red-400/10 text-red-300',
              )}
            >
              {stock > 0 ? `${stock} in stock` : 'Sold out'}
            </span>
            {stock > 0 && stock <= 3 ? (
              <span className="text-[11px] text-amber-300">Only a few left</span>
            ) : null}
          </div>

          {isSold ? (
            <Alert variant="warning" className="mt-5">
              {stock <= 0
                ? 'This item is sold out. Browse the related listings below for something similar.'
                : 'This item has been sold or removed. Browse the related listings below for something similar.'}
            </Alert>
          ) : null}

          <div className="mt-6 border-y border-white/[0.07] py-5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-500">
              About this item
            </p>
            <p className="mt-3 whitespace-pre-line text-sm leading-relaxed text-gray-300">
              {listing.description?.trim() || 'The seller has not added a description yet.'}
            </p>
          </div>

          {canBuy ? (
            <div className="mt-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="text-xs font-medium uppercase tracking-[0.14em] text-gray-500">
                  Quantity
                </span>
                <QuantityStepper
                  value={quantity}
                  onChange={setQuantity}
                  max={Math.min(99, stock)}
                />
              </div>

              <div className="mt-4 grid gap-2.5 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={onAddToCart}
                  className={cn('btn-secondary py-3', added && 'border-emerald-400/40 text-emerald-300')}
                >
                  {added ? (
                    <>
                      <Check size={16} />
                      Added to cart
                    </>
                  ) : (
                    <>
                      <ShoppingBag size={16} />
                      Add to cart
                    </>
                  )}
                </button>
                <button type="button" onClick={onBuyNow} className="btn-primary py-3">
                  Buy now
                  <ChevronRight size={16} />
                </button>
              </div>

              <button type="button" onClick={onChat} className="btn-ghost mt-2 w-full py-3">
                <MessageSquare size={16} />
                Chat with seller
              </button>
            </div>
          ) : null}

          {isOwner ? (
            <div className="mt-6 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
              <p className="text-sm font-medium text-white">This is your listing</p>
              <p className="mt-1 text-xs leading-relaxed text-gray-400">
                Manage price, status and incoming offers from your seller studio.
              </p>
              <Link to="/seller?tab=listings" className="btn-secondary btn-sm mt-3">
                <Store size={14} />
                Manage listing
              </Link>
            </div>
          ) : null}

          {isSuspended ? (
            <Alert variant="warning" className="mt-6">
              Your account is suspended, so buying and messaging are disabled.
            </Alert>
          ) : null}

          {/* ------------------------------------------------------- seller */}
          <div className="mt-7 rounded-3xl border border-white/[0.08] bg-white/[0.025] p-5">
            <div className="flex items-start gap-3.5">
              <Avatar profile={seller} size={48} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <p className="truncate text-sm font-semibold text-white">
                    {seller?.full_name || seller?.username || 'Campus seller'}
                  </p>
                  {badge ? <VerifiedBadge plan={badge.plan} size={17} /> : null}
                </div>
                <p className="mt-0.5 text-xs text-gray-500">
                  @{seller?.username || 'seller'}
                  {badge
                    ? ` · ${badge.plan === 'pro_max' ? 'Pro Max' : 'Pro'} seller`
                    : ' · Campus seller'}
                </p>
                {rating ? <SellerRating rating={rating} className="mt-1.5" size={13} /> : null}
                <p className="mt-2 flex items-center gap-1.5 text-[11px] text-gray-500">
                  <Clock3 size={12} className="text-gray-600" />
                  Joined {formatDate(seller?.created_at)}
                </p>
                {seller?.location ? (
                  <p className="mt-1 flex items-center gap-1.5 text-[11px] text-gray-500">
                    <MapPin size={12} className="text-orange-300" />
                    Based in {seller.location}
                  </p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={onShare}
                className="icon-btn shrink-0"
                aria-label="Share listing"
              >
                {copied ? <Check size={17} className="text-emerald-400" /> : <Share2 size={17} />}
              </button>
            </div>

            {seller && !isOwner ? (
              <button type="button" onClick={onChat} className="btn-secondary mt-4 w-full">
                <MessageSquare size={15} />
                Message {seller.full_name?.split(' ')[0] || seller.username}
              </button>
            ) : null}
          </div>

          <div className="mt-4 flex items-start gap-2.5 rounded-2xl border border-amber-400/15 bg-amber-400/[0.05] p-4">
            <MapPin size={16} className="mt-0.5 shrink-0 text-amber-300" />
            <p className="text-[11px] leading-relaxed text-amber-100/80">
              <span className="font-semibold text-amber-200">Stay safe on campus.</span> Meet
              in a busy public area, inspect the item before paying, and never send money to
              someone you have not met.
            </p>
          </div>
        </div>
      </div>

      {/* --------------------------------------------------------- related */}
      {related.length > 0 ? (
        <section className="mt-16">
          <div className="flex items-end justify-between gap-4">
            <div>
              <p className="eyebrow">Keep browsing</p>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight text-white">
                More in {listing.category}
              </h2>
            </div>
            <Link
              to={`/?category=${encodeURIComponent(listing.category)}`}
              className="hidden text-xs font-medium text-orange-300 transition hover:text-orange-200 sm:inline-flex sm:items-center sm:gap-1"
            >
              View all
              <ChevronRight size={13} />
            </Link>
          </div>

          <div className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {related.map((item) => (
              <ListingCard
                key={item.id}
                listing={item}
                rating={ratings[item.seller_id] ?? null}
              />
            ))}
          </div>
        </section>
      ) : (
        <div className="mt-16 rounded-3xl border border-white/[0.07] bg-white/[0.02] p-5 text-center">
          <p className="text-xs text-gray-500">
            No other {listing.category} listings right now.{' '}
            <Link to="/" className="link">
              Browse the full feed
            </Link>
            .
          </p>
        </div>
      )}
    </div>
  )
}

function TrustItem({ icon: Icon, title, body }) {
  return (
    <div className="flex items-start gap-2 rounded-2xl border border-white/[0.07] bg-white/[0.02] px-3 py-2.5">
      <Icon size={15} className="mt-0.5 shrink-0 text-orange-300" />
      <div>
        <p className="text-[11px] font-medium text-white">{title}</p>
        <p className="text-[10px] text-gray-500">{body}</p>
      </div>
    </div>
  )
}

```

## 4.5 src/pages/Cart.jsx

```jsx
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  ArrowRight,
  ArrowLeft,
  ShieldCheck,
  ShoppingBag,
  Store,
  Trash2,
  MapPin,
} from 'lucide-react'
import { useCart } from '../context/CartContext'
import { useAuth } from '../hooks/useAuth'
import { Alert, EmptyState, Modal, QuantityStepper } from '../components/ui'
import { formatKES, groupBySeller } from '../lib/utils'

export default function Cart() {
  const { items, count, subtotal, setQuantity, removeItem, clearCart } = useCart()
  const { user, isSuspended } = useAuth()
  const navigate = useNavigate()

  const [confirmClear, setConfirmClear] = useState(false)
  const [removing, setRemoving] = useState(null)

  if (items.length === 0) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
        <EmptyState
          icon={ShoppingBag}
          title="Your cart is empty"
          description="Browse the campus feed and add something you actually need. Your cart is saved on this device."
          action={
            <Link to="/" className="btn-primary">
              <ArrowLeft size={16} />
              Explore the marketplace
            </Link>
          }
        />
      </div>
    )
  }

  const groups = groupBySeller(items)

  const onRemove = (item) => {
    setRemoving(item.id)
    removeItem(item.id)
    setRemoving(null)
  }

  const goToCheckout = () => {
    if (!user) {
      navigate('/login', { state: { from: '/checkout' } })
      return
    }
    navigate('/checkout')
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Your selection</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
            Cart
          </h1>
          <p className="mt-1.5 text-sm text-gray-400">
            {count} item{count === 1 ? '' : 's'} from {groups.length} seller
            {groups.length === 1 ? '' : 's'}
          </p>
        </div>
        <button type="button" onClick={() => setConfirmClear(true)} className="btn-ghost btn-sm">
          <Trash2 size={14} />
          Clear cart
        </button>
      </div>

      {isSuspended ? (
        <Alert variant="warning" className="mt-6">
          Your account is suspended. Checkout is disabled until the campus desk restores it.
        </Alert>
      ) : null}

      <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_360px] lg:items-start">
        <div className="space-y-5">
          {groups.map((group) => (
            <div key={group.sellerId} className="glass overflow-hidden rounded-3xl">
              <div className="flex items-center gap-2 border-b border-white/[0.07] px-5 py-3.5">
                <Store size={14} className="text-orange-300" />
                <p className="text-xs font-medium text-gray-300">
                  Sold by{' '}
                  <span className="text-white">{group.sellerName}</span>
                </p>
                <span className="ml-auto text-[10px] uppercase tracking-[0.14em] text-gray-600">
                  {group.items.length} item{group.items.length === 1 ? '' : 's'}
                </span>
              </div>

              <ul className="divide-y divide-white/[0.06]">
                {group.items.map((item) => (
                  <li key={item.id} className="flex gap-4 p-4 sm:p-5">
                    <Link
                      to={`/product/${item.id}`}
                      className="relative h-24 w-24 shrink-0 overflow-hidden rounded-2xl border border-white/[0.08] bg-ink-800 sm:h-28 sm:w-28"
                    >
                      {item.image_url ? (
                        <img
                          src={item.image_url}
                          alt={item.title}
                          loading="lazy"
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="grid h-full w-full place-items-center text-gray-600">
                          <ShoppingBag size={22} />
                        </div>
                      )}
                    </Link>

                    <div className="flex min-w-0 flex-1 flex-col">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <Link
                            to={`/product/${item.id}`}
                            className="line-clamp-2 text-sm font-semibold leading-snug text-white transition hover:text-orange-100"
                          >
                            {item.title}
                          </Link>
                          <p className="mt-1 text-[10px] uppercase tracking-[0.14em] text-gray-600">
                            {item.category}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => onRemove(item)}
                          disabled={removing === item.id}
                          className="shrink-0 rounded-full p-1.5 text-gray-500 transition hover:bg-red-500/10 hover:text-red-300"
                          aria-label={`Remove ${item.title} from cart`}
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>

                      <div className="mt-auto flex flex-wrap items-end justify-between gap-3 pt-3">
                        <QuantityStepper
                          value={item.quantity}
                          onChange={(next) => setQuantity(item.id, next)}
                          max={Math.min(99, Math.max(1, Number(item.stock ?? 99)))}
                        />
                        <div className="text-right">
                          <p className="text-sm font-semibold text-white">
                            {formatKES(item.price * item.quantity)}
                          </p>
                          <p className="text-[10px] text-gray-500">
                            {formatKES(item.price)} each
                          </p>
                        </div>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}

          <div className="flex items-start gap-2.5 rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4 text-xs leading-relaxed text-gray-500">
            <MapPin size={15} className="mt-0.5 shrink-0 text-orange-300" />
            M-Hustle does not take online payments. Pay the seller on handover after you have
            inspected the item. Checkout creates a separate order for each seller.
          </div>
        </div>

        {/* -------------------------------------------------------- summary */}
        <aside className="glass sticky top-24 rounded-3xl p-5 sm:p-6">
          <h2 className="text-base font-semibold text-white">Order summary</h2>

          <dl className="mt-5 space-y-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-gray-400">Subtotal</dt>
              <dd className="font-medium text-white">{formatKES(subtotal)}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-gray-400">Campus handover</dt>
              <dd className="font-medium text-emerald-300">Free</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-gray-400">M-Hustle fee</dt>
              <dd className="font-medium text-gray-300">KES 0</dd>
            </div>
          </dl>

          <div className="mt-5 flex items-end justify-between border-t border-white/[0.08] pt-4">
            <span className="text-sm font-medium text-gray-300">Total</span>
            <span className="font-display text-2xl font-semibold text-white">
              {formatKES(subtotal)}
            </span>
          </div>

          <button
            type="button"
            onClick={goToCheckout}
            disabled={isSuspended}
            className="btn-primary mt-5 w-full py-3"
          >
            {user ? 'Proceed to checkout' : 'Sign in to checkout'}
            <ArrowRight size={16} />
          </button>

          <p className="mt-3 text-center text-[10px] leading-relaxed text-gray-500">
            By continuing you agree to inspect items before paying and to communicate through
            M-Hustle.
          </p>

          <div className="mt-5 flex items-center gap-2 rounded-xl border border-emerald-400/15 bg-emerald-400/[0.04] px-3 py-2.5">
            <ShieldCheck size={14} className="text-emerald-400" />
            <p className="text-[10px] leading-relaxed text-emerald-100/70">
              Orders are protected by campus trading rules and visible to both parties.
            </p>
          </div>
        </aside>
      </div>

      <Modal
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        title="Clear your cart?"
        description="This removes every item from this device. You can add them again from the feed."
        footer={
          <>
            <button type="button" onClick={() => setConfirmClear(false)} className="btn-secondary">
              Keep cart
            </button>
            <button
              type="button"
              onClick={() => {
                clearCart()
                setConfirmClear(false)
              }}
              className="btn-danger"
            >
              <Trash2 size={15} />
              Clear cart
            </button>
          </>
        }
      />
    </div>
  )
}

```

## 4.6 src/pages/Checkout.jsx

```jsx
import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  MapPin,
  Phone,
  ShieldCheck,
  ShoppingBag,
  Store,
  Truck,
} from 'lucide-react'
import { useCart } from '../context/CartContext'
import { useAuth } from '../hooks/useAuth'
import { Alert, EmptyState, Spinner } from '../components/ui'
import { supabase } from '../lib/supabase'
import { formatKES, friendlyError, groupBySeller } from '../lib/utils'

export default function Checkout() {
  const { items, subtotal, removeItem, clearCart } = useCart()
  const { profile, isSuspended } = useAuth()
  const navigate = useNavigate()

  const [location, setLocation] = useState('')
  const [phone, setPhone] = useState(profile?.phone ?? '')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const groups = useMemo(() => groupBySeller(items), [items])
  const orderCount = groups.length

  if (items.length === 0) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
        <EmptyState
          icon={ShoppingBag}
          title="Nothing to check out"
          description="Your cart is empty. Add a listing from the feed, then come back to place the order."
          action={
            <Link to="/" className="btn-primary">
              <ArrowLeft size={16} />
              Browse the marketplace
            </Link>
          }
        />
      </div>
    )
  }

  const onPlaceOrder = async (event) => {
    event.preventDefault()
    setError('')

    const cleanPhone = phone.replace(/\s+/g, '').trim()
    const cleanLocation = location.trim()

    if (cleanLocation.length < 3) {
      setError('Tell the seller where to meet you — hostel, room or a campus pickup point.')
      return
    }
    if (!/^\+?[0-9]{9,15}$/.test(cleanPhone)) {
      setError('Enter a reachable phone number, for example 0712 345 678.')
      return
    }
    if (isSuspended) {
      setError('Your account is suspended. Checkout is disabled.')
      return
    }

    setSubmitting(true)

    const succeeded = []
    const failures = []

    for (const group of groups) {
      const { error: rpcError } = await supabase.rpc('create_order', {
        p_seller_id: group.sellerId,
        p_items: group.items.map((item) => ({
          listing_id: item.id,
          quantity: item.quantity,
        })),
        p_delivery_location: cleanLocation,
        p_contact_phone: cleanPhone,
      })

      if (rpcError) {
        failures.push({ seller: group.sellerName, message: friendlyError(rpcError) })
      } else {
        succeeded.push(group)
      }
    }

    if (failures.length === 0) {
      clearCart()
      navigate(`/orders?success=${groups.length}`, { replace: true })
      return
    }

    for (const group of succeeded) {
      for (const item of group.items) removeItem(item.id)
    }

    setSubmitting(false)

    if (succeeded.length > 0) {
      setError(
        `${succeeded.length} of ${groups.length} orders were placed and removed from your cart. ` +
          `${failures[0].seller}: ${failures[0].message} Review the remaining items and try again.`,
      )
      return
    }

    setError(failures[0].message)
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
      <Link to="/cart" className="inline-flex items-center gap-1.5 text-xs text-gray-400 transition hover:text-white">
        <ArrowLeft size={14} />
        Back to cart
      </Link>

      <div className="mt-5">
        <p className="eyebrow">Final step</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
          Checkout
        </h1>
        <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-gray-400">
          Confirm where and how to meet. M-Hustle creates one order per seller, and each seller
          sees your handover details.
        </p>
      </div>

      <form onSubmit={onPlaceOrder} className="mt-8 grid gap-6 lg:grid-cols-[1fr_380px] lg:items-start">
        <div className="space-y-5">
          {error ? <Alert variant="error">{error}</Alert> : null}

          <section className="glass rounded-3xl p-5 sm:p-6">
            <div className="flex items-center gap-2">
              <MapPin size={16} className="text-orange-300" />
              <h2 className="text-sm font-semibold text-white">Handover details</h2>
            </div>

            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label htmlFor="location" className="label">
                  Where should you meet?
                </label>
                <div className="relative">
                  <MapPin
                    size={16}
                    className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-gray-500"
                  />
                  <input
                    id="location"
                    type="text"
                    value={location}
                    onChange={(event) => setLocation(event.target.value)}
                    placeholder="e.g. Library steps, Hostel B reception"
                    className="input pl-11"
                    maxLength={160}
                    required
                  />
                </div>
                <p className="field-hint">
                  Choose a busy, public campus spot. The seller receives this with the order.
                </p>
              </div>

              <div>
                <label htmlFor="phone" className="label">
                  Phone number
                </label>
                <div className="relative">
                  <Phone
                    size={16}
                    className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-gray-500"
                  />
                  <input
                    id="phone"
                    type="tel"
                    value={phone}
                    onChange={(event) => setPhone(event.target.value)}
                    placeholder="0712 345 678"
                    className="input pl-11"
                    autoComplete="tel"
                    required
                  />
                </div>
              </div>

              <div>
                <span className="label">Buyer</span>
                <div className="rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-gray-300">
                  {profile?.full_name}
                  <span className="block text-[11px] text-gray-500">@{profile?.username}</span>
                </div>
              </div>
            </div>
          </section>

          <section className="space-y-4">
            {groups.map((group) => {
              const groupTotal = group.items.reduce(
                (sum, item) => sum + Number(item.price) * item.quantity,
                0,
              )

              return (
                <div key={group.sellerId} className="glass overflow-hidden rounded-3xl">
                  <div className="flex items-center gap-2 border-b border-white/[0.07] px-5 py-3.5">
                    <Store size={14} className="text-orange-300" />
                    <p className="text-xs text-gray-400">
                      Order from <span className="font-medium text-white">{group.sellerName}</span>
                    </p>
                    <span className="ml-auto text-xs font-semibold text-white">
                      {formatKES(groupTotal)}
                    </span>
                  </div>

                  <ul className="divide-y divide-white/[0.06]">
                    {group.items.map((item) => (
                      <li key={item.id} className="flex items-center gap-3.5 px-4 py-3.5 sm:px-5">
                        <div className="h-14 w-14 shrink-0 overflow-hidden rounded-xl border border-white/[0.08] bg-ink-800">
                          {item.image_url ? (
                            <img
                              src={item.image_url}
                              alt={item.title}
                              className="h-full w-full object-cover"
                              loading="lazy"
                            />
                          ) : (
                            <div className="grid h-full w-full place-items-center text-gray-600">
                              <ShoppingBag size={18} />
                            </div>
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="line-clamp-1 text-sm font-medium text-white">{item.title}</p>
                          <p className="mt-0.5 text-[11px] text-gray-500">
                            Qty {item.quantity} · {formatKES(item.price)} each
                          </p>
                        </div>
                        <p className="shrink-0 text-sm font-medium text-white">
                          {formatKES(item.price * item.quantity)}
                        </p>
                      </li>
                    ))}
                  </ul>
                </div>
              )
            })}
          </section>

          <section className="glass rounded-3xl p-5 sm:p-6">
            <div className="flex items-center gap-2">
              <Truck size={16} className="text-orange-300" />
              <h2 className="text-sm font-semibold text-white">Payment</h2>
            </div>

            <div className="mt-4 flex items-start gap-3 rounded-2xl border border-emerald-400/20 bg-emerald-400/[0.05] p-4">
              <CheckCircle2 size={17} className="mt-0.5 shrink-0 text-emerald-400" />
              <div>
                <p className="text-sm font-medium text-white">Pay on handover</p>
                <p className="mt-1 text-xs leading-relaxed text-gray-400">
                  Inspect the item, then pay the seller directly in cash or M-Pesa. M-Hustle
                  never collects the item price.
                </p>
              </div>
            </div>
          </section>
        </div>

        {/* ------------------------------------------------------- summary */}
        <aside className="glass sticky top-24 rounded-3xl p-5 sm:p-6">
          <h2 className="text-base font-semibold text-white">Order summary</h2>
          <p className="mt-1 text-xs text-gray-500">
            {items.length} item{items.length === 1 ? '' : 's'} · {orderCount} order
            {orderCount === 1 ? '' : 's'}
          </p>

          <div className="mt-5 space-y-3 border-y border-white/[0.07] py-4 text-sm">
            <div className="flex justify-between gap-3">
              <span className="text-gray-400">Subtotal</span>
              <span className="font-medium text-white">{formatKES(subtotal)}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-gray-400">Handover</span>
              <span className="font-medium text-emerald-300">Free</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-gray-400">Platform fee</span>
              <span className="font-medium text-gray-300">KES 0</span>
            </div>
          </div>

          <div className="mt-4 flex items-end justify-between">
            <span className="text-sm text-gray-300">Total due</span>
            <span className="font-display text-2xl font-semibold text-white">
              {formatKES(subtotal)}
            </span>
          </div>

          <button type="submit" disabled={submitting} className="btn-primary mt-5 w-full py-3">
            {submitting ? (
              <>
                <Spinner size={16} />
                Placing {orderCount === 1 ? 'order' : 'orders'}…
              </>
            ) : (
              <>
                Place {orderCount === 1 ? 'order' : `${orderCount} orders`}
                <ArrowRight size={16} />
              </>
            )}
          </button>

          <p className="mt-3 text-center text-[10px] leading-relaxed text-gray-500">
            This notifies each seller with your phone number and meeting point. Do not close
            this page while orders are being created.
          </p>

          <div className="mt-5 flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2.5">
            <ShieldCheck size={14} className="text-emerald-400" />
            <p className="text-[10px] leading-relaxed text-gray-500">
              You can cancel a pending order and confirm receipt after delivery.
            </p>
          </div>
        </aside>
      </form>
    </div>
  )
}

```

## 4.7 src/pages/BuyerOrders.jsx

```jsx
import { useCallback, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Clock3,
  MapPin,
  MessageSquare,
  Package,
  Phone,
  RefreshCw,
  ShoppingBag,
  Star,
  XCircle,
} from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { supabase } from '../lib/supabase'
import {
  Alert,
  Avatar,
  EmptyState,
  Modal,
  PageLoader,
  RatingStars,
  Spinner,
  StatusPill,
} from '../components/ui'
import {
  cn,
  formatDate,
  formatDateTime,
  formatKES,
  friendlyError,
  ORDER_STATUS_META,
} from '../lib/utils'

const ORDER_SELECT = `
  id, status, total_amount, created_at, delivery_location, contact_phone, seller_id,
  seller:profiles!orders_seller_id_fkey(id, username, full_name, avatar_url),
  items:order_items(id, quantity, price_at_purchase, listing:listings(id, title, image_url, status))
`

const FILTERS = [
  { value: 'all', label: 'All orders' },
  { value: 'pending', label: 'Pending' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
]

export default function BuyerOrders() {
  const { user } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()

  const [orders, setOrders] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('all')
  const [actionOrder, setActionOrder] = useState(null)
  const [actionType, setActionType] = useState(null)
  const [working, setWorking] = useState(false)
  const [actionError, setActionError] = useState('')
  const [reviews, setReviews] = useState({})
  const [reviewOrder, setReviewOrder] = useState(null)
  const [reviewRating, setReviewRating] = useState(5)
  const [reviewComment, setReviewComment] = useState('')
  const [reviewSaving, setReviewSaving] = useState(false)
  const [reviewError, setReviewError] = useState('')

  const [banner, setBanner] = useState(() => {
    const count = Number(searchParams.get('success') ?? 0)
    return count > 0
      ? `${count} order${count === 1 ? '' : 's'} placed. The seller has your handover details.`
      : ''
  })

  useEffect(() => {
    if (searchParams.has('success')) {
      const params = new URLSearchParams(searchParams)
      params.delete('success')
      setSearchParams(params, { replace: true })
    }
    // Intentionally runs once for the arrival banner.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const load = useCallback(async () => {
    if (!user?.id) return

    setLoading(true)
    setError('')

    const [orderResult, reviewResult] = await Promise.all([
      supabase
        .from('orders')
        .select(ORDER_SELECT)
        .eq('buyer_id', user.id)
        .order('created_at', { ascending: false }),
      supabase.from('reviews').select('order_id, rating').eq('buyer_id', user.id),
    ])

    if (orderResult.error) {
      setError(orderResult.error.message)
    } else {
      setOrders(orderResult.data ?? [])
    }

    if (!reviewResult.error) {
      const reviewMap = {}
      for (const review of reviewResult.data ?? []) {
        reviewMap[review.order_id] = review
      }
      setReviews(reviewMap)
    }

    setLoading(false)
  }, [user?.id])

  useEffect(() => {
    void load()
  }, [load])

  const openAction = (order, type) => {
    setActionError('')
    setActionOrder(order)
    setActionType(type)
  }

  const closeAction = () => {
    if (working) return
    setActionOrder(null)
    setActionType(null)
  }

  const confirmAction = async () => {
    if (!actionOrder || !actionType) return

    const nextStatus = actionType === 'confirm' ? 'completed' : 'cancelled'
    setWorking(true)
    setActionError('')

    const { error: updateError } = await supabase
      .from('orders')
      .update({ status: nextStatus })
      .eq('id', actionOrder.id)

    setWorking(false)

    if (updateError) {
      setActionError(friendlyError(updateError))
      return
    }

    setOrders((current) =>
      current.map((order) =>
        order.id === actionOrder.id ? { ...order, status: nextStatus } : order,
      ),
    )
    setActionOrder(null)
    setActionType(null)
  }

  const openReview = (order) => {
    setReviewOrder(order)
    setReviewRating(5)
    setReviewComment('')
    setReviewError('')
  }

  const closeReview = () => {
    if (reviewSaving) return
    setReviewOrder(null)
  }

  const submitReview = async () => {
    if (!reviewOrder || reviewSaving) return

    setReviewSaving(true)
    setReviewError('')

    const { error: insertError } = await supabase.from('reviews').insert({
      order_id: reviewOrder.id,
      buyer_id: user.id,
      seller_id: reviewOrder.seller_id,
      rating: reviewRating,
      comment: reviewComment.trim() || null,
    })

    setReviewSaving(false)

    if (insertError) {
      setReviewError(friendlyError(insertError, 'Your review could not be submitted.'))
      return
    }

    setReviews((current) => ({
      ...current,
      [reviewOrder.id]: { order_id: reviewOrder.id, rating: reviewRating },
    }))
    setReviewOrder(null)
  }

  const visibleOrders =
    filter === 'all' ? orders : orders.filter((order) => order.status === filter)

  const counts = orders.reduce(
    (acc, order) => {
      acc[order.status] = (acc[order.status] ?? 0) + 1
      return acc
    },
    {},
  )

  if (loading && orders.length === 0) {
    return <PageLoader label="Loading your orders…" />
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Purchase history</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
            My orders
          </h1>
          <p className="mt-1.5 text-sm text-gray-400">
            Confirm receipt once an item is in your hands. Until then, the seller keeps the
            order open.
          </p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => void load()} className="btn-secondary btn-sm">
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
          <Link to="/" className="btn-primary btn-sm">
            <ShoppingBag size={14} />
            Keep shopping
          </Link>
        </div>
      </div>

      {banner ? (
        <Alert variant="success" className="mt-6" onClose={() => setBanner('')}>
          {banner}
        </Alert>
      ) : null}

      {error ? (
        <Alert variant="error" className="mt-6" title="Orders could not load">
          {error}
        </Alert>
      ) : null}

      <div className="no-scrollbar mt-7 flex gap-2 overflow-x-auto pb-1">
        {FILTERS.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => setFilter(option.value)}
            className={cn('chip shrink-0', filter === option.value && 'chip-active')}
          >
            {option.label}
            <span className="text-[10px] opacity-60">
              {option.value === 'all' ? orders.length : counts[option.value] ?? 0}
            </span>
          </button>
        ))}
      </div>

      <div className="mt-6 space-y-5">
        {visibleOrders.length === 0 ? (
          <EmptyState
            icon={Package}
            title={orders.length === 0 ? 'No orders yet' : `No ${filter} orders`}
            description={
              orders.length === 0
                ? 'When you check out, every order appears here with its status, seller and handover details.'
                : 'Try a different status filter to see the rest of your purchase history.'
            }
            action={
              orders.length === 0 ? (
                <Link to="/" className="btn-primary">
                  <ArrowLeft size={16} />
                  Browse listings
                </Link>
              ) : (
                <button type="button" onClick={() => setFilter('all')} className="btn-secondary">
                  Show all orders
                </button>
              )
            }
          />
        ) : (
          visibleOrders.map((order) => {
            const meta = ORDER_STATUS_META[order.status]
            const itemCount = (order.items ?? []).reduce((sum, item) => sum + item.quantity, 0)

            return (
              <article key={order.id} className="glass overflow-hidden rounded-3xl">
                <div className="flex flex-wrap items-center gap-3 border-b border-white/[0.07] px-5 py-4">
                  <div className="min-w-0">
                    <p className="text-[10px] uppercase tracking-[0.16em] text-gray-600">
                      Order MH-{order.id.slice(0, 8).toUpperCase()}
                    </p>
                    <p className="mt-0.5 text-xs text-gray-400">
                      {formatDateTime(order.created_at)}
                    </p>
                  </div>
                  <div className="ml-auto flex items-center gap-2">
                    <StatusPill meta={meta} />
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-3 border-b border-white/[0.06] px-5 py-3">
                  <Avatar profile={order.seller} size={26} />
                  <p className="text-xs text-gray-400">
                    Sold by{' '}
                    <Link
                      to={`/messages?user=${order.seller_id}`}
                      className="font-medium text-white hover:text-orange-200"
                    >
                      {order.seller?.full_name || order.seller?.username || 'Campus seller'}
                    </Link>
                  </p>
                  <Link
                    to={`/messages?user=${order.seller_id}`}
                    className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-orange-300 transition hover:text-orange-200"
                  >
                    <MessageSquare size={13} />
                    Message seller
                  </Link>
                </div>

                <ul className="divide-y divide-white/[0.06]">
                  {(order.items ?? []).map((item) => (
                    <li key={item.id} className="flex items-center gap-3.5 px-5 py-3.5">
                      <div className="h-14 w-14 shrink-0 overflow-hidden rounded-xl border border-white/[0.08] bg-ink-800">
                        {item.listing?.image_url ? (
                          <img
                            src={item.listing.image_url}
                            alt={item.listing.title || 'Ordered item'}
                            loading="lazy"
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <div className="grid h-full w-full place-items-center text-gray-600">
                            <ShoppingBag size={18} />
                          </div>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        {item.listing ? (
                          <Link
                            to={`/product/${item.listing.id}`}
                            className="line-clamp-1 text-sm font-medium text-white transition hover:text-orange-100"
                          >
                            {item.listing.title}
                          </Link>
                        ) : (
                          <p className="text-sm text-gray-400">Listing no longer available</p>
                        )}
                        <p className="mt-0.5 text-[11px] text-gray-500">
                          {item.quantity} × {formatKES(item.price_at_purchase)}
                        </p>
                      </div>
                      <p className="shrink-0 text-sm font-medium text-white">
                        {formatKES(Number(item.price_at_purchase) * item.quantity)}
                      </p>
                    </li>
                  ))}
                </ul>

                <div className="flex flex-wrap items-end justify-between gap-4 border-t border-white/[0.07] bg-white/[0.015] px-5 py-4">
                  <div className="space-y-1.5 text-[11px] text-gray-500">
                    {order.delivery_location ? (
                      <p className="flex items-center gap-1.5">
                        <MapPin size={12} className="text-orange-300" />
                        {order.delivery_location}
                      </p>
                    ) : null}
                    {order.contact_phone ? (
                      <p className="flex items-center gap-1.5">
                        <Phone size={12} className="text-gray-600" />
                        {order.contact_phone}
                      </p>
                    ) : null}
                    <p className="flex items-center gap-1.5">
                      <Clock3 size={12} className="text-gray-600" />
                      {itemCount} item{itemCount === 1 ? '' : 's'} · {formatDate(order.created_at)}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <div className="mr-1 text-right">
                      <p className="text-[10px] uppercase tracking-[0.14em] text-gray-600">
                        Total
                      </p>
                      <p className="font-display text-lg font-semibold text-white">
                        {formatKES(order.total_amount)}
                      </p>
                    </div>

                    {order.status === 'pending' ? (
                      <button
                        type="button"
                        onClick={() => openAction(order, 'cancel')}
                        className="btn-danger btn-sm"
                      >
                        <XCircle size={14} />
                        Cancel
                      </button>
                    ) : null}

                    {order.status === 'delivered' ? (
                      <button
                        type="button"
                        onClick={() => openAction(order, 'confirm')}
                        className="btn-primary btn-sm"
                      >
                        <CheckCircle2 size={14} />
                        Confirm receipt
                      </button>
                    ) : null}

                    {order.status === 'completed' ? (
                      <>
                        <span className="badge border-emerald-400/20 bg-emerald-400/10 text-emerald-300">
                          <CheckCircle2 size={12} />
                          Received
                        </span>
                        {reviews[order.id] ? (
                          <span className="badge border-amber-400/20 bg-amber-400/10 text-amber-300">
                            <Star size={12} fill="currentColor" />
                            Rated {reviews[order.id].rating}/5
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => openReview(order)}
                            className="btn-secondary btn-sm"
                          >
                            <Star size={13} />
                            Rate seller
                          </button>
                        )}
                      </>
                    ) : null}

                    {order.status === 'cancelled' ? (
                      <span className="badge border-red-400/20 bg-red-400/10 text-red-300">
                        <AlertCircle size={12} />
                        Closed
                      </span>
                    ) : null}
                  </div>
                </div>
              </article>
            )
          })
        )}
      </div>

      <Modal
        open={Boolean(actionOrder && actionType)}
        onClose={closeAction}
        title={actionType === 'confirm' ? 'Confirm you received this order?' : 'Cancel this order?'}
        description={
          actionType === 'confirm'
            ? 'This marks the order completed and tells the seller the handover is done. Only confirm after you have inspected the item.'
            : 'The seller will see the order as cancelled. You can always order the item again if it is still available.'
        }
        footer={
          <>
            <button type="button" onClick={closeAction} disabled={working} className="btn-secondary">
              Keep order
            </button>
            <button
              type="button"
              onClick={confirmAction}
              disabled={working}
              className={actionType === 'confirm' ? 'btn-primary' : 'btn-danger'}
            >
              {working ? (
                <>
                  <Spinner size={15} />
                  Updating…
                </>
              ) : actionType === 'confirm' ? (
                <>
                  <CheckCircle2 size={15} />
                  Confirm receipt
                </>
              ) : (
                <>
                  <XCircle size={15} />
                  Cancel order
                </>
              )}
            </button>
          </>
        }
      >
        {actionError ? <Alert variant="error">{actionError}</Alert> : null}
        {actionOrder ? (
          <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-sm">
            <p className="text-gray-400">
              Order <span className="text-white">MH-{actionOrder.id.slice(0, 8).toUpperCase()}</span>
            </p>
            <p className="mt-1 text-xs text-gray-500">
              {actionOrder.seller?.full_name || actionOrder.seller?.username} ·{' '}
              {formatKES(actionOrder.total_amount)}
            </p>
          </div>
        ) : null}
      </Modal>

      <Modal
        open={Boolean(reviewOrder)}
        onClose={closeReview}
        title="Rate this seller"
        description="Your rating helps good campus sellers rise to the top of the feed."
        footer={
          <>
            <button
              type="button"
              onClick={closeReview}
              disabled={reviewSaving}
              className="btn-secondary"
            >
              Not now
            </button>
            <button
              type="button"
              onClick={submitReview}
              disabled={reviewSaving}
              className="btn-primary"
            >
              {reviewSaving ? (
                <>
                  <Spinner size={15} />
                  Submitting…
                </>
              ) : (
                <>
                  <Star size={15} />
                  Submit rating
                </>
              )}
            </button>
          </>
        }
      >
        {reviewError ? <Alert variant="error">{reviewError}</Alert> : null}
        {reviewOrder ? (
          <div className="space-y-4">
            <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
              <p className="text-sm font-medium text-white">
                {reviewOrder.seller?.full_name || reviewOrder.seller?.username}
              </p>
              <p className="mt-1 text-xs text-gray-500">
                Order MH-{reviewOrder.id.slice(0, 8).toUpperCase()} ·{' '}
                {formatKES(reviewOrder.total_amount)}
              </p>
            </div>

            <div>
              <p className="label">Your rating</p>
              <div className="flex justify-center rounded-2xl border border-white/10 bg-black/20 py-4">
                <RatingStars
                  value={reviewRating}
                  onChange={setReviewRating}
                  size={32}
                />
              </div>
              <p className="mt-2 text-center text-xs text-gray-500">
                {reviewRating} out of 5
              </p>
            </div>

            <div>
              <label htmlFor="reviewComment" className="label">
                Comment <span className="normal-case tracking-normal text-gray-600">(optional)</span>
              </label>
              <textarea
                id="reviewComment"
                value={reviewComment}
                onChange={(event) => setReviewComment(event.target.value.slice(0, 1000))}
                placeholder="How was the item and the handover?"
                rows={3}
                className="textarea"
              />
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  )
}

```

## 4.8 src/pages/Messages.jsx

```jsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import {
  ArrowLeft,
  Check,
  CheckCheck,
  ChevronRight,
  MessageSquare,
  RefreshCw,
  Send,
  ShoppingBag,
  Store,
} from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { supabase } from '../lib/supabase'
import { Alert, Avatar, EmptyState, PageLoader, Spinner } from '../components/ui'
import VerifiedBadge from '../components/VerifiedBadge'
import {
  chatTime,
  cn,
  formatDate,
  formatKES,
  friendlyError,
} from '../lib/utils'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MESSAGE_SELECT =
  'id, sender_id, receiver_id, listing_id, content, is_read, created_at'
const PROFILE_SELECT = 'id, username, full_name, avatar_url, role'

export default function Messages() {
  const { user, profile, isSuspended } = useAuth()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  const [messages, setMessages] = useState([])
  const [profiles, setProfiles] = useState({})
  const [badges, setBadges] = useState({})
  const [contextListing, setContextListing] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)

  const bottomRef = useRef(null)
  const inputRef = useRef(null)
  const profilesRef = useRef({})
  const requestedRef = useRef(new Set())
  const activeIdRef = useRef(null)

  const rawActive = searchParams.get('user')
  const activeId =
    rawActive && UUID_RE.test(rawActive) && rawActive !== user?.id ? rawActive : null
  const listingParam = searchParams.get('listing')

  activeIdRef.current = activeId

  useEffect(() => {
    profilesRef.current = profiles
  }, [profiles])

  const hydrateProfiles = useCallback(async (ids) => {
    const unique = [...new Set(ids.filter((id) => id && UUID_RE.test(id)))]
    const missing = unique.filter(
      (id) => !profilesRef.current[id] && !requestedRef.current.has(id),
    )
    if (missing.length === 0) return

    for (const id of missing) requestedRef.current.add(id)

    const { data, error: profileError } = await supabase
      .from('profiles')
      .select(PROFILE_SELECT)
      .in('id', missing)

    if (profileError) {
      for (const id of missing) requestedRef.current.delete(id)
      return
    }

    if (data?.length) {
      const next = { ...profilesRef.current }
      for (const row of data) next[row.id] = row
      profilesRef.current = next
      setProfiles(next)
    }
  }, [])

  const load = useCallback(async () => {
    if (!user?.id) return

    setLoading(true)
    setError('')

    const [messageResult, badgeResult] = await Promise.all([
      supabase
        .from('messages')
        .select(MESSAGE_SELECT)
        .or(`sender_id.eq.${user.id},receiver_id.eq.${user.id}`)
        .order('created_at', { ascending: false })
        .limit(500),
      supabase.rpc('get_seller_badges'),
    ])

    if (messageResult.error) {
      setError(messageResult.error.message)
      setLoading(false)
      return
    }

    const rows = messageResult.data ?? []
    setMessages((current) => {
      const merged = new Map(rows.map((message) => [message.id, message]))
      for (const message of current) merged.set(message.id, message)
      return [...merged.values()].sort(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
      )
    })

    const badgeMap = {}
    for (const row of badgeResult.data ?? []) badgeMap[row.seller_id] = row
    setBadges(badgeMap)

    const counterpartIds = rows.map((row) =>
      row.sender_id === user.id ? row.receiver_id : row.sender_id,
    )
    await hydrateProfiles(counterpartIds)

    setLoading(false)
  }, [user?.id, hydrateProfiles])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (activeId) void hydrateProfiles([activeId])
  }, [activeId, hydrateProfiles])

  useEffect(() => {
    if (!user?.id) return undefined

    const channel = supabase
      .channel(`mh-thread-${user.id}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages' },
        (payload) => {
          const row = payload.new
          if (!row || (row.sender_id !== user.id && row.receiver_id !== user.id)) return

          setMessages((current) =>
            current.some((message) => message.id === row.id) ? current : [...current, row],
          )

          const counterpart = row.sender_id === user.id ? row.receiver_id : row.sender_id
          void hydrateProfiles([counterpart])

          if (row.receiver_id === user.id && row.sender_id === activeIdRef.current) {
            void supabase
              .from('messages')
              .update({ is_read: true })
              .eq('id', row.id)
              .then(() =>
                setMessages((current) =>
                  current.map((message) =>
                    message.id === row.id ? { ...message, is_read: true } : message,
                  ),
                ),
              )
          }
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'messages' },
        (payload) => {
          const row = payload.new
          if (!row) return
          setMessages((current) =>
            current.map((message) => (message.id === row.id ? { ...message, ...row } : message)),
          )
        },
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [user?.id, hydrateProfiles])

  // Load the listing referenced by a "Chat with seller" deep link.
  useEffect(() => {
    let active = true

    if (!listingParam || !UUID_RE.test(listingParam)) {
      setContextListing(null)
      return undefined
    }

    const fetchListing = async () => {
      const { data } = await supabase
        .from('listings')
        .select('id, title, price, image_url, status, seller_id')
        .eq('id', listingParam)
        .maybeSingle()

      if (active) setContextListing(data ?? null)
    }

    void fetchListing()
    return () => {
      active = false
    }
  }, [listingParam])

  // Mark the open thread as read.
  useEffect(() => {
    if (!user?.id || !activeId) return

    const unread = messages.filter(
      (message) =>
        message.sender_id === activeId &&
        message.receiver_id === user.id &&
        !message.is_read,
    )
    if (unread.length === 0) return

    const ids = unread.map((message) => message.id)

    setMessages((current) =>
      current.map((message) =>
        ids.includes(message.id) ? { ...message, is_read: true } : message,
      ),
    )

    void supabase
      .from('messages')
      .update({ is_read: true })
      .in('id', ids)
      .eq('receiver_id', user.id)
  }, [activeId, messages, user?.id])

  const threadMessages = useMemo(() => {
    if (!activeId) return []
    return messages.filter(
      (message) =>
        (message.sender_id === user?.id && message.receiver_id === activeId) ||
        (message.receiver_id === user?.id && message.sender_id === activeId),
    )
  }, [messages, activeId, user?.id])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' })
  }, [activeId, threadMessages.length])

  useEffect(() => {
    if (activeId) {
      const timer = setTimeout(() => inputRef.current?.focus(), 120)
      return () => clearTimeout(timer)
    }
    return undefined
  }, [activeId])

  const conversations = useMemo(() => {
    if (!user?.id) return []

    const map = new Map()

    for (const message of messages) {
      const otherId =
        message.sender_id === user.id ? message.receiver_id : message.sender_id
      const entry = map.get(otherId) ?? {
        otherId,
        lastMessage: null,
        unread: 0,
      }

      if (
        !entry.lastMessage ||
        new Date(message.created_at) >= new Date(entry.lastMessage.created_at)
      ) {
        entry.lastMessage = message
      }
      if (message.receiver_id === user.id && !message.is_read) entry.unread += 1
      map.set(otherId, entry)
    }

    if (activeId && !map.has(activeId)) {
      map.set(activeId, { otherId: activeId, lastMessage: null, unread: 0 })
    }

    return [...map.values()].sort((a, b) => {
      const aTime = a.lastMessage ? new Date(a.lastMessage.created_at).getTime() : 0
      const bTime = b.lastMessage ? new Date(b.lastMessage.created_at).getTime() : 0
      return bTime - aTime
    })
  }, [messages, user?.id, activeId])

  const activeProfile = activeId ? profiles[activeId] : null
  const activeBadge = activeId ? badges[activeId] : null

  const openConversation = (id) => {
    setSearchParams({ user: id })
  }

  const sendMessage = async (event) => {
    event?.preventDefault()
    const content = draft.trim()
    if (!content || !activeId || sending || isSuspended) return

    setSending(true)
    setError('')

    const { data, error: sendError } = await supabase
      .from('messages')
      .insert({
        sender_id: user.id,
        receiver_id: activeId,
        listing_id: contextListing?.id ?? null,
        content,
      })
      .select(MESSAGE_SELECT)
      .single()

    setSending(false)

    if (sendError) {
      setError(friendlyError(sendError, 'Your message could not be sent.'))
      return
    }

    setMessages((current) =>
      current.some((message) => message.id === data.id) ? current : [...current, data],
    )
    setDraft('')

    if (listingParam) {
      setSearchParams({ user: activeId }, { replace: true })
    }
  }

  const onKeyDown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void sendMessage()
    }
  }

  if (loading) {
    return <PageLoader label="Opening your messages…" />
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Direct messages</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
            Messages
          </h1>
          <p className="mt-1.5 text-sm text-gray-400">
            Real-time conversations with buyers and sellers. Keep every deal inside M-Hustle.
          </p>
        </div>
        <button type="button" onClick={() => void load()} className="btn-secondary btn-sm">
          <RefreshCw size={13} className="text-gray-400" />
          Refresh
        </button>
      </div>

      {error ? (
        <Alert variant="error" className="mt-6" onClose={() => setError('')}>
          {error}
        </Alert>
      ) : null}

      <div className="mt-7 grid overflow-hidden rounded-3xl border border-white/[0.08] bg-[rgba(15,15,24,0.65)] backdrop-blur-xl lg:grid-cols-[320px_1fr]">
        {/* --------------------------------------------------- conversations */}
        <aside
          className={cn(
            'border-b border-white/[0.07] lg:border-b-0 lg:border-r',
            activeId ? 'hidden lg:block' : 'block',
          )}
        >
          <div className="flex items-center justify-between border-b border-white/[0.07] px-4 py-3.5">
            <h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-400">
              Conversations
            </h2>
            <span className="text-[10px] text-gray-600">{conversations.length}</span>
          </div>

          {conversations.length === 0 ? (
            <div className="px-5 py-10 text-center">
              <MessageSquare size={24} className="mx-auto text-gray-600" />
              <p className="mt-3 text-sm font-medium text-white">No conversations yet</p>
              <p className="mt-1 text-xs leading-relaxed text-gray-500">
                Open a listing and tap “Chat with seller” to start one.
              </p>
              <Link to="/" className="btn-secondary btn-sm mt-4">
                Browse listings
              </Link>
            </div>
          ) : (
            <ul className="max-h-[560px] overflow-y-auto lg:max-h-[calc(100vh-240px)]">
              {conversations.map((conversation) => {
                const other = profiles[conversation.otherId]
                const isActive = conversation.otherId === activeId
                const last = conversation.lastMessage
                const badge = badges[conversation.otherId]

                return (
                  <li key={conversation.otherId}>
                    <button
                      type="button"
                      onClick={() => openConversation(conversation.otherId)}
                      className={cn(
                        'flex w-full items-start gap-3 border-b border-white/[0.05] px-4 py-3.5 text-left transition',
                        isActive
                          ? 'bg-orange-500/[0.07]'
                          : 'hover:bg-white/[0.04]',
                      )}
                    >
                      <Avatar profile={other} size={38} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <p className="truncate text-sm font-medium text-white">
                            {other?.full_name || other?.username || 'M-Hustle member'}
                          </p>
                          {badge ? <VerifiedBadge plan={badge.plan} size={13} /> : null}
                          <span className="ml-auto shrink-0 text-[10px] text-gray-600">
                            {last ? chatTime(last.created_at) : 'New'}
                          </span>
                        </div>
                        <p className="mt-0.5 line-clamp-1 text-xs text-gray-500">
                          {last
                            ? `${last.sender_id === user.id ? 'You: ' : ''}${last.content}`
                            : 'Start the conversation'}
                        </p>
                      </div>
                      {conversation.unread > 0 ? (
                        <span className="mt-1 grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-gradient-to-r from-orange-500 to-pink-500 px-1 text-[10px] font-bold text-white">
                          {conversation.unread}
                        </span>
                      ) : null}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </aside>

        {/* --------------------------------------------------------- thread */}
        <section className={cn('flex min-h-[540px] flex-col lg:min-h-[calc(100vh-240px)]', !activeId && 'hidden lg:flex')}>
          {!activeId ? (
            <div className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center">
              <span className="grid h-16 w-16 place-items-center rounded-3xl border border-white/10 bg-white/[0.03] text-gray-500">
                <MessageSquare size={28} />
              </span>
              <h3 className="mt-5 text-lg font-semibold text-white">Select a conversation</h3>
              <p className="mt-2 max-w-sm text-sm leading-relaxed text-gray-500">
                Chat about price, condition or a handover spot. Messages update in real time,
                so you never need to refresh.
              </p>
            </div>
          ) : (
            <>
              <header className="flex flex-wrap items-center gap-3 border-b border-white/[0.07] px-4 py-3.5 sm:px-5">
                <button
                  type="button"
                  onClick={() => navigate('/messages')}
                  className="icon-btn h-8 w-8 lg:hidden"
                  aria-label="Back to conversations"
                >
                  <ArrowLeft size={15} />
                </button>

                <Avatar profile={activeProfile} size={38} />

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <p className="truncate text-sm font-semibold text-white">
                      {activeProfile?.full_name ||
                        activeProfile?.username ||
                        'Loading conversation…'}
                    </p>
                    {activeBadge ? <VerifiedBadge plan={activeBadge.plan} size={14} /> : null}
                  </div>
                  <p className="truncate text-[11px] text-gray-500">
                    @{activeProfile?.username || 'member'}
                    {activeBadge
                      ? ` · ${activeBadge.plan === 'pro_max' ? 'Pro Max' : 'Pro'} seller`
                      : ' · M-Hustle member'}
                  </p>
                </div>

                {contextListing ? (
                  <Link
                    to={`/product/${contextListing.id}`}
                    className="hidden items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-[11px] text-gray-300 transition hover:border-white/20 sm:flex"
                  >
                    <ShoppingBag size={12} className="text-orange-300" />
                    <span className="max-w-[180px] truncate">{contextListing.title}</span>
                    <ChevronRight size={12} className="text-gray-600" />
                  </Link>
                ) : null}
              </header>

              <div className="flex-1 space-y-4 overflow-y-auto px-4 py-5 sm:px-5 lg:max-h-[calc(100vh-390px)]">
                {contextListing ? (
                  <div className="mx-auto flex max-w-md items-center gap-3 rounded-2xl border border-orange-400/15 bg-orange-400/[0.05] p-3">
                    <div className="h-12 w-12 shrink-0 overflow-hidden rounded-xl bg-ink-800">
                      {contextListing.image_url ? (
                        <img
                          src={contextListing.image_url}
                          alt={contextListing.title}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="grid h-full w-full place-items-center text-gray-600">
                          <Store size={16} />
                        </div>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-[10px] uppercase tracking-[0.14em] text-orange-300/80">
                        Chatting about
                      </p>
                      <p className="truncate text-xs font-medium text-white">
                        {contextListing.title}
                      </p>
                      <p className="text-[11px] text-gray-500">
                        {formatKES(contextListing.price)}
                      </p>
                    </div>
                    <Link
                      to={`/product/${contextListing.id}`}
                      className="shrink-0 rounded-full p-1.5 text-gray-500 transition hover:bg-white/10 hover:text-white"
                      aria-label="Open listing"
                    >
                      <ChevronRight size={15} />
                    </Link>
                  </div>
                ) : null}

                {threadMessages.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 text-center">
                    <Avatar profile={activeProfile} size={52} />
                    <p className="mt-4 text-sm font-medium text-white">
                      Say hello to {activeProfile?.full_name?.split(' ')[0] || 'your seller'}
                    </p>
                    <p className="mt-1 max-w-xs text-xs leading-relaxed text-gray-500">
                      Ask about condition, price, or where to meet on campus. Be clear and
                      keep it respectful.
                    </p>
                  </div>
                ) : (
                  threadMessages.map((message, index) => {
                    const mine = message.sender_id === user.id
                    const previous = threadMessages[index - 1]
                    const showDate =
                      !previous ||
                      new Date(previous.created_at).toDateString() !==
                        new Date(message.created_at).toDateString()

                    return (
                      <div key={message.id}>
                        {showDate ? (
                          <div className="my-4 flex items-center gap-3">
                            <span className="h-px flex-1 bg-white/[0.06]" />
                            <span className="text-[10px] uppercase tracking-[0.14em] text-gray-600">
                              {formatDate(message.created_at)}
                            </span>
                            <span className="h-px flex-1 bg-white/[0.06]" />
                          </div>
                        ) : null}

                        <div className={cn('flex gap-2.5', mine ? 'justify-end' : 'justify-start')}>
                          {!mine ? <Avatar profile={activeProfile} size={26} /> : null}
                          <div className={cn('max-w-[82%] sm:max-w-[70%]', mine && 'items-end')}>
                            <div
                              className={cn(
                                'rounded-2xl px-4 py-2.5 text-sm leading-relaxed',
                                mine
                                  ? 'rounded-br-md bg-gradient-to-br from-orange-500/90 to-pink-500/90 text-white'
                                  : 'rounded-bl-md border border-white/[0.08] bg-white/[0.05] text-gray-200',
                              )}
                            >
                              <p className="whitespace-pre-wrap break-words">{message.content}</p>
                            </div>
                            <div
                              className={cn(
                                'mt-1 flex items-center gap-1 text-[10px] text-gray-600',
                                mine ? 'justify-end' : 'justify-start',
                              )}
                            >
                              {chatTime(message.created_at)}
                              {mine ? (
                                message.is_read ? (
                                  <CheckCheck size={12} className="text-sky-400" />
                                ) : (
                                  <Check size={12} />
                                )
                              ) : null}
                            </div>
                          </div>
                        </div>
                      </div>
                    )
                  })
                )}
                <div ref={bottomRef} />
              </div>

              {isSuspended ? (
                <div className="border-t border-red-500/15 bg-red-500/[0.05] px-4 py-3 text-center text-xs text-red-200">
                  Messaging is disabled while your account is suspended.
                </div>
              ) : (
                <form
                  onSubmit={sendMessage}
                  className="border-t border-white/[0.07] bg-ink-900/40 p-3 sm:p-4"
                >
                  <div className="flex items-end gap-2 rounded-2xl border border-white/10 bg-black/30 p-2 transition focus-within:border-orange-400/50">
                    <textarea
                      ref={inputRef}
                      value={draft}
                      onChange={(event) => setDraft(event.target.value.slice(0, 2000))}
                      onKeyDown={onKeyDown}
                      rows={1}
                      placeholder="Write a message…"
                      aria-label="Message"
                      className="max-h-32 min-h-[38px] flex-1 resize-none bg-transparent px-2 py-2 text-sm text-white placeholder-gray-500 focus:outline-none"
                    />
                    <button
                      type="submit"
                      disabled={!draft.trim() || sending}
                      className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-gradient-to-r from-orange-500 to-pink-500 text-white transition hover:brightness-110 disabled:opacity-40"
                      aria-label="Send message"
                    >
                      {sending ? <Spinner size={15} /> : <Send size={15} />}
                    </button>
                  </div>
                  <div className="mt-1.5 flex items-center justify-between px-1 text-[10px] text-gray-600">
                    <span>Enter to send · Shift + Enter for a new line</span>
                    {draft.length > 1800 ? <span>{draft.length}/2000</span> : null}
                  </div>
                </form>
              )}
            </>
          )}
        </section>
      </div>

      {conversations.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            icon={ShoppingBag}
            title="No messages yet"
            description="Conversations start from a listing. Find something you like, open it, and tap Chat with seller."
            action={
              <Link to="/" className="btn-primary">
                Explore the marketplace
              </Link>
            }
          />
        </div>
      ) : null}

      <p className="mt-6 text-center text-[10px] uppercase tracking-[0.14em] text-gray-700">
        Messages are delivered in real time · stay respectful
      </p>
    </div>
  )
}

```

## 4.9 src/pages/SellerDashboard.jsx

```jsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  ArrowRight,
  BadgeCheck,
  Banknote,
  CheckCircle2,
  ChevronDown,
  Clock3,
  ImagePlus,
  LayoutDashboard,
  MessageSquare,
  Package,
  PackagePlus,
  Phone,
  Plus,
  RefreshCw,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
  Star,
  Trash2,
  Upload,
  X,
  XCircle,
} from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { supabase, LISTING_IMAGES_BUCKET } from '../lib/supabase'
import {
  ACCEPTED_IMAGE_TYPES,
  CATEGORIES,
  MAX_IMAGE_BYTES,
  MPESA_ACCOUNT,
  MPESA_PAYBILL,
  PLANS,
  PLAN_BY_ID,
  SUPPORT_EMAIL,
} from '../lib/constants'
import {
  cn,
  formatDate,
  formatDateTime,
  formatKES,
  friendlyError,
  LISTING_STATUS_META,
  ORDER_STATUS_META,
  SUBSCRIPTION_STATUS_META,
  timeAgo,
} from '../lib/utils'
import {
  Alert,
  Avatar,
  EmptyState,
  Modal,
  PageLoader,
  Spinner,
  StatCard,
  StatusPill,
} from '../components/ui'
import VerifiedBadge from '../components/VerifiedBadge'

const TABS = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'listings', label: 'Listings', icon: Package },
  { id: 'new', label: 'New listing', icon: PackagePlus },
  { id: 'orders', label: 'Orders', icon: ShoppingBag },
  { id: 'subscription', label: 'Subscription', icon: BadgeCheck },
]

const ORDER_SELECT = `
  id, status, total_amount, created_at, delivery_location, contact_phone, buyer_id,
  buyer:profiles!orders_buyer_id_fkey(id, username, full_name, avatar_url, created_at),
  items:order_items(id, quantity, price_at_purchase, listing:listings(id, title, image_url, status))
`

export default function SellerDashboard() {
  const { profile } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()

  const [listings, setListings] = useState([])
  const [orders, setOrders] = useState([])
  const [subscriptions, setSubscriptions] = useState([])
  const [rating, setRating] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [action, setAction] = useState(null)
  const [actionError, setActionError] = useState('')
  const [actionWorking, setActionWorking] = useState(false)
  const [stockEdit, setStockEdit] = useState(null)
  const [stockValue, setStockValue] = useState('1')
  const [stockError, setStockError] = useState('')
  const [stockSaving, setStockSaving] = useState(false)

  const tabParam = searchParams.get('tab')
  const tab = TABS.some((item) => item.id === tabParam) ? tabParam : 'overview'

  const changeTab = (nextTab) => {
    const params = new URLSearchParams(searchParams)
    if (nextTab === 'overview') params.delete('tab')
    else params.set('tab', nextTab)
    setSearchParams(params, { replace: true })
    setSuccess('')
  }

  const load = useCallback(async () => {
    if (!profile?.id) return

    setLoading(true)
    setError('')

    const [listingResult, orderResult, subscriptionResult, ratingResult] = await Promise.all([
      supabase
        .from('listings')
        .select('*')
        .eq('seller_id', profile.id)
        .order('created_at', { ascending: false }),
      supabase
        .from('orders')
        .select(ORDER_SELECT)
        .eq('seller_id', profile.id)
        .order('created_at', { ascending: false }),
      supabase
        .from('subscriptions')
        .select('*')
        .eq('seller_id', profile.id)
        .order('created_at', { ascending: false }),
      supabase.rpc('get_seller_ratings'),
    ])

    if (listingResult.error || orderResult.error || subscriptionResult.error) {
      setError(
        listingResult.error?.message ||
          orderResult.error?.message ||
          subscriptionResult.error?.message ||
          'Dashboard data could not load.',
      )
    }

    setListings(listingResult.data ?? [])
    setOrders(orderResult.data ?? [])
    setSubscriptions(subscriptionResult.data ?? [])
    setRating(
      (ratingResult.data ?? []).find((row) => row.seller_id === profile.id) ?? null,
    )
    setLoading(false)
  }, [profile?.id])

  useEffect(() => {
    void load()
  }, [load])

  const activeSubscription = useMemo(
    () =>
      subscriptions.find(
        (subscription) =>
          subscription.status === 'active' &&
          subscription.expires_at &&
          new Date(subscription.expires_at) > new Date(),
      ) ?? null,
    [subscriptions],
  )

  const pendingSubscription = useMemo(
    () => subscriptions.find((subscription) => subscription.status === 'pending') ?? null,
    [subscriptions],
  )

  const metrics = useMemo(() => {
    const paidOrders = orders.filter(
      (order) => order.status === 'delivered' || order.status === 'completed',
    )
    return {
      totalSales: paidOrders.reduce((sum, order) => sum + Number(order.total_amount), 0),
      activeListings: listings.filter((listing) => listing.status === 'active').length,
      pendingOrders: orders.filter((order) => order.status === 'pending').length,
      completedOrders: orders.filter((order) => order.status === 'completed').length,
      deliveredOrders: orders.filter((order) => order.status === 'delivered').length,
    }
  }, [listings, orders])

  const onListingCreated = (listing) => {
    setListings((current) => [listing, ...current])
    changeTab('listings')
    setSuccess('Listing published. It is live on the campus feed now.')
  }

  const onSubscriptionCreated = (subscription) => {
    setSubscriptions((current) => [subscription, ...current])
    setSuccess(
      'M-Pesa code submitted. Your badge activates as soon as the campus desk approves it.',
    )
  }

  const openListingAction = (listing, nextStatus) => {
    const labels = {
      sold: {
        title: 'Mark this listing as sold?',
        description:
          'It will disappear from the public feed immediately. You can relist it later if the deal falls through.',
        confirm: 'Mark as sold',
      },
      active: {
        title: 'Put this listing back on the feed?',
        description: 'Buyers will be able to find and order it again.',
        confirm: 'Relist',
      },
      deleted: {
        title: 'Remove this listing?',
        description:
          'This hides the listing permanently from the feed. Order history keeps its record.',
        confirm: 'Remove listing',
      },
    }

    setActionError('')
    setAction({
      kind: 'listing',
      id: listing.id,
      nextStatus,
      title: labels[nextStatus].title,
      description: labels[nextStatus].description,
      confirm: labels[nextStatus].confirm,
      tone: nextStatus === 'deleted' ? 'danger' : 'primary',
    })
  }

  const openOrderAction = (order, nextStatus) => {
    const delivered = nextStatus === 'delivered'
    setActionError('')
    setAction({
      kind: 'order',
      id: order.id,
      nextStatus,
      order,
      title: delivered ? 'Mark this order as delivered?' : 'Cancel this order?',
      description: delivered
        ? 'This confirms handover. Stock was reserved at checkout; a listing that sold out stays out of the public feed. The buyer can then confirm receipt.'
        : 'The buyer will see the order as cancelled. Any reserved quantity returns to the listing automatically.',
      confirm: delivered ? 'Mark delivered' : 'Cancel order',
      tone: delivered ? 'primary' : 'danger',
    })
  }

  const openStock = (listing) => {
    setStockEdit(listing)
    setStockValue(String(listing.quantity ?? 1))
    setStockError('')
  }

  const saveStock = async () => {
    if (!stockEdit) return

    const quantity = Number(stockValue)
    if (!Number.isInteger(quantity) || quantity < 0 || quantity > 9999) {
      setStockError('Enter a whole number between 0 and 9,999.')
      return
    }

    setStockSaving(true)
    setStockError('')

    const nextStatus =
      stockEdit.status === 'deleted' ? 'deleted' : quantity <= 0 ? 'sold' : 'active'

    const { error: updateError } = await supabase
      .from('listings')
      .update({ quantity, status: nextStatus })
      .eq('id', stockEdit.id)

    setStockSaving(false)

    if (updateError) {
      setStockError(friendlyError(updateError))
      return
    }

    setListings((current) =>
      current.map((row) =>
        row.id === stockEdit.id
          ? { ...row, quantity, status: nextStatus }
          : row,
      ),
    )
    setSuccess(
      quantity === 0
        ? 'Stock set to zero — the listing is now marked sold.'
        : `Stock updated to ${quantity}.`,
    )
    setStockEdit(null)
  }

  const runAction = async () => {
    if (!action) return

    setActionWorking(true)
    setActionError('')

    if (action.kind === 'listing') {
      const { error: updateError } = await supabase
        .from('listings')
        .update({ status: action.nextStatus })
        .eq('id', action.id)

      if (updateError) {
        setActionError(friendlyError(updateError))
        setActionWorking(false)
        return
      }

      setListings((current) =>
        current.map((listing) =>
          listing.id === action.id ? { ...listing, status: action.nextStatus } : listing,
        ),
      )
    }

    if (action.kind === 'order') {
      const { error: updateError } = await supabase
        .from('orders')
        .update({ status: action.nextStatus })
        .eq('id', action.id)

      if (updateError) {
        setActionError(friendlyError(updateError))
        setActionWorking(false)
        return
      }

      setOrders((current) =>
        current.map((order) =>
          order.id === action.id ? { ...order, status: action.nextStatus } : order,
        ),
      )

      if (action.nextStatus === 'delivered' && action.order?.items?.length) {
        const soldIds = new Set(
          action.order.items.map((item) => item.listing?.id).filter(Boolean),
        )
        setListings((current) =>
          current.map((listing) =>
            soldIds.has(listing.id) ? { ...listing, status: 'sold' } : listing,
          ),
        )
      }
    }

    setActionWorking(false)
    setAction(null)
  }

  if (loading) {
    return <PageLoader label="Opening your seller studio…" />
  }

  const firstName = profile?.full_name?.split(' ')[0] || profile?.username || 'there'

  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
      {/* ------------------------------------------------------------ header */}
      <div className="relative overflow-hidden rounded-4xl border border-emerald-400/10 bg-[radial-gradient(circle_at_10%_0%,rgba(16,185,129,0.16),transparent_55%),radial-gradient(circle_at_95%_100%,rgba(20,184,166,0.10),transparent_55%)] p-6 sm:p-8">
        <div className="relative flex flex-wrap items-start justify-between gap-6">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-emerald-300/80">
              Seller studio
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
                Hi, {firstName}
              </h1>
              {activeSubscription ? (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1.5">
                  <VerifiedBadge plan={activeSubscription.plan} size={17} />
                  <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-gray-300">
                    {PLAN_BY_ID[activeSubscription.plan]?.name ?? 'Pro'}
                  </span>
                </span>
              ) : null}
            </div>
            <p className="mt-2 max-w-xl text-sm leading-relaxed text-gray-400">
              Manage listings, fulfil orders and grow your reputation across Maseno. Every
              completed order builds trust.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-3 text-[11px] text-gray-500">
              <span>@{profile?.username}</span>
              <span className="h-1 w-1 rounded-full bg-gray-700" />
              <span>{listings.length} listings</span>
              <span className="h-1 w-1 rounded-full bg-gray-700" />
              <span>{formatKES(metrics.totalSales)} in sales</span>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Link to="/" className="btn-secondary btn-sm">
              View storefront
            </Link>
            <button type="button" onClick={() => changeTab('new')} className="btn-seller btn-sm">
              <Plus size={14} />
              New listing
            </button>
          </div>
        </div>
      </div>

      {success ? (
        <Alert variant="success" className="mt-5" onClose={() => setSuccess('')}>
          {success}
        </Alert>
      ) : null}

      {error ? (
        <Alert variant="error" className="mt-5" title="Some dashboard data did not load">
          {error}
          <button type="button" onClick={() => void load()} className="btn-secondary btn-sm mt-3">
            <RefreshCw size={13} />
            Retry
          </button>
        </Alert>
      ) : null}

      {/* -------------------------------------------------------------- tabs */}
      <div className="no-scrollbar mt-6 flex gap-1.5 overflow-x-auto rounded-2xl border border-white/[0.07] bg-white/[0.025] p-1.5">
        {TABS.map(({ id, label, icon: Icon }) => {
          const active = tab === id
          const badgeCount =
            id === 'orders' ? metrics.pendingOrders : id === 'listings' ? listings.length : 0

          return (
            <button
              key={id}
              type="button"
              onClick={() => changeTab(id)}
              className={cn(
                'flex shrink-0 items-center gap-2 rounded-xl px-3.5 py-2 text-xs font-medium transition',
                active
                  ? 'bg-white/[0.09] text-white shadow-sm'
                  : 'text-gray-400 hover:bg-white/[0.04] hover:text-white',
              )}
            >
              <Icon size={15} className={active ? 'text-emerald-300' : 'text-gray-500'} />
              {label}
              {badgeCount > 0 ? (
                <span
                  className={cn(
                    'rounded-full px-1.5 py-0.5 text-[10px] font-semibold',
                    active ? 'bg-emerald-400/15 text-emerald-300' : 'bg-white/[0.06] text-gray-500',
                  )}
                >
                  {badgeCount}
                </span>
              ) : null}
            </button>
          )
        })}
      </div>

      <div className="mt-6">
        {tab === 'overview' ? (
          <OverviewTab
            profile={profile}
            metrics={metrics}
            orders={orders}
            listings={listings}
            activeSubscription={activeSubscription}
            pendingSubscription={pendingSubscription}
            rating={rating}
            onTab={changeTab}
          />
        ) : null}

        {tab === 'listings' ? (
          <ListingsTab
            listings={listings}
            onNew={() => changeTab('new')}
            onAction={openListingAction}
            onStock={openStock}
          />
        ) : null}

        {tab === 'new' ? (
          <NewListingForm profile={profile} onCreated={onListingCreated} />
        ) : null}

        {tab === 'orders' ? <OrdersTab orders={orders} onAction={openOrderAction} /> : null}

        {tab === 'subscription' ? (
          <SubscriptionTab
            profile={profile}
            subscriptions={subscriptions}
            activeSubscription={activeSubscription}
            pendingSubscription={pendingSubscription}
            onCreated={onSubscriptionCreated}
          />
        ) : null}
      </div>

      <Modal
        open={Boolean(action)}
        onClose={() => {
          if (!actionWorking) setAction(null)
        }}
        title={action?.title}
        description={action?.description}
        footer={
          <>
            <button
              type="button"
              onClick={() => setAction(null)}
              disabled={actionWorking}
              className="btn-secondary"
            >
              Keep as is
            </button>
            <button
              type="button"
              onClick={runAction}
              disabled={actionWorking}
              className={action?.tone === 'danger' ? 'btn-danger' : 'btn-seller'}
            >
              {actionWorking ? (
                <>
                  <Spinner size={15} />
                  Working…
                </>
              ) : (
                action?.confirm
              )}
            </button>
          </>
        }
      >
        {actionError ? <Alert variant="error">{actionError}</Alert> : null}
      </Modal>

      <Modal
        open={Boolean(stockEdit)}
        onClose={() => {
          if (!stockSaving) setStockEdit(null)
        }}
        title="Update stock"
        description={
          stockEdit
            ? `How many units of "${stockEdit.title}" do you have available? Setting this to zero marks the listing sold.`
            : ''
        }
        footer={
          <>
            <button
              type="button"
              onClick={() => setStockEdit(null)}
              disabled={stockSaving}
              className="btn-secondary"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={saveStock}
              disabled={stockSaving}
              className="btn-seller"
            >
              {stockSaving ? (
                <>
                  <Spinner size={15} />
                  Saving…
                </>
              ) : (
                <>
                  <Package size={15} />
                  Save stock
                </>
              )}
            </button>
          </>
        }
      >
        {stockError ? <Alert variant="error">{stockError}</Alert> : null}
        <div className="mt-3">
          <label htmlFor="stockQuantity" className="label">
            Quantity available
          </label>
          <input
            id="stockQuantity"
            type="number"
            min="0"
            max="9999"
            step="1"
            value={stockValue}
            onChange={(event) => setStockValue(event.target.value)}
            className="input"
            autoFocus
          />
          <p className="field-hint">
            Stock is reserved when a buyer checks out and restored if the order is cancelled.
          </p>
        </div>
      </Modal>
    </div>
  )
}

/* ========================================================================== */
/* OVERVIEW                                                                   */
/* ========================================================================== */
function OverviewTab({
  profile,
  metrics,
  orders,
  listings,
  activeSubscription,
  pendingSubscription,
  rating,
  onTab,
}) {
  const recentOrders = orders.slice(0, 5)
  const activeListings = listings.filter((listing) => listing.status === 'active')
  const hasNoData = listings.length === 0 && orders.length === 0

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard
          icon={Banknote}
          label="Total sales"
          value={formatKES(metrics.totalSales)}
          hint={`${metrics.completedOrders} completed · ${metrics.deliveredOrders} awaiting receipt`}
          accent="green"
        />
        <StatCard
          icon={Package}
          label="Active listings"
          value={metrics.activeListings}
          hint={`${listings.filter((listing) => listing.status === 'sold').length} sold all-time`}
          accent="orange"
        />
        <StatCard
          icon={Clock3}
          label="Pending orders"
          value={metrics.pendingOrders}
          hint="Awaiting handover to the buyer"
          accent="amber"
        />
        <StatCard
          icon={CheckCircle2}
          label="Completed orders"
          value={metrics.completedOrders}
          hint="Confirmed received by buyers"
          accent="purple"
        />
        <StatCard
          icon={Star}
          label="Seller rating"
          value={
            rating && Number(rating.review_count) > 0
              ? `${Number(rating.average_rating).toFixed(1)} / 5`
              : 'New'
          }
          hint={
            rating && Number(rating.review_count) > 0
              ? `${rating.review_count} buyer review${Number(rating.review_count) === 1 ? '' : 's'}`
              : 'Complete a trade to earn reviews'
          }
          accent="amber"
        />
      </div>

      {hasNoData ? (
        <div className="relative overflow-hidden rounded-3xl border border-emerald-400/15 bg-[radial-gradient(circle_at_20%_0%,rgba(16,185,129,0.12),transparent_55%)] p-7 sm:p-9">
          <span className="grid h-12 w-12 place-items-center rounded-2xl border border-emerald-400/25 bg-emerald-400/10 text-emerald-300">
            <Sparkles size={22} />
          </span>
          <h2 className="mt-4 text-xl font-semibold text-white">Your shop starts here</h2>
          <p className="mt-2 max-w-lg text-sm leading-relaxed text-gray-400">
            Publish your first listing to appear on the Maseno feed. Add a clear photo, an
            honest description and a fair price. Pro sellers get a verified badge and higher
            placement.
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            <button type="button" onClick={() => onTab('new')} className="btn-seller">
              <PackagePlus size={16} />
              Create your first listing
            </button>
            <button type="button" onClick={() => onTab('subscription')} className="btn-secondary">
              <BadgeCheck size={16} />
              Explore plans
            </button>
          </div>
        </div>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
        <section className="glass overflow-hidden rounded-3xl">
          <div className="flex items-center justify-between gap-3 border-b border-white/[0.07] px-5 py-4">
            <div>
              <h2 className="text-sm font-semibold text-white">Recent orders</h2>
              <p className="mt-0.5 text-[11px] text-gray-500">Latest activity from buyers</p>
            </div>
            <button
              type="button"
              onClick={() => onTab('orders')}
              className="text-[11px] font-medium text-emerald-300 transition hover:text-emerald-200"
            >
              View all
            </button>
          </div>

          {recentOrders.length === 0 ? (
            <div className="px-5 py-10 text-center">
              <ShoppingBag size={22} className="mx-auto text-gray-600" />
              <p className="mt-3 text-sm text-gray-400">No orders yet</p>
              <p className="mt-1 text-xs text-gray-600">
                Share your listings with classmates to get the first one.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-white/[0.06]">
              {recentOrders.map((order) => (
                <li key={order.id} className="flex items-center gap-3 px-5 py-3.5">
                  <Avatar profile={order.buyer} size={32} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-white">
                      {order.buyer?.full_name || order.buyer?.username || 'Buyer'}
                    </p>
                    <p className="mt-0.5 truncate text-[11px] text-gray-500">
                      {order.items?.length ?? 0} item{order.items?.length === 1 ? '' : 's'} ·{' '}
                      {timeAgo(order.created_at)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs font-semibold text-white">
                      {formatKES(order.total_amount)}
                    </p>
                    <StatusPill meta={ORDER_STATUS_META[order.status]} className="mt-1" />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="space-y-5">
          <section className="glass rounded-3xl p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-white">Visibility</h2>
              <Link
                to="/seller?tab=subscription"
                className="text-[11px] text-emerald-300 hover:text-emerald-200"
              >
                Manage
              </Link>
            </div>

            {activeSubscription ? (
              <div className="mt-4">
                <div className="flex items-center gap-2">
                  <VerifiedBadge plan={activeSubscription.plan} size={24} />
                  <div>
                    <p className="text-sm font-semibold text-white">
                      {PLAN_BY_ID[activeSubscription.plan]?.name} seller
                    </p>
                    <p className="text-[11px] text-gray-500">
                      Active until {formatDate(activeSubscription.expires_at)}
                    </p>
                  </div>
                </div>
                <p className="mt-3 text-xs leading-relaxed text-gray-400">
                  Your listings are prioritised above free sellers and carry the verified
                  badge on every card.
                </p>
              </div>
            ) : pendingSubscription ? (
              <div className="mt-4">
                <StatusPill meta={SUBSCRIPTION_STATUS_META.pending} />
                <p className="mt-3 text-xs leading-relaxed text-gray-400">
                  {PLAN_BY_ID[pendingSubscription.plan]?.name} payment submitted with code{' '}
                  <span className="font-mono text-gray-200">{pendingSubscription.mpesa_code}</span>.
                  The campus desk is reviewing it.
                </p>
                <button
                  type="button"
                  onClick={() => onTab('subscription')}
                  className="btn-secondary btn-sm mt-3"
                >
                  View request
                </button>
              </div>
            ) : (
              <div className="mt-4">
                <p className="text-xs leading-relaxed text-gray-400">
                  Stand out with a blue Pro badge or go all-in with gold Pro Max and top feed
                  placement.
                </p>
                <button
                  type="button"
                  onClick={() => onTab('subscription')}
                  className="btn-secondary btn-sm mt-3"
                >
                  <BadgeCheck size={14} />
                  See plans
                </button>
              </div>
            )}
          </section>

          <section className="glass rounded-3xl p-5">
            <h2 className="text-sm font-semibold text-white">Quick actions</h2>
            <div className="mt-3 grid gap-2">
              <QuickAction icon={PackagePlus} label="Add a listing" onClick={() => onTab('new')} />
              <QuickAction
                icon={ShoppingBag}
                label={`Review ${metrics.pendingOrders} pending order${metrics.pendingOrders === 1 ? '' : 's'}`}
                onClick={() => onTab('orders')}
              />
              <QuickAction
                icon={BadgeCheck}
                label="Upgrade visibility"
                onClick={() => onTab('subscription')}
              />
            </div>
          </section>

          <section className="rounded-3xl border border-emerald-400/15 bg-emerald-400/[0.04] p-5">
            <div className="flex items-center gap-2 text-emerald-300">
              <ShieldCheck size={16} />
              <p className="text-xs font-semibold">Seller standard</p>
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-gray-400">
              Reply within a day, describe flaws honestly, and meet in public campus spots.
              Sellers who complete orders keep the verified marketplace trustworthy.
            </p>
            <p className="mt-3 text-[10px] text-gray-600">Signed in as @{profile?.username}</p>
          </section>
        </div>
      </div>

      {activeListings.length > 0 ? (
        <section>
          <div className="flex items-end justify-between gap-3">
            <h2 className="text-lg font-semibold text-white">Your live listings</h2>
            <button
              type="button"
              onClick={() => onTab('listings')}
              className="text-[11px] text-emerald-300 hover:text-emerald-200"
            >
              Manage all
            </button>
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {activeListings.slice(0, 3).map((listing) => (
              <div key={listing.id} className="glass flex gap-3 overflow-hidden rounded-2xl p-3">
                <div className="h-16 w-16 shrink-0 overflow-hidden rounded-xl bg-ink-800">
                  {listing.image_url ? (
                    <img
                      src={listing.image_url}
                      alt={listing.title}
                      className="h-full w-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <div className="grid h-full w-full place-items-center text-gray-600">
                      <Package size={18} />
                    </div>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-xs font-medium text-white">{listing.title}</p>
                  <p className="mt-1 text-xs font-semibold text-emerald-300">
                    {formatKES(listing.price)}
                  </p>
                  <p className="mt-1 text-[10px] text-gray-600">{timeAgo(listing.created_at)}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  )
}

function QuickAction({ icon: Icon, label, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-2.5 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2.5 text-left text-xs text-gray-300 transition hover:border-white/15 hover:bg-white/[0.05] hover:text-white"
    >
      <Icon size={15} className="text-emerald-300" />
      {label}
      <ArrowRight size={13} className="ml-auto text-gray-600" />
    </button>
  )
}

/* ========================================================================== */
/* LISTINGS                                                                   */
/* ========================================================================== */
function ListingsTab({ listings, onNew, onAction, onStock }) {
  const [filter, setFilter] = useState('all')

  const counts = useMemo(
    () =>
      listings.reduce(
        (acc, listing) => {
          acc[listing.status] = (acc[listing.status] ?? 0) + 1
          return acc
        },
        {},
      ),
    [listings],
  )

  const visible =
    filter === 'all' ? listings : listings.filter((listing) => listing.status === filter)

  const filters = [
    { value: 'all', label: 'All', count: listings.length },
    { value: 'active', label: 'Active', count: counts.active ?? 0 },
    { value: 'sold', label: 'Sold', count: counts.sold ?? 0 },
    { value: 'deleted', label: 'Removed', count: counts.deleted ?? 0 },
  ]

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-white">Manage listings</h2>
          <p className="mt-1 text-sm text-gray-500">
            {counts.active ?? 0} live · {counts.sold ?? 0} sold · {counts.deleted ?? 0} removed
          </p>
        </div>
        <button type="button" onClick={onNew} className="btn-seller btn-sm">
          <Plus size={14} />
          New listing
        </button>
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        {filters.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => setFilter(option.value)}
            className={cn('chip', filter === option.value && 'chip-active')}
          >
            {option.label}
            <span className="text-[10px] opacity-60">{option.count}</span>
          </button>
        ))}
      </div>

      <div className="mt-5 space-y-3">
        {visible.length === 0 ? (
          <EmptyState
            icon={Package}
            title={listings.length === 0 ? 'No listings yet' : 'Nothing in this filter'}
            description={
              listings.length === 0
                ? 'Create your first listing and it will appear on the campus feed immediately.'
                : 'Switch filters to see the rest of your inventory.'
            }
            action={
              listings.length === 0 ? (
                <button type="button" onClick={onNew} className="btn-seller">
                  <PackagePlus size={16} />
                  Create a listing
                </button>
              ) : (
                <button type="button" onClick={() => setFilter('all')} className="btn-secondary">
                  Show all
                </button>
              )
            }
          />
        ) : (
          visible.map((listing) => (
            <div
              key={listing.id}
              className="glass flex flex-col gap-4 rounded-2xl p-4 sm:flex-row sm:items-center"
            >
              <div className="h-20 w-20 shrink-0 overflow-hidden rounded-xl border border-white/[0.08] bg-ink-800">
                {listing.image_url ? (
                  <img
                    src={listing.image_url}
                    alt={listing.title}
                    className="h-full w-full object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div className="grid h-full w-full place-items-center text-gray-600">
                    <Package size={20} />
                  </div>
                )}
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    to={`/product/${listing.id}`}
                    className="line-clamp-1 text-sm font-semibold text-white transition hover:text-emerald-200"
                  >
                    {listing.title}
                  </Link>
                  <StatusPill meta={LISTING_STATUS_META[listing.status]} />
                </div>
                <p className="mt-1 text-[11px] text-gray-500">
                  {listing.category} · {listing.quantity ?? 1} available · listed{' '}
                  {formatDate(listing.created_at)}
                </p>
                <p className="mt-1.5 font-display text-base font-semibold text-white">
                  {formatKES(listing.price)}
                </p>
              </div>

              <div className="flex flex-wrap gap-2 sm:justify-end">
                <Link to={`/product/${listing.id}`} className="btn-ghost btn-sm">
                  View
                </Link>

                {listing.status !== 'deleted' ? (
                  <button
                    type="button"
                    onClick={() => onStock(listing)}
                    className="btn-secondary btn-sm"
                  >
                    <Package size={13} />
                    Stock
                  </button>
                ) : null}

                {listing.status === 'active' ? (
                  <button
                    type="button"
                    onClick={() => onAction(listing, 'sold')}
                    className="btn-secondary btn-sm"
                  >
                    <CheckCircle2 size={13} />
                    Mark sold
                  </button>
                ) : null}

                {listing.status === 'sold' ? (
                  <button
                    type="button"
                    onClick={() => onAction(listing, 'active')}
                    className="btn-secondary btn-sm"
                  >
                    <RefreshCw size={13} />
                    Relist
                  </button>
                ) : null}

                {listing.status !== 'deleted' ? (
                  <button
                    type="button"
                    onClick={() => onAction(listing, 'deleted')}
                    className="btn-danger btn-sm"
                  >
                    <Trash2 size={13} />
                    Remove
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => onAction(listing, 'active')}
                    className="btn-secondary btn-sm"
                  >
                    <RefreshCw size={13} />
                    Restore
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

/* ========================================================================== */
/* CREATE LISTING                                                            */
/* ========================================================================== */
function NewListingForm({ profile, onCreated }) {
  const [form, setForm] = useState({
    title: '',
    category: 'Electronics',
    price: '',
    quantity: '1',
    description: '',
  })
  const [imageFile, setImageFile] = useState(null)
  const [preview, setPreview] = useState('')
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [stage, setStage] = useState('')

  const fileInputRef = useRef(null)
  const previewRef = useRef('')

  useEffect(
    () => () => {
      if (previewRef.current) URL.revokeObjectURL(previewRef.current)
    },
    [],
  )

  const update = (field) => (event) =>
    setForm((current) => ({ ...current, [field]: event.target.value }))

  const pickFile = (file) => {
    if (!file) return
    if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
      setError('Use a JPG, PNG, WebP or AVIF image.')
      return
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setError('The photo must be 5 MB or smaller.')
      return
    }

    if (previewRef.current) URL.revokeObjectURL(previewRef.current)
    const url = URL.createObjectURL(file)
    previewRef.current = url
    setPreview(url)
    setImageFile(file)
    setError('')
  }

  const onSubmit = async (event) => {
    event.preventDefault()
    setError('')

    const title = form.title.trim()
    const description = form.description.trim()
    const price = Number(form.price)
    const quantity = Number(form.quantity)

    if (title.length < 3) {
      setError('Give your listing a title of at least 3 characters.')
      return
    }
    if (!Number.isFinite(price) || price <= 0) {
      setError('Enter a price greater than zero.')
      return
    }
    if (price > 100000000) {
      setError('That price is above the marketplace limit.')
      return
    }
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 9999) {
      setError('Enter how many units you have available, between 1 and 9,999.')
      return
    }
    if (!imageFile) {
      setError('Add a clear photo — listings with photos sell far faster.')
      return
    }

    setSubmitting(true)

    try {
      setStage('Uploading photo…')

      const ext =
        {
          'image/jpeg': 'jpg',
          'image/png': 'png',
          'image/webp': 'webp',
          'image/avif': 'avif',
        }[imageFile.type] ?? 'jpg'

      const path = `${profile.id}/${crypto.randomUUID()}.${ext}`

      const { error: uploadError } = await supabase.storage
        .from(LISTING_IMAGES_BUCKET)
        .upload(path, imageFile, {
          cacheControl: '31536000',
          upsert: false,
          contentType: imageFile.type,
        })

      if (uploadError) throw uploadError

      const { data: publicData } = supabase.storage
        .from(LISTING_IMAGES_BUCKET)
        .getPublicUrl(path)

      setStage('Publishing listing…')

      const { data, error: insertError } = await supabase
        .from('listings')
        .insert({
          seller_id: profile.id,
          title,
          description,
          price,
          quantity,
          category: form.category,
          image_url: publicData.publicUrl,
          status: 'active',
        })
        .select('*')
        .single()

      if (insertError) throw insertError

      setForm({ title: '', category: form.category, price: '', quantity: '1', description: '' })
      setImageFile(null)
      if (previewRef.current) URL.revokeObjectURL(previewRef.current)
      previewRef.current = ''
      setPreview('')
      onCreated(data)
    } catch (submitError) {
      setError(friendlyError(submitError, 'The listing could not be published.'))
    } finally {
      setSubmitting(false)
      setStage('')
    }
  }

  return (
    <div>
      <div>
        <h2 className="text-xl font-semibold text-white">Create a listing</h2>
        <p className="mt-1 text-sm text-gray-500">
          A strong photo and an honest description are the difference between a browse and a
          sale.
        </p>
      </div>

      <form onSubmit={onSubmit} className="mt-5 grid gap-5 lg:grid-cols-[1fr_360px]">
        <div className="space-y-5">
          {error ? <Alert variant="error">{error}</Alert> : null}

          <section className="glass rounded-3xl p-5 sm:p-6">
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="sm:col-span-3">
                <label htmlFor="title" className="label">
                  Listing title
                </label>
                <input
                  id="title"
                  type="text"
                  value={form.title}
                  onChange={update('title')}
                  placeholder="e.g. Engineering Mathematics by K.A. Stroud"
                  maxLength={120}
                  className="input"
                  required
                />
                <div className="mt-1.5 flex justify-between">
                  <span className="field-hint">Be specific: course, model, size or condition.</span>
                  <span className="text-[10px] text-gray-600">{form.title.length}/120</span>
                </div>
              </div>

              <div>
                <label htmlFor="price" className="label">
                  Price (KES)
                </label>
                <div className="relative">
                  <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-xs font-medium text-gray-500">
                    KES
                  </span>
                  <input
                    id="price"
                    type="number"
                    min="1"
                    step="1"
                    value={form.price}
                    onChange={update('price')}
                    placeholder="1500"
                    className="input pl-14"
                    required
                  />
                </div>
              </div>

              <div>
                <label htmlFor="category" className="label">
                  Category
                </label>
                <div className="relative">
                  <select
                    id="category"
                    value={form.category}
                    onChange={update('category')}
                    className="select"
                    required
                  >
                    {CATEGORIES.map((category) => (
                      <option key={category.value} value={category.value}>
                        {category.value}
                      </option>
                    ))}
                  </select>
                  <ChevronDown
                    size={16}
                    className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-gray-500"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="quantity" className="label">
                  Quantity available
                </label>
                <input
                  id="quantity"
                  type="number"
                  min="1"
                  max="9999"
                  step="1"
                  value={form.quantity}
                  onChange={update('quantity')}
                  placeholder="1"
                  className="input"
                  required
                />
                <p className="field-hint">Units you can sell right now.</p>
              </div>

              <div className="sm:col-span-3">
                <label htmlFor="description" className="label">
                  Description
                </label>
                <textarea
                  id="description"
                  value={form.description}
                  onChange={update('description')}
                  placeholder="Condition, what is included, why you are selling, and the best handover spot…"
                  maxLength={4000}
                  rows={7}
                  className="textarea"
                />
                <div className="mt-1.5 flex justify-between">
                  <span className="field-hint">
                    Mention any flaws. Buyers trust listings that are specific.
                  </span>
                  <span className="text-[10px] text-gray-600">{form.description.length}/4000</span>
                </div>
              </div>
            </div>
          </section>

          <section className="glass rounded-3xl p-5 sm:p-6">
            <div className="grid gap-2 rounded-2xl border border-emerald-400/15 bg-emerald-400/[0.04] p-4 sm:grid-cols-3">
              <PublishStep number="1" title="Photo" body="Natural light, clean background." />
              <PublishStep number="2" title="Details" body="Honest condition and price." />
              <PublishStep number="3" title="Go live" body="Appears on the feed instantly." />
            </div>
          </section>
        </div>

        <aside className="space-y-4">
          <div className="glass rounded-3xl p-4">
            <p className="label mb-2">Listing photo</p>

            <div
              onDragOver={(event) => {
                event.preventDefault()
                setDragging(true)
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault()
                setDragging(false)
                pickFile(event.dataTransfer.files?.[0])
              }}
              className={cn(
                'relative overflow-hidden rounded-2xl border border-dashed transition',
                dragging
                  ? 'border-emerald-400/60 bg-emerald-400/[0.06]'
                  : 'border-white/15 bg-black/20',
              )}
            >
              {preview ? (
                <div className="relative aspect-[4/3]">
                  <img src={preview} alt="Listing preview" className="h-full w-full object-cover" />
                  <button
                    type="button"
                    onClick={() => {
                      if (previewRef.current) URL.revokeObjectURL(previewRef.current)
                      previewRef.current = ''
                      setPreview('')
                      setImageFile(null)
                      if (fileInputRef.current) fileInputRef.current.value = ''
                    }}
                    className="absolute right-2 top-2 grid h-8 w-8 place-items-center rounded-full bg-black/60 text-white backdrop-blur transition hover:bg-black/80"
                    aria-label="Remove photo"
                  >
                    <X size={15} />
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="flex aspect-[4/3] w-full flex-col items-center justify-center gap-2 px-5 text-center"
                >
                  <span className="grid h-11 w-11 place-items-center rounded-2xl border border-white/10 bg-white/[0.04] text-emerald-300">
                    <ImagePlus size={20} />
                  </span>
                  <span className="text-xs font-medium text-white">Click or drop a photo</span>
                  <span className="text-[10px] leading-relaxed text-gray-500">
                    JPG, PNG, WebP or AVIF · max 5 MB
                  </span>
                </button>
              )}
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED_IMAGE_TYPES.join(',')}
              onChange={(event) => pickFile(event.target.files?.[0])}
              className="hidden"
            />

            <p className="mt-2.5 text-[10px] leading-relaxed text-gray-600">
              Use your own photo. Clear, well-lit images get more messages and faster sales.
            </p>
          </div>

          <div className="glass rounded-3xl p-5">
            <p className="text-xs font-semibold text-white">Publishing checklist</p>
            <ul className="mt-3 space-y-2 text-[11px] text-gray-400">
              <li className="flex gap-2">
                <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-emerald-400" />
                Real price in Kenyan Shillings
              </li>
              <li className="flex gap-2">
                <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-emerald-400" />
                Clear handover location in your messages
              </li>
              <li className="flex gap-2">
                <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-emerald-400" />
                No prohibited or counterfeit items
              </li>
            </ul>
          </div>

          <button type="submit" disabled={submitting} className="btn-seller w-full py-3">
            {submitting ? (
              <>
                <Spinner size={16} />
                {stage || 'Publishing…'}
              </>
            ) : (
              <>
                <Upload size={16} />
                Publish listing
              </>
            )}
          </button>
          <p className="text-center text-[10px] text-gray-600">
            You can mark it sold or remove it at any time.
          </p>
        </aside>
      </form>
    </div>
  )
}

function PublishStep({ number, title, body }) {
  return (
    <div className="flex gap-2.5">
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-emerald-400/25 bg-emerald-400/10 text-[10px] font-bold text-emerald-300">
        {number}
      </span>
      <div>
        <p className="text-[11px] font-medium text-white">{title}</p>
        <p className="text-[10px] leading-relaxed text-gray-500">{body}</p>
      </div>
    </div>
  )
}

/* ========================================================================== */
/* ORDERS                                                                     */
/* ========================================================================== */
function OrdersTab({ orders, onAction }) {
  const [filter, setFilter] = useState('all')

  const filters = [
    { value: 'all', label: 'All' },
    { value: 'pending', label: 'Pending' },
    { value: 'delivered', label: 'Delivered' },
    { value: 'completed', label: 'Completed' },
    { value: 'cancelled', label: 'Cancelled' },
  ]

  const visible = filter === 'all' ? orders : orders.filter((order) => order.status === filter)

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-white">Incoming orders</h2>
          <p className="mt-1 text-sm text-gray-500">
            {orders.filter((order) => order.status === 'pending').length} pending handover
            {orders.filter((order) => order.status === 'pending').length === 1 ? '' : 's'}
          </p>
        </div>
        <span className="badge border-white/10 bg-white/[0.03] text-gray-400">
          <ShieldCheck size={12} className="text-emerald-400" />
          Buyer details are shared only for active orders
        </span>
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        {filters.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => setFilter(option.value)}
            className={cn('chip', filter === option.value && 'chip-active')}
          >
            {option.label}
            <span className="text-[10px] opacity-60">
              {option.value === 'all'
                ? orders.length
                : orders.filter((order) => order.status === option.value).length}
            </span>
          </button>
        ))}
      </div>

      <div className="mt-5 space-y-4">
        {visible.length === 0 ? (
          <EmptyState
            icon={ShoppingBag}
            title={orders.length === 0 ? 'No orders yet' : 'Nothing in this status'}
            description={
              orders.length === 0
                ? 'When a buyer checks out, their order lands here with handover details.'
                : 'Switch filters to review the rest of your orders.'
            }
            action={
              orders.length === 0 ? (
                <Link to="/seller?tab=new" className="btn-seller">
                  <PackagePlus size={16} />
                  Create a listing
                </Link>
              ) : (
                <button type="button" onClick={() => setFilter('all')} className="btn-secondary">
                  Show all
                </button>
              )
            }
          />
        ) : (
          visible.map((order) => {
            const items = order.items ?? []
            const itemCount = items.reduce((sum, item) => sum + item.quantity, 0)

            return (
              <article key={order.id} className="glass overflow-hidden rounded-3xl">
                <div className="flex flex-wrap items-center gap-3 border-b border-white/[0.07] px-5 py-4">
                  <Avatar profile={order.buyer} size={34} />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-white">
                      {order.buyer?.full_name || order.buyer?.username || 'Buyer'}
                    </p>
                    <p className="mt-0.5 text-[10px] uppercase tracking-[0.12em] text-gray-600">
                      MH-{order.id.slice(0, 8).toUpperCase()} · {formatDateTime(order.created_at)}
                    </p>
                  </div>
                  <div className="ml-auto">
                    <StatusPill meta={ORDER_STATUS_META[order.status]} />
                  </div>
                </div>

                <ul className="divide-y divide-white/[0.06]">
                  {items.map((item) => (
                    <li key={item.id} className="flex items-center gap-3 px-5 py-3">
                      <div className="h-12 w-12 shrink-0 overflow-hidden rounded-lg border border-white/[0.08] bg-ink-800">
                        {item.listing?.image_url ? (
                          <img
                            src={item.listing.image_url}
                            alt={item.listing.title || 'Item'}
                            className="h-full w-full object-cover"
                            loading="lazy"
                          />
                        ) : (
                          <div className="grid h-full w-full place-items-center text-gray-600">
                            <Package size={16} />
                          </div>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="line-clamp-1 text-xs font-medium text-white">
                          {item.listing?.title || 'Listing removed'}
                        </p>
                        <p className="mt-0.5 text-[11px] text-gray-500">
                          {item.quantity} × {formatKES(item.price_at_purchase)}
                        </p>
                      </div>
                      <p className="text-xs font-medium text-white">
                        {formatKES(Number(item.price_at_purchase) * item.quantity)}
                      </p>
                    </li>
                  ))}
                </ul>

                <div className="grid gap-4 border-t border-white/[0.07] bg-white/[0.015] px-5 py-4 sm:grid-cols-[1fr_auto] sm:items-end">
                  <div className="space-y-1.5 text-[11px] text-gray-500">
                    {order.delivery_location ? (
                      <p className="flex items-center gap-1.5">
                        <Package size={12} className="text-emerald-300" />
                        {order.delivery_location}
                      </p>
                    ) : null}
                    {order.contact_phone ? (
                      <a
                        href={`tel:${order.contact_phone}`}
                        className="flex items-center gap-1.5 text-gray-400 transition hover:text-white"
                      >
                        <Phone size={12} className="text-gray-600" />
                        {order.contact_phone}
                      </a>
                    ) : null}
                    <p className="flex items-center gap-1.5">
                      <Clock3 size={12} className="text-gray-600" />
                      {itemCount} item{itemCount === 1 ? '' : 's'} · buyer joined{' '}
                      {formatDate(order.buyer?.created_at)}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                    <div className="mr-1 text-right">
                      <p className="text-[10px] uppercase tracking-[0.14em] text-gray-600">Total</p>
                      <p className="font-display text-lg font-semibold text-white">
                        {formatKES(order.total_amount)}
                      </p>
                    </div>

                    <Link to={`/messages?user=${order.buyer_id}`} className="btn-ghost btn-sm">
                      <MessageSquare size={13} />
                      Message
                    </Link>

                    {order.status === 'pending' ? (
                      <>
                        <button
                          type="button"
                          onClick={() => onAction(order, 'cancelled')}
                          className="btn-danger btn-sm"
                        >
                          <XCircle size={13} />
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={() => onAction(order, 'delivered')}
                          className="btn-seller btn-sm"
                        >
                          <CheckCircle2 size={13} />
                          Mark delivered
                        </button>
                      </>
                    ) : null}

                    {order.status === 'delivered' ? (
                      <span className="badge border-sky-400/20 bg-sky-400/10 text-sky-300">
                        Awaiting buyer confirmation
                      </span>
                    ) : null}
                  </div>
                </div>
              </article>
            )
          })
        )}
      </div>
    </div>
  )
}

/* ========================================================================== */
/* SUBSCRIPTION                                                               */
/* ========================================================================== */
function SubscriptionTab({
  profile,
  subscriptions,
  activeSubscription,
  pendingSubscription,
  onCreated,
}) {
  const [selectedPlan, setSelectedPlan] = useState(pendingSubscription?.plan ?? 'pro')
  const [mpesaCode, setMpesaCode] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const selected = PLAN_BY_ID[selectedPlan]

  const onSubmit = async (event) => {
    event.preventDefault()
    setError('')

    const code = mpesaCode.trim().toUpperCase()
    if (!/^[A-Z0-9]{6,20}$/.test(code)) {
      setError('Enter the M-Pesa transaction code from your confirmation SMS.')
      return
    }

    setSubmitting(true)

    const { data, error: insertError } = await supabase
      .from('subscriptions')
      .insert({
        seller_id: profile.id,
        plan: selectedPlan,
        status: 'pending',
        amount: selected.price,
        mpesa_code: code,
      })
      .select('*')
      .single()

    setSubmitting(false)

    if (insertError) {
      setError(friendlyError(insertError, 'The payment could not be submitted.'))
      return
    }

    setMpesaCode('')
    onCreated(data)
  }

  return (
    <div className="space-y-6">
      {activeSubscription ? (
        <div className="relative overflow-hidden rounded-3xl border border-amber-400/20 bg-[radial-gradient(circle_at_15%_0%,rgba(245,158,11,0.16),transparent_55%),radial-gradient(circle_at_95%_100%,rgba(236,72,153,0.08),transparent_55%)] p-6">
          <div className="flex flex-wrap items-center gap-4">
            <span className="grid h-16 w-16 place-items-center rounded-2xl border border-white/10 bg-white/[0.04]">
              <VerifiedBadge plan={activeSubscription.plan} size={38} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[10px] uppercase tracking-[0.18em] text-amber-200/70">
                Current plan
              </p>
              <h2 className="mt-1 text-2xl font-semibold text-white">
                {PLAN_BY_ID[activeSubscription.plan]?.name ?? 'Pro'} seller
              </h2>
              <p className="mt-1 text-xs text-gray-400">
                Active until {formatDate(activeSubscription.expires_at)} ·{' '}
                {Math.max(
                  0,
                  Math.ceil(
                    (new Date(activeSubscription.expires_at).getTime() - Date.now()) /
                      (1000 * 60 * 60 * 24),
                  ),
                )}{' '}
                days remaining
              </p>
            </div>
            <StatusPill meta={SUBSCRIPTION_STATUS_META.active} />
          </div>
          <p className="mt-4 max-w-2xl text-xs leading-relaxed text-gray-400">
            Your listings rank above free sellers, and the badge appears on your product cards,
            listing detail, seller studio and chat threads. Keep it live by renewing before the
            expiry date.
          </p>
        </div>
      ) : null}

      {pendingSubscription ? (
        <Alert variant="info" title="Payment under review">
          Your {PLAN_BY_ID[pendingSubscription.plan]?.name} request with M-Pesa code{' '}
          <span className="font-mono">{pendingSubscription.mpesa_code}</span> is waiting for the
          campus desk. Badges activate only after approval. You can submit a new code if this
          one was wrong.
        </Alert>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[1.25fr_1fr] lg:items-start">
        <div>
          <h2 className="text-xl font-semibold text-white">Choose your visibility</h2>
          <p className="mt-1 text-sm text-gray-500">
            Paid plans put your hustle in front of more students and add a trusted seal.
          </p>

          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            {PLANS.map((plan) => {
              const selectedPlanCard = selectedPlan === plan.id
              return (
                <button
                  key={plan.id}
                  type="button"
                  onClick={() => setSelectedPlan(plan.id)}
                  aria-pressed={selectedPlanCard}
                  className={cn(
                    'relative overflow-hidden rounded-3xl border p-5 text-left transition',
                    selectedPlanCard
                      ? cn(plan.ring, 'bg-white/[0.05]', plan.glow)
                      : 'border-white/10 bg-white/[0.02] hover:border-white/20',
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <span
                      className={cn(
                        'grid h-11 w-11 place-items-center rounded-2xl bg-gradient-to-br',
                        plan.accent,
                      )}
                    >
                      <VerifiedBadge plan={plan.id} size={24} />
                    </span>
                    {selectedPlanCard ? (
                      <span className="badge border-white/15 bg-white/[0.06] text-gray-200">
                        <CheckCircle2 size={11} />
                        Selected
                      </span>
                    ) : null}
                  </div>

                  <p className="mt-4 font-display text-lg font-semibold text-white">{plan.name}</p>
                  <p className="mt-0.5 text-[11px] text-gray-500">{plan.tagline}</p>

                  <p className="mt-3 flex items-baseline gap-1">
                    <span className="font-display text-2xl font-semibold text-white">
                      {formatKES(plan.price)}
                    </span>
                    <span className="text-[11px] text-gray-500">/ 30 days</span>
                  </p>

                  <ul className="mt-4 space-y-1.5">
                    {plan.features.map((feature) => (
                      <li key={feature} className="flex gap-1.5 text-[11px] text-gray-400">
                        <CheckCircle2 size={12} className="mt-0.5 shrink-0 text-emerald-400" />
                        {feature}
                      </li>
                    ))}
                  </ul>
                </button>
              )
            })}
          </div>

          <div className="mt-4 flex items-start gap-2.5 rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4 text-[11px] leading-relaxed text-gray-500">
            <ShieldCheck size={15} className="mt-0.5 shrink-0 text-emerald-400" />
            Plans renew manually. M-Hustle does not auto-debit. Every payment is verified by the
            campus desk before a badge is issued.
          </div>
        </div>

        <div className="glass rounded-3xl p-5 sm:p-6">
          <div className="flex items-center gap-2">
            <Banknote size={16} className="text-emerald-300" />
            <h2 className="text-sm font-semibold text-white">Pay with M-Pesa</h2>
          </div>

          <ol className="mt-4 space-y-3">
            <li className="flex gap-3">
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-white/10 bg-white/[0.04] text-[10px] font-bold text-emerald-300">
                1
              </span>
              <p className="text-xs leading-relaxed text-gray-400">
                Go to <span className="text-white">M-Pesa → Lipa na M-Pesa → Pay Bill</span>.
              </p>
            </li>
            <li className="flex gap-3">
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-white/10 bg-white/[0.04] text-[10px] font-bold text-emerald-300">
                2
              </span>
              <p className="text-xs leading-relaxed text-gray-400">
                Business number{' '}
                <span className="font-mono text-white">{MPESA_PAYBILL}</span>, account{' '}
                <span className="font-mono text-white">{MPESA_ACCOUNT}</span>.
              </p>
            </li>
            <li className="flex gap-3">
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-white/10 bg-white/[0.04] text-[10px] font-bold text-emerald-300">
                3
              </span>
              <p className="text-xs leading-relaxed text-gray-400">
                Enter <span className="text-white">{formatKES(selected.price)}</span> and paste
                the confirmation code below.
              </p>
            </li>
          </ol>

          <form onSubmit={onSubmit} className="mt-5 space-y-3">
            {error ? <Alert variant="error">{error}</Alert> : null}

            <div>
              <span className="label">Selected plan</span>
              <div className="flex items-center justify-between rounded-2xl border border-white/10 bg-black/20 px-4 py-3">
                <div className="flex items-center gap-2">
                  <VerifiedBadge plan={selectedPlan} size={18} />
                  <span className="text-sm font-medium text-white">{selected.name}</span>
                </div>
                <span className="text-sm font-semibold text-white">{formatKES(selected.price)}</span>
              </div>
            </div>

            <div>
              <label htmlFor="mpesaCode" className="label">
                M-Pesa transaction code
              </label>
              <input
                id="mpesaCode"
                type="text"
                value={mpesaCode}
                onChange={(event) => setMpesaCode(event.target.value.toUpperCase())}
                placeholder="e.g. SLK7X2Q9AB"
                maxLength={20}
                autoCapitalize="characters"
                className="input font-mono tracking-[0.12em]"
                required
              />
              <p className="field-hint">
                Found in the confirmation SMS. Each code can only be used once.
              </p>
            </div>

            <button type="submit" disabled={submitting} className="btn-seller w-full py-3">
              {submitting ? (
                <>
                  <Spinner size={16} />
                  Submitting…
                </>
              ) : (
                <>
                  <ShieldCheck size={16} />
                  Submit for approval
                </>
              )}
            </button>
          </form>

          <p className="mt-3 text-center text-[10px] leading-relaxed text-gray-600">
            Approval is usually same-day. Questions? {SUPPORT_EMAIL}
          </p>
        </div>
      </div>

      <section>
        <h2 className="text-sm font-semibold text-white">Payment history</h2>
        {subscriptions.length === 0 ? (
          <div className="mt-3 rounded-2xl border border-white/[0.07] bg-white/[0.02] p-6 text-center">
            <BadgeCheck size={22} className="mx-auto text-gray-600" />
            <p className="mt-2 text-xs text-gray-500">No subscription requests yet.</p>
          </div>
        ) : (
          <div className="glass mt-3 overflow-x-auto rounded-2xl">
            <table className="w-full min-w-[620px] text-left text-xs">
              <thead className="border-b border-white/[0.07] text-[10px] uppercase tracking-[0.14em] text-gray-600">
                <tr>
                  <th className="px-4 py-3 font-medium">Plan</th>
                  <th className="px-4 py-3 font-medium">M-Pesa code</th>
                  <th className="px-4 py-3 font-medium">Amount</th>
                  <th className="px-4 py-3 font-medium">Requested</th>
                  <th className="px-4 py-3 font-medium">Expires</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.06]">
                {subscriptions.map((subscription) => (
                  <tr key={subscription.id}>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1.5 text-white">
                        <VerifiedBadge plan={subscription.plan} size={14} />
                        {PLAN_BY_ID[subscription.plan]?.name ?? subscription.plan}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-gray-400">{subscription.mpesa_code}</td>
                    <td className="px-4 py-3 text-gray-300">{formatKES(subscription.amount)}</td>
                    <td className="px-4 py-3 text-gray-500">
                      {formatDate(subscription.created_at)}
                    </td>
                    <td className="px-4 py-3 text-gray-500">
                      {subscription.expires_at ? formatDate(subscription.expires_at) : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <StatusPill meta={SUBSCRIPTION_STATUS_META[subscription.status]} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

```

## 4.10 src/pages/AdminDashboard.jsx

```jsx
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  BadgeCheck,
  Ban,
  CheckCircle2,
  Clock3,
  ExternalLink,
  LayoutDashboard,
  Package,
  RefreshCw,
  Search,
  ShieldCheck,
  ShoppingBag,
  Store,
  Trash2,
  TrendingUp,
  UserCheck,
  Users,
  Wallet,
  XCircle,
} from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { supabase } from '../lib/supabase'
import { PLAN_BY_ID, SUPPORT_EMAIL } from '../lib/constants'
import {
  cn,
  formatDate,
  formatKES,
  friendlyError,
  LISTING_STATUS_META,
  SUBSCRIPTION_STATUS_META,
} from '../lib/utils'
import {
  Alert,
  Avatar,
  EmptyState,
  Modal,
  PageLoader,
  Spinner,
  StatCard,
  StatusPill,
} from '../components/ui'
import VerifiedBadge from '../components/VerifiedBadge'

const TABS = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'users', label: 'Users', icon: Users },
  { id: 'listings', label: 'Listings', icon: Package },
  { id: 'subscriptions', label: 'Subscriptions', icon: BadgeCheck },
]

const ROLE_STYLES = {
  admin: 'border-purple-400/25 bg-purple-400/10 text-purple-200',
  seller: 'border-emerald-400/25 bg-emerald-400/10 text-emerald-200',
  buyer: 'border-orange-400/25 bg-orange-400/10 text-orange-200',
}

const MONTH_MS = 30 * 24 * 60 * 60 * 1000

export default function AdminDashboard() {
  const { user, profile } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()

  const [stats, setStats] = useState(null)
  const [users, setUsers] = useState([])
  const [listings, setListings] = useState([])
  const [subscriptions, setSubscriptions] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [action, setAction] = useState(null)
  const [actionError, setActionError] = useState('')
  const [actionWorking, setActionWorking] = useState(false)

  const tabParam = searchParams.get('tab')
  const tab = TABS.some((item) => item.id === tabParam) ? tabParam : 'overview'

  const changeTab = (nextTab) => {
    const params = new URLSearchParams(searchParams)
    if (nextTab === 'overview') params.delete('tab')
    else params.set('tab', nextTab)
    setSearchParams(params, { replace: true })
    setSuccess('')
  }

  const refreshStats = useCallback(async () => {
    const { data } = await supabase.rpc('admin_stats')
    if (data?.[0]) setStats(data[0])
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')

    const [statsResult, usersResult, listingsResult, subscriptionResult] = await Promise.all([
      supabase.rpc('admin_stats'),
      supabase.rpc('admin_list_users'),
      supabase
        .from('listings')
        .select(
          'id, title, price, category, image_url, status, created_at, seller_id, seller:profiles!listings_seller_id_fkey(id, username, full_name, avatar_url, role)',
        )
        .order('created_at', { ascending: false }),
      supabase
        .from('subscriptions')
        .select(
          '*, seller:profiles!subscriptions_seller_id_fkey(id, username, full_name, avatar_url)',
        )
        .order('created_at', { ascending: false }),
    ])

    const loadError =
      statsResult.error ||
      usersResult.error ||
      listingsResult.error ||
      subscriptionResult.error

    if (loadError) {
      setError(loadError.message)
    } else {
      setStats(statsResult.data?.[0] ?? null)
      setUsers(usersResult.data ?? [])
      setListings(listingsResult.data ?? [])
      setSubscriptions(subscriptionResult.data ?? [])
    }

    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const pendingSubscriptions = useMemo(
    () => subscriptions.filter((subscription) => subscription.status === 'pending'),
    [subscriptions],
  )

  const openUserAction = (targetUser, type) => {
    setActionError('')
    setAction({
      kind: `user-${type}`,
      user: targetUser,
      title:
        type === 'delete'
          ? 'Delete this account?'
          : type === 'suspend'
            ? 'Suspend this account?'
            : 'Restore this account?',
      description:
        type === 'delete'
          ? 'This permanently removes the auth user and cascades their profile, listings, orders, messages and subscriptions. This cannot be undone.'
          : type === 'suspend'
            ? 'The member keeps their data but cannot create listings, place orders or send messages. They can still sign in and see the suspension notice.'
            : 'The member regains full buying, selling and messaging access immediately.',
      confirm:
        type === 'delete' ? 'Delete permanently' : type === 'suspend' ? 'Suspend' : 'Restore',
      tone: type === 'delete' || type === 'suspend' ? 'danger' : 'primary',
    })
  }

  const openListingAction = (listing, nextStatus) => {
    setActionError('')
    setAction({
      kind: 'listing',
      listing,
      nextStatus,
      title:
        nextStatus === 'deleted'
          ? 'Remove this listing from the marketplace?'
          : 'Restore this listing?',
      description:
        nextStatus === 'deleted'
          ? 'The listing disappears from the public feed and search. Existing order history is preserved because this is a soft delete.'
          : 'The listing will be visible on the public feed again, unless it belongs to a suspended seller.',
      confirm: nextStatus === 'deleted' ? 'Remove listing' : 'Restore listing',
      tone: nextStatus === 'deleted' ? 'danger' : 'primary',
    })
  }

  const openSubscriptionAction = (subscription, decision) => {
    setActionError('')
    setAction({
      kind: 'subscription',
      subscription,
      decision,
      title:
        decision === 'approve'
          ? `Approve ${PLAN_BY_ID[subscription.plan]?.name} for @${subscription.seller?.username ?? 'seller'}?`
          : 'Reject this payment request?',
      description:
        decision === 'approve'
          ? `The seller gets the ${subscription.plan === 'pro_max' ? 'gold' : 'blue'} verified badge and feed priority for 30 days. Confirm the M-Pesa code has been reconciled first.`
          : 'The request is marked expired and no badge is issued. The seller can submit a new code.',
      confirm: decision === 'approve' ? 'Approve payment' : 'Reject request',
      tone: decision === 'approve' ? 'primary' : 'danger',
    })
  }

  const runAction = async () => {
    if (!action) return
    setActionWorking(true)
    setActionError('')

    try {
      if (action.kind === 'user-suspend' || action.kind === 'user-activate') {
        const suspended = action.kind === 'user-suspend'
        const { error: rpcError } = await supabase.rpc('admin_set_suspension', {
          p_user_id: action.user.id,
          p_suspended: suspended,
        })
        if (rpcError) throw rpcError

        setUsers((current) =>
          current.map((row) =>
            row.id === action.user.id ? { ...row, is_suspended: suspended } : row,
          ),
        )
        setSuccess(`${action.user.username} was ${suspended ? 'suspended' : 'restored'}.`)
        await refreshStats()
      }

      if (action.kind === 'user-delete') {
        const { error: rpcError } = await supabase.rpc('admin_delete_user', {
          p_user_id: action.user.id,
        })
        if (rpcError) throw rpcError

        setUsers((current) => current.filter((row) => row.id !== action.user.id))
        setListings((current) => current.filter((row) => row.seller_id !== action.user.id))
        setSubscriptions((current) =>
          current.filter((row) => row.seller_id !== action.user.id),
        )
        setSuccess(`${action.user.username}'s account and marketplace data were deleted.`)
        await refreshStats()
        await load()
      }

      if (action.kind === 'listing') {
        const { error: updateError } = await supabase
          .from('listings')
          .update({ status: action.nextStatus })
          .eq('id', action.listing.id)
        if (updateError) throw updateError

        setListings((current) =>
          current.map((row) =>
            row.id === action.listing.id ? { ...row, status: action.nextStatus } : row,
          ),
        )
        setSuccess(
          action.nextStatus === 'deleted' ? 'Listing removed from the feed.' : 'Listing restored.',
        )
        await refreshStats()
      }

      if (action.kind === 'subscription') {
        const approve = action.decision === 'approve'
        const now = new Date()

        const { error: updateError } = await supabase
          .from('subscriptions')
          .update({
            status: approve ? 'active' : 'expired',
            expires_at: approve ? new Date(now.getTime() + MONTH_MS).toISOString() : now.toISOString(),
            approved_at: now.toISOString(),
          })
          .eq('id', action.subscription.id)
        if (updateError) throw updateError

        const nextStatus = approve ? 'active' : 'expired'
        const nextExpiry = approve
          ? new Date(now.getTime() + MONTH_MS).toISOString()
          : now.toISOString()

        setSubscriptions((current) =>
          current.map((row) =>
            row.id === action.subscription.id
              ? {
                  ...row,
                  status: nextStatus,
                  expires_at: nextExpiry,
                  approved_at: now.toISOString(),
                }
              : row,
          ),
        )
        setSuccess(
          approve
            ? `${PLAN_BY_ID[action.subscription.plan]?.name} badge activated for @${action.subscription.seller?.username}.`
            : 'Payment request rejected.',
        )
        await refreshStats()
      }

      setAction(null)
    } catch (actionFailure) {
      setActionError(friendlyError(actionFailure, 'The action could not be completed.'))
    } finally {
      setActionWorking(false)
    }
  }

  if (loading) {
    return <PageLoader label="Opening the admin console…" />
  }

  const pendingCount = pendingSubscriptions.length
  const activeListingCount = listings.filter((listing) => listing.status === 'active').length

  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
      {/* ------------------------------------------------------------ header */}
      <div className="relative overflow-hidden rounded-4xl border border-purple-400/15 bg-[radial-gradient(circle_at_10%_0%,rgba(139,92,246,0.18),transparent_55%),radial-gradient(circle_at_95%_100%,rgba(59,130,246,0.14),transparent_55%)] p-6 sm:p-8">
        <div className="relative flex flex-wrap items-start justify-between gap-6">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-purple-300/80">
              Admin console
            </p>
            <div className="mt-3 flex items-center gap-3">
              <span className="grid h-11 w-11 place-items-center rounded-2xl border border-white/10 bg-white/[0.05] text-purple-200">
                <ShieldCheck size={22} />
              </span>
              <div>
                <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
                  Platform control
                </h1>
                <p className="mt-1 text-xs text-gray-400">
                  Signed in as @{profile?.username} · full read and write access
                </p>
              </div>
            </div>
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-gray-400">
              Moderate listings, verify M-Pesa upgrades, manage accounts and watch the health of
              the Maseno marketplace.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            {pendingCount > 0 ? (
              <button
                type="button"
                onClick={() => changeTab('subscriptions')}
                className="btn-secondary btn-sm border-amber-400/25 bg-amber-400/[0.06] text-amber-200"
              >
                <Clock3 size={14} />
                {pendingCount} pending approval{pendingCount === 1 ? '' : 's'}
              </button>
            ) : null}
            <button type="button" onClick={() => void load()} className="btn-secondary btn-sm">
              <RefreshCw size={13} />
              Refresh
            </button>
          </div>
        </div>
      </div>

      {success ? (
        <Alert variant="success" className="mt-5" onClose={() => setSuccess('')}>
          {success}
        </Alert>
      ) : null}

      {error ? (
        <Alert variant="error" className="mt-5" title="Admin data could not load">
          {error}
          <button type="button" onClick={() => void load()} className="btn-secondary btn-sm mt-3">
            <RefreshCw size={13} />
            Retry
          </button>
        </Alert>
      ) : null}

      {/* -------------------------------------------------------------- tabs */}
      <div className="no-scrollbar mt-6 flex gap-1.5 overflow-x-auto rounded-2xl border border-white/[0.07] bg-white/[0.025] p-1.5">
        {TABS.map(({ id, label, icon: Icon }) => {
          const active = tab === id
          const count =
            id === 'users'
              ? users.length
              : id === 'listings'
                ? listings.length
                : id === 'subscriptions'
                  ? pendingCount
                  : 0

          return (
            <button
              key={id}
              type="button"
              onClick={() => changeTab(id)}
              className={cn(
                'flex shrink-0 items-center gap-2 rounded-xl px-3.5 py-2 text-xs font-medium transition',
                active
                  ? 'bg-white/[0.09] text-white shadow-sm'
                  : 'text-gray-400 hover:bg-white/[0.04] hover:text-white',
              )}
            >
              <Icon size={15} className={active ? 'text-purple-300' : 'text-gray-500'} />
              {label}
              {count > 0 ? (
                <span
                  className={cn(
                    'rounded-full px-1.5 py-0.5 text-[10px] font-semibold',
                    active ? 'bg-purple-400/15 text-purple-200' : 'bg-white/[0.06] text-gray-500',
                  )}
                >
                  {count}
                </span>
              ) : null}
            </button>
          )
        })}
      </div>

      <div className="mt-6">
        {tab === 'overview' ? (
          <OverviewTab
            stats={stats}
            users={users}
            listings={listings}
            subscriptions={subscriptions}
            pendingSubscriptions={pendingSubscriptions}
            activeListingCount={activeListingCount}
            onTab={changeTab}
          />
        ) : null}

        {tab === 'users' ? (
          <UsersTab
            users={users}
            currentUserId={user?.id}
            onAction={openUserAction}
          />
        ) : null}

        {tab === 'listings' ? (
          <ListingsTab listings={listings} onAction={openListingAction} />
        ) : null}

        {tab === 'subscriptions' ? (
          <SubscriptionsTab
            subscriptions={subscriptions}
            pendingSubscriptions={pendingSubscriptions}
            onAction={openSubscriptionAction}
          />
        ) : null}
      </div>

      <Modal
        open={Boolean(action)}
        onClose={() => {
          if (!actionWorking) setAction(null)
        }}
        title={action?.title}
        description={action?.description}
        footer={
          <>
            <button
              type="button"
              onClick={() => setAction(null)}
              disabled={actionWorking}
              className="btn-secondary"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={runAction}
              disabled={actionWorking}
              className={action?.tone === 'danger' ? 'btn-danger' : 'btn-admin'}
            >
              {actionWorking ? (
                <>
                  <Spinner size={15} />
                  Working…
                </>
              ) : (
                action?.confirm
              )}
            </button>
          </>
        }
      >
        {actionError ? <Alert variant="error">{actionError}</Alert> : null}

        {action?.kind === 'user-delete' ? (
          <div className="rounded-2xl border border-red-500/20 bg-red-500/[0.06] p-4 text-xs leading-relaxed text-red-200">
            Deleting <span className="font-semibold">@{action.user.username}</span> cannot be
            undone. Consider suspending the account instead if you only need to stop activity.
          </div>
        ) : null}

        {action?.kind === 'subscription' ? (
          <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-xs">
            <div className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2 text-white">
                <VerifiedBadge plan={action.subscription.plan} size={16} />
                {PLAN_BY_ID[action.subscription.plan]?.name}
              </span>
              <span className="text-gray-400">{formatKES(action.subscription.amount)}</span>
            </div>
            <p className="mt-2 font-mono text-[11px] text-gray-500">
              Code {action.subscription.mpesa_code} · requested{' '}
              {formatDate(action.subscription.created_at)}
            </p>
          </div>
        ) : null}

        {action?.kind === 'listing' ? (
          <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-xs">
            <p className="text-sm font-medium text-white">{action.listing.title}</p>
            <p className="mt-1 text-gray-500">
              {formatKES(action.listing.price)} · @{action.listing.seller?.username} ·{' '}
              {LISTING_STATUS_META[action.listing.status]?.label}
            </p>
          </div>
        ) : null}
      </Modal>
    </div>
  )
}

/* ========================================================================== */
/* OVERVIEW                                                                   */
/* ========================================================================== */
function OverviewTab({
  stats,
  users,
  listings,
  subscriptions,
  pendingSubscriptions,
  activeListingCount,
  onTab,
}) {
  const recentUsers = users.slice(0, 5)
  const recentListings = listings.slice(0, 5)

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          icon={Wallet}
          label="Gross sales"
          value={formatKES(stats?.total_revenue ?? 0)}
          hint="Delivered and completed orders"
          accent="green"
        />
        <StatCard
          icon={ShoppingBag}
          label="Total orders"
          value={Number(stats?.total_orders ?? 0).toLocaleString('en-KE')}
          hint="All statuses, all time"
          accent="orange"
        />
        <StatCard
          icon={Users}
          label="Active users"
          value={Number(stats?.active_users ?? 0).toLocaleString('en-KE')}
          hint="Members not suspended"
          accent="purple"
        />
        <StatCard
          icon={Store}
          label="Active listings"
          value={Number(stats?.active_listings ?? activeListingCount).toLocaleString('en-KE')}
          hint={`${listings.filter((listing) => listing.status === 'sold').length} sold all-time`}
          accent="amber"
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.3fr_1fr]">
        <section className="glass overflow-hidden rounded-3xl">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.07] px-5 py-4">
            <div>
              <h2 className="text-sm font-semibold text-white">Subscription approvals</h2>
              <p className="mt-0.5 text-[11px] text-gray-500">
                {pendingSubscriptions.length} request
                {pendingSubscriptions.length === 1 ? '' : 's'} waiting for review
              </p>
            </div>
            <button
              type="button"
              onClick={() => onTab('subscriptions')}
              className="text-[11px] font-medium text-purple-300 transition hover:text-purple-200"
            >
              Open queue
            </button>
          </div>

          {pendingSubscriptions.length === 0 ? (
            <div className="px-5 py-10 text-center">
              <CheckCircle2 size={22} className="mx-auto text-emerald-400" />
              <p className="mt-3 text-sm text-gray-300">No pending payments</p>
              <p className="mt-1 text-xs text-gray-600">
                Every M-Pesa code has been reviewed.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-white/[0.06]">
              {pendingSubscriptions.slice(0, 5).map((subscription) => (
                <li key={subscription.id} className="flex items-center gap-3 px-5 py-3.5">
                  <Avatar profile={subscription.seller} size={32} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-white">
                      {subscription.seller?.full_name || 'Seller'}
                    </p>
                    <p className="mt-0.5 text-[11px] text-gray-500">
                      {PLAN_BY_ID[subscription.plan]?.name} · {formatKES(subscription.amount)} ·{' '}
                      {formatDate(subscription.created_at)}
                    </p>
                  </div>
                  <span className="rounded-full border border-amber-400/20 bg-amber-400/10 px-2 py-1 text-[10px] font-medium text-amber-200">
                    Pending
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="glass rounded-3xl p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white">Platform snapshot</h2>
            <TrendingUp size={16} className="text-purple-300" />
          </div>

          <dl className="mt-4 space-y-3 text-xs">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-gray-500">Pending subscriptions</dt>
              <dd className="font-semibold text-amber-300">
                {Number(stats?.pending_subscriptions ?? pendingSubscriptions.length)}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-gray-500">Suspended accounts</dt>
              <dd className="font-semibold text-white">
                {users.filter((row) => row.is_suspended).length}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-gray-500">Sellers</dt>
              <dd className="font-semibold text-white">
                {users.filter((row) => row.role === 'seller').length}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-gray-500">Paid subscriptions</dt>
              <dd className="font-semibold text-white">
                {subscriptions.filter((row) => row.status === 'active').length}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-gray-500">Removed listings</dt>
              <dd className="font-semibold text-white">
                {listings.filter((row) => row.status === 'deleted').length}
              </dd>
            </div>
          </dl>

          <div className="mt-5 grid gap-2">
            <button
              type="button"
              onClick={() => onTab('users')}
              className="flex items-center gap-2 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2.5 text-left text-xs text-gray-300 transition hover:border-white/15 hover:text-white"
            >
              <Users size={14} className="text-purple-300" />
              Manage accounts
              <ExternalLink size={12} className="ml-auto text-gray-600" />
            </button>
            <button
              type="button"
              onClick={() => onTab('listings')}
              className="flex items-center gap-2 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2.5 text-left text-xs text-gray-300 transition hover:border-white/15 hover:text-white"
            >
              <Package size={14} className="text-orange-300" />
              Moderate listings
              <ExternalLink size={12} className="ml-auto text-gray-600" />
            </button>
          </div>
        </section>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <section className="glass overflow-hidden rounded-3xl">
          <div className="flex items-center justify-between border-b border-white/[0.07] px-5 py-3.5">
            <h2 className="text-sm font-semibold text-white">Newest members</h2>
            <button
              type="button"
              onClick={() => onTab('users')}
              className="text-[11px] text-purple-300 hover:text-purple-200"
            >
              All users
            </button>
          </div>
          <ul className="divide-y divide-white/[0.06]">
            {recentUsers.map((member) => (
              <li key={member.id} className="flex items-center gap-3 px-5 py-3">
                <Avatar profile={member} size={30} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium text-white">
                    {member.full_name}
                    {member.is_suspended ? (
                      <span className="ml-1.5 text-[10px] text-red-300">suspended</span>
                    ) : null}
                  </p>
                  <p className="truncate text-[11px] text-gray-500">@{member.username}</p>
                </div>
                <span className={cn('badge', ROLE_STYLES[member.role])}>{member.role}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="glass overflow-hidden rounded-3xl">
          <div className="flex items-center justify-between border-b border-white/[0.07] px-5 py-3.5">
            <h2 className="text-sm font-semibold text-white">Latest listings</h2>
            <button
              type="button"
              onClick={() => onTab('listings')}
              className="text-[11px] text-purple-300 hover:text-purple-200"
            >
              Moderate
            </button>
          </div>
          <ul className="divide-y divide-white/[0.06]">
            {recentListings.map((listing) => (
              <li key={listing.id} className="flex items-center gap-3 px-5 py-3">
                <div className="h-9 w-9 shrink-0 overflow-hidden rounded-lg border border-white/[0.08] bg-ink-800">
                  {listing.image_url ? (
                    <img
                      src={listing.image_url}
                      alt=""
                      className="h-full w-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <div className="grid h-full w-full place-items-center text-gray-600">
                      <Package size={14} />
                    </div>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium text-white">{listing.title}</p>
                  <p className="truncate text-[11px] text-gray-500">
                    @{listing.seller?.username} · {formatKES(listing.price)}
                  </p>
                </div>
                <StatusPill meta={LISTING_STATUS_META[listing.status]} />
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  )
}

/* ========================================================================== */
/* USERS                                                                      */
/* ========================================================================== */
function UsersTab({ users, currentUserId, onAction }) {
  const [query, setQuery] = useState('')
  const [role, setRole] = useState('all')

  const visible = useMemo(() => {
    const term = query.trim().toLowerCase()
    return users.filter((member) => {
      const matchesRole = role === 'all' || member.role === role
      const matchesQuery =
        !term ||
        member.full_name?.toLowerCase().includes(term) ||
        member.username?.toLowerCase().includes(term) ||
        member.email?.toLowerCase().includes(term) ||
        member.phone?.toLowerCase().includes(term)
      return matchesRole && matchesQuery
    })
  }, [users, query, role])

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-white">Users</h2>
          <p className="mt-1 text-sm text-gray-500">
            {users.length} accounts · {users.filter((row) => row.is_suspended).length} suspended
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <div className="relative">
            <Search
              size={14}
              className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-500"
            />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search name, email, phone…"
              className="input h-10 w-64 py-2 pl-9 text-xs"
            />
          </div>
          <select
            value={role}
            onChange={(event) => setRole(event.target.value)}
            className="select h-10 w-32 py-2 text-xs"
            aria-label="Filter by role"
          >
            <option value="all">All roles</option>
            <option value="admin">Admin</option>
            <option value="seller">Seller</option>
            <option value="buyer">Buyer</option>
          </select>
        </div>
      </div>

      <div className="mt-3 flex items-start gap-2.5 rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4 text-[11px] leading-relaxed text-gray-500">
        <ShieldCheck size={15} className="mt-0.5 shrink-0 text-purple-300" />
        Suspension blocks new listings, purchases and messages without deleting data. Deleting an
        account removes the auth user and cascades all marketplace records — use it only for
        serious violations.
      </div>

      <div className="glass mt-5 overflow-x-auto rounded-2xl">
        {visible.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No matching members"
            description="Adjust the search or role filter to find the account you need."
            className="border-0 bg-transparent"
          />
        ) : (
          <table className="w-full min-w-[860px] text-left text-xs">
            <thead className="border-b border-white/[0.07] text-[10px] uppercase tracking-[0.14em] text-gray-600">
              <tr>
                <th className="px-4 py-3 font-medium">Member</th>
                <th className="px-4 py-3 font-medium">Role</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Joined</th>
                <th className="px-4 py-3 font-medium">Last sign-in</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.06]">
              {visible.map((member) => {
                const isSelf = member.id === currentUserId
                return (
                  <tr key={member.id} className="transition hover:bg-white/[0.02]">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <Avatar profile={member} size={34} />
                        <div className="min-w-0">
                          <p className="flex items-center gap-1.5 text-xs font-medium text-white">
                            <span className="truncate">{member.full_name}</span>
                            {isSelf ? (
                              <span className="rounded-full bg-white/[0.06] px-1.5 py-0.5 text-[9px] text-gray-400">
                                You
                              </span>
                            ) : null}
                          </p>
                          <p className="truncate text-[11px] text-gray-500">
                            @{member.username} · {member.email}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={cn('badge capitalize', ROLE_STYLES[member.role])}>
                        {member.role}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {member.is_suspended ? (
                        <span className="badge border-red-400/25 bg-red-400/10 text-red-300">
                          <Ban size={11} />
                          Suspended
                        </span>
                      ) : (
                        <span className="badge border-emerald-400/25 bg-emerald-400/10 text-emerald-300">
                          <UserCheck size={11} />
                          Active
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-500">{formatDate(member.created_at)}</td>
                    <td className="px-4 py-3 text-gray-500">
                      {member.last_sign_in_at ? formatDate(member.last_sign_in_at) : 'Never'}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1.5">
                        {!isSelf ? (
                          <>
                            <button
                              type="button"
                              onClick={() =>
                                onAction(
                                  member,
                                  member.is_suspended ? 'activate' : 'suspend',
                                )
                              }
                              className="btn-secondary btn-sm"
                            >
                              {member.is_suspended ? (
                                <>
                                  <UserCheck size={12} />
                                  Restore
                                </>
                              ) : (
                                <>
                                  <Ban size={12} />
                                  Suspend
                                </>
                              )}
                            </button>
                            <button
                              type="button"
                              onClick={() => onAction(member, 'delete')}
                              className="grid h-8 w-8 place-items-center rounded-full border border-red-500/20 bg-red-500/[0.06] text-red-300 transition hover:border-red-500/40 hover:bg-red-500/15"
                              aria-label={`Delete ${member.username}`}
                            >
                              <Trash2 size={13} />
                            </button>
                          </>
                        ) : (
                          <span className="text-[10px] text-gray-600">Protected</span>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

/* ========================================================================== */
/* LISTINGS                                                                   */
/* ========================================================================== */
function ListingsTab({ listings, onAction }) {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')

  const visible = useMemo(() => {
    const term = query.trim().toLowerCase()
    return listings.filter((listing) => {
      const matchesStatus = status === 'all' || listing.status === status
      const matchesQuery =
        !term ||
        listing.title?.toLowerCase().includes(term) ||
        listing.category?.toLowerCase().includes(term) ||
        listing.seller?.username?.toLowerCase().includes(term) ||
        listing.seller?.full_name?.toLowerCase().includes(term)
      return matchesStatus && matchesQuery
    })
  }, [listings, query, status])

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-white">Listings</h2>
          <p className="mt-1 text-sm text-gray-500">
            {listings.filter((listing) => listing.status === 'active').length} active ·{' '}
            {listings.filter((listing) => listing.status === 'deleted').length} removed
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <div className="relative">
            <Search
              size={14}
              className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-500"
            />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search listings or sellers…"
              className="input h-10 w-64 py-2 pl-9 text-xs"
            />
          </div>
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value)}
            className="select h-10 w-32 py-2 text-xs"
            aria-label="Filter by listing status"
          >
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="sold">Sold</option>
            <option value="deleted">Removed</option>
          </select>
        </div>
      </div>

      <div className="glass mt-5 overflow-x-auto rounded-2xl">
        {visible.length === 0 ? (
          <EmptyState
            icon={Package}
            title="No listings match"
            description="Try another search or status filter."
            className="border-0 bg-transparent"
          />
        ) : (
          <table className="w-full min-w-[880px] text-left text-xs">
            <thead className="border-b border-white/[0.07] text-[10px] uppercase tracking-[0.14em] text-gray-600">
              <tr>
                <th className="px-4 py-3 font-medium">Listing</th>
                <th className="px-4 py-3 font-medium">Seller</th>
                <th className="px-4 py-3 font-medium">Category</th>
                <th className="px-4 py-3 font-medium">Price</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Listed</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.06]">
              {visible.map((listing) => (
                <tr key={listing.id} className="transition hover:bg-white/[0.02]">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="h-10 w-10 shrink-0 overflow-hidden rounded-lg border border-white/[0.08] bg-ink-800">
                        {listing.image_url ? (
                          <img
                            src={listing.image_url}
                            alt=""
                            className="h-full w-full object-cover"
                            loading="lazy"
                          />
                        ) : (
                          <div className="grid h-full w-full place-items-center text-gray-600">
                            <Package size={14} />
                          </div>
                        )}
                      </div>
                      <Link
                        to={`/product/${listing.id}`}
                        className="max-w-[220px] truncate text-xs font-medium text-white transition hover:text-purple-200"
                      >
                        {listing.title}
                      </Link>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-gray-400">
                    @{listing.seller?.username ?? 'unknown'}
                  </td>
                  <td className="px-4 py-3 text-gray-500">{listing.category}</td>
                  <td className="px-4 py-3 font-medium text-white">
                    {formatKES(listing.price)}
                  </td>
                  <td className="px-4 py-3">
                    <StatusPill meta={LISTING_STATUS_META[listing.status]} />
                  </td>
                  <td className="px-4 py-3 text-gray-500">{formatDate(listing.created_at)}</td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1.5">
                      <Link to={`/product/${listing.id}`} className="btn-ghost btn-sm">
                        View
                      </Link>
                      {listing.status !== 'deleted' ? (
                        <button
                          type="button"
                          onClick={() => onAction(listing, 'deleted')}
                          className="btn-danger btn-sm"
                        >
                          <Trash2 size={12} />
                          Remove
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => onAction(listing, 'active')}
                          className="btn-secondary btn-sm"
                        >
                          <RefreshCw size={12} />
                          Restore
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

/* ========================================================================== */
/* SUBSCRIPTIONS                                                              */
/* ========================================================================== */
function SubscriptionsTab({ subscriptions, pendingSubscriptions, onAction }) {
  const [historyFilter, setHistoryFilter] = useState('all')

  const history =
    historyFilter === 'all'
      ? subscriptions
      : subscriptions.filter((subscription) => subscription.status === historyFilter)

  return (
    <div className="space-y-6">
      <div>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold text-white">Approval queue</h2>
            <p className="mt-1 text-sm text-gray-500">
              Confirm each M-Pesa code against your statement before approving.
            </p>
          </div>
          <span className="badge border-amber-400/25 bg-amber-400/10 text-amber-200">
            <Clock3 size={12} />
            {pendingSubscriptions.length} pending
          </span>
        </div>

        {pendingSubscriptions.length === 0 ? (
          <div className="mt-4 flex items-center gap-3 rounded-3xl border border-emerald-400/15 bg-emerald-400/[0.04] p-5">
            <span className="grid h-10 w-10 place-items-center rounded-xl border border-emerald-400/20 bg-emerald-400/10 text-emerald-300">
              <CheckCircle2 size={18} />
            </span>
            <div>
              <p className="text-sm font-medium text-white">The queue is clear</p>
              <p className="mt-0.5 text-xs text-gray-500">
                New Pro and Pro Max payments will appear here instantly.
              </p>
            </div>
          </div>
        ) : (
          <div className="mt-4 grid gap-3">
            {pendingSubscriptions.map((subscription) => {
              const plan = PLAN_BY_ID[subscription.plan]
              return (
                <div
                  key={subscription.id}
                  className="glass flex flex-col gap-4 rounded-3xl p-5 lg:flex-row lg:items-center"
                >
                  <div className="flex items-center gap-3 lg:w-64">
                    <Avatar profile={subscription.seller} size={40} />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-white">
                        {subscription.seller?.full_name || 'Seller'}
                      </p>
                      <p className="truncate text-[11px] text-gray-500">
                        @{subscription.seller?.username} · requested{' '}
                        {formatDate(subscription.created_at)}
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-1 flex-wrap items-center gap-3">
                    <span
                      className={cn(
                        'inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold',
                        subscription.plan === 'pro_max'
                          ? 'border-amber-400/25 bg-amber-400/10 text-amber-200'
                          : 'border-blue-400/25 bg-blue-400/10 text-blue-200',
                      )}
                    >
                      <VerifiedBadge plan={subscription.plan} size={15} />
                      {plan?.name}
                    </span>
                    <div>
                      <p className="text-[10px] uppercase tracking-[0.12em] text-gray-600">
                        Amount
                      </p>
                      <p className="text-sm font-semibold text-white">
                        {formatKES(subscription.amount)}
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-[0.12em] text-gray-600">
                        M-Pesa code
                      </p>
                      <p className="font-mono text-sm text-gray-200">
                        {subscription.mpesa_code}
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2 lg:justify-end">
                    <button
                      type="button"
                      onClick={() => onAction(subscription, 'reject')}
                      className="btn-danger btn-sm"
                    >
                      <XCircle size={13} />
                      Reject
                    </button>
                    <button
                      type="button"
                      onClick={() => onAction(subscription, 'approve')}
                      className="btn-admin btn-sm"
                    >
                      <CheckCircle2 size={13} />
                      Approve
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <section>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-white">All payment requests</h2>
          <select
            value={historyFilter}
            onChange={(event) => setHistoryFilter(event.target.value)}
            className="select h-9 w-40 py-1.5 text-xs"
            aria-label="Filter subscriptions by status"
          >
            <option value="all">All statuses</option>
            <option value="pending">Pending</option>
            <option value="active">Active</option>
            <option value="expired">Expired</option>
          </select>
        </div>

        <div className="glass mt-3 overflow-x-auto rounded-2xl">
          {history.length === 0 ? (
            <EmptyState
              icon={BadgeCheck}
              title="No payment requests"
              description="When a seller submits an M-Pesa code it will appear here."
              className="border-0 bg-transparent"
            />
          ) : (
            <table className="w-full min-w-[820px] text-left text-xs">
              <thead className="border-b border-white/[0.07] text-[10px] uppercase tracking-[0.14em] text-gray-600">
                <tr>
                  <th className="px-4 py-3 font-medium">Seller</th>
                  <th className="px-4 py-3 font-medium">Plan</th>
                  <th className="px-4 py-3 font-medium">Amount</th>
                  <th className="px-4 py-3 font-medium">M-Pesa code</th>
                  <th className="px-4 py-3 font-medium">Requested</th>
                  <th className="px-4 py-3 font-medium">Expires</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.06]">
                {history.map((subscription) => (
                  <tr key={subscription.id} className="transition hover:bg-white/[0.02]">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <Avatar profile={subscription.seller} size={26} />
                        <span className="text-gray-300">
                          @{subscription.seller?.username ?? 'unknown'}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1.5 text-white">
                        <VerifiedBadge plan={subscription.plan} size={13} />
                        {PLAN_BY_ID[subscription.plan]?.name}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-300">
                      {formatKES(subscription.amount)}
                    </td>
                    <td className="px-4 py-3 font-mono text-gray-500">
                      {subscription.mpesa_code}
                    </td>
                    <td className="px-4 py-3 text-gray-500">
                      {formatDate(subscription.created_at)}
                    </td>
                    <td className="px-4 py-3 text-gray-500">
                      {subscription.expires_at ? formatDate(subscription.expires_at) : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <StatusPill meta={SUBSCRIPTION_STATUS_META[subscription.status]} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <div className="flex items-start gap-2.5 rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4 text-[11px] leading-relaxed text-gray-500">
        <ShieldCheck size={15} className="mt-0.5 shrink-0 text-purple-300" />
        Badges are issued for 30 days from approval. Expired subscriptions stop granting feed
        priority immediately. Questions about reconciliation? {SUPPORT_EMAIL}
      </div>
    </div>
  )
}

```

## 4.11 src/pages/NotFound.jsx

```jsx
import { Link } from 'react-router-dom'
import { ArrowLeft, Compass } from 'lucide-react'

export default function NotFound() {
  return (
    <div className="mx-auto flex min-h-[70vh] max-w-lg flex-col items-center justify-center px-4 text-center">
      <span className="grid h-16 w-16 place-items-center rounded-3xl border border-white/10 bg-white/[0.04] text-orange-300">
        <Compass size={30} />
      </span>
      <p className="mt-6 font-display text-5xl font-bold gradient-text">404</p>
      <h1 className="mt-3 text-2xl font-semibold text-white">This page is off campus</h1>
      <p className="mt-2 text-sm leading-relaxed text-gray-400">
        The link may be broken, or the listing was sold and taken down. Head back to the
        marketplace to keep browsing.
      </p>
      <Link to="/" className="btn-primary mt-7">
        <ArrowLeft size={16} />
        Back to marketplace
      </Link>
    </div>
  )
}

```

## 4.12 src/pages/EditProfile.jsx

```jsx
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowLeft,
  AtSign,
  Check,
  Loader2,
  Mail,
  MapPin,
  Phone,
  Save,
  ShieldCheck,
  UserRound,
} from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { supabase } from '../lib/supabase'
import { HOSTELS } from '../lib/constants'
import { cn, friendlyError } from '../lib/utils'
import { Alert, Avatar, Spinner } from '../components/ui'

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/

export default function EditProfile() {
  const { profile, updateProfile } = useAuth()

  const [form, setForm] = useState({
    full_name: profile?.full_name ?? '',
    username: profile?.username ?? '',
    phone: profile?.phone ?? '',
    location: profile?.location ?? '',
  })
  const [usernameStatus, setUsernameStatus] = useState({ state: 'idle', message: '' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const update = (field) => (event) => {
    setForm((current) => ({ ...current, [field]: event.target.value }))
    setSuccess('')
  }

  useEffect(() => {
    const username = form.username.trim().toLowerCase()

    if (!username || username === profile?.username) {
      setUsernameStatus({ state: 'idle', message: '' })
      return undefined
    }

    if (!USERNAME_RE.test(username)) {
      setUsernameStatus({
        state: 'invalid',
        message: '3–20 characters: letters, numbers and underscores only.',
      })
      return undefined
    }

    setUsernameStatus({ state: 'checking', message: 'Checking availability…' })
    let cancelled = false

    const timer = setTimeout(async () => {
      const { data, error: lookupError } = await supabase.rpc('is_username_available', {
        p_username: username,
      })

      if (cancelled) return

      if (lookupError) {
        setUsernameStatus({ state: 'error', message: 'Could not verify that username.' })
        return
      }

      setUsernameStatus(
        data
          ? { state: 'available', message: 'Username is available.' }
          : { state: 'taken', message: 'That username is already taken.' },
      )
    }, 450)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [form.username, profile?.username])

  const onSubmit = async (event) => {
    event.preventDefault()
    setError('')
    setSuccess('')

    const fullName = form.full_name.trim()
    const username = form.username.trim().toLowerCase()
    const phone = form.phone.trim()

    if (fullName.length < 2) {
      setError('Enter your full name.')
      return
    }
    if (!USERNAME_RE.test(username)) {
      setError('Choose a username with 3–20 letters, numbers or underscores.')
      return
    }
    if (usernameStatus.state === 'checking') {
      setError('Give us a second while we check that username.')
      return
    }
    if (usernameStatus.state === 'taken') {
      setError('That username is already taken.')
      return
    }
    if (phone && !/^\+?[0-9]{9,15}$/.test(phone.replace(/\s+/g, ''))) {
      setError('Enter a valid phone number, for example 0712 345 678.')
      return
    }
    if (form.location && !HOSTELS.includes(form.location)) {
      setError('Choose a hostel from the list.')
      return
    }

    setSaving(true)
    const { error: saveError } = await updateProfile({
      full_name: fullName,
      username,
      phone: phone.replace(/\s+/g, '') || null,
      location: form.location || null,
    })
    setSaving(false)

    if (saveError) {
      setError(friendlyError(saveError, 'Your profile could not be saved.'))
      return
    }

    setSuccess('Profile updated.')
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <Link
        to="/"
        className="inline-flex items-center gap-1.5 text-xs text-gray-400 transition hover:text-white"
      >
        <ArrowLeft size={14} />
        Back to marketplace
      </Link>

      <div className="mt-5">
        <p className="eyebrow">Your account</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
          Edit profile
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-gray-400">
          Keep your name, username and hostel current so buyers know where to meet you.
        </p>
      </div>

      <form onSubmit={onSubmit} className="mt-7 space-y-5">
        {error ? <Alert variant="error">{error}</Alert> : null}
        {success ? <Alert variant="success">{success}</Alert> : null}

        <section className="glass rounded-3xl p-5 sm:p-7">
          <div className="flex flex-wrap items-center gap-4 border-b border-white/[0.07] pb-5">
            <Avatar profile={profile} size={56} />
            <div className="min-w-0 flex-1">
              <p className="text-base font-semibold text-white">{profile?.full_name}</p>
              <p className="text-xs text-gray-500">@{profile?.username}</p>
            </div>
            <span className="badge border-white/10 bg-white/[0.04] capitalize text-gray-300">
              <ShieldCheck size={12} className="text-emerald-400" />
              {profile?.role}
            </span>
          </div>

          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="fullName" className="label">
                Full name
              </label>
              <div className="relative">
                <UserRound
                  size={16}
                  className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-gray-500"
                />
                <input
                  id="fullName"
                  type="text"
                  value={form.full_name}
                  onChange={update('full_name')}
                  className="input pl-11"
                  maxLength={80}
                  required
                />
              </div>
            </div>

            <div>
              <label htmlFor="username" className="label">
                Username
              </label>
              <div className="relative">
                <AtSign
                  size={16}
                  className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-gray-500"
                />
                <input
                  id="username"
                  type="text"
                  value={form.username}
                  onChange={update('username')}
                  className={cn(
                    'input pl-10',
                    (usernameStatus.state === 'taken' ||
                      usernameStatus.state === 'invalid') &&
                      'input-error',
                  )}
                  maxLength={20}
                  required
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2">
                  {usernameStatus.state === 'checking' ? (
                    <Loader2 size={15} className="animate-spin text-gray-500" />
                  ) : usernameStatus.state === 'available' ? (
                    <Check size={16} className="text-emerald-400" />
                  ) : null}
                </span>
              </div>
              {usernameStatus.message ? (
                <p
                  className={cn(
                    'mt-1.5 text-xs',
                    usernameStatus.state === 'available'
                      ? 'text-emerald-400'
                      : usernameStatus.state === 'taken' ||
                          usernameStatus.state === 'invalid'
                        ? 'text-red-400'
                        : 'text-gray-500',
                  )}
                >
                  {usernameStatus.message}
                </p>
              ) : (
                <p className="field-hint">Changing this changes how buyers find you.</p>
              )}
            </div>

            <div>
              <label htmlFor="phone" className="label">
                Phone
              </label>
              <div className="relative">
                <Phone
                  size={16}
                  className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-gray-500"
                />
                <input
                  id="phone"
                  type="tel"
                  value={form.phone}
                  onChange={update('phone')}
                  placeholder="0712 345 678"
                  className="input pl-11"
                  autoComplete="tel"
                />
              </div>
            </div>

            <div>
              <label htmlFor="location" className="label">
                Hostel / residence
              </label>
              <div className="relative">
                <MapPin
                  size={16}
                  className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-gray-500"
                />
                <select
                  id="location"
                  value={form.location}
                  onChange={update('location')}
                  className="select pl-11"
                >
                  <option value="">Select your hostel</option>
                  {HOSTELS.map((hostel) => (
                    <option key={hostel} value={hostel}>
                      {hostel}
                    </option>
                  ))}
                </select>
              </div>
              <p className="field-hint">Shown on your seller card to help with handover.</p>
            </div>

            <div className="sm:col-span-2">
              <label htmlFor="email" className="label">
                Email
              </label>
              <div className="relative">
                <Mail
                  size={16}
                  className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-gray-600"
                />
                <input
                  id="email"
                  type="email"
                  value={profile?.email ?? ''}
                  readOnly
                  className="input cursor-not-allowed pl-11 text-gray-500"
                />
              </div>
              <p className="field-hint">Email is managed by Supabase Auth and cannot change here.</p>
            </div>
          </div>

          <div className="mt-6 flex flex-wrap gap-2 border-t border-white/[0.07] pt-5">
            <button type="submit" disabled={saving} className="btn-primary">
              {saving ? (
                <>
                  <Spinner size={15} />
                  Saving…
                </>
              ) : (
                <>
                  <Save size={15} />
                  Save changes
                </>
              )}
            </button>
            <Link to="/" className="btn-secondary">
              Cancel
            </Link>
          </div>
        </section>
      </form>
    </div>
  )
}

```

---

# SECTION 5 — Deployment, security and verification

## 5.1 Deployment files

### `vercel.json`

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "framework": "vite",
  "buildCommand": "npm run build",
  "outputDirectory": "dist",
  "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }]
}

```

### `netlify.toml`

```toml
[build]
  command = "npm run build"
  publish = "dist"

[[redirects]]
  from = "/*"
  to = "/index.html"
  status = 200

```

### `.gitignore`

```text
# Dependencies
node_modules
.pnp
.pnp.js

# Build output
dist
dist-ssr

# Local tooling caches (created by this workspace)
.npm-cache
.tmp

# Local environment — never commit real Supabase keys
.env
.env.local
.env.*.local

# Editor / OS
.vscode/*
!.vscode/extensions.json
.idea
.DS_Store
Thumbs.db
*.suo
*.ntvs*
*.njsproj
*.sln
*.sw?

# Logs
logs
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*
pnpm-debug.log*

```

## 5.2 Deploy

```bash
npm install
npm run build
npm run preview
```

- Vercel: import the repository, add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`,
  and deploy. The rewrite in `vercel.json` makes `/product/:id`, `/seller`, `/admin` and
  `/messages` work on a hard refresh.
- Netlify: `netlify.toml` sets the build command and SPA redirect.
- Add the production origin to Supabase Auth URL Configuration.
- Never add the service-role key to these environment variables.

## 5.3 Security highlights

- RLS is enabled on all seven tables; there is no unprotected table.
- Checkout totals are computed in `create_order()` from live listing prices, and stock is validated
  and reserved atomically. A tampered client cannot change the amount or oversell an item.
- Roles, suspension flags and profile email can only be changed by an admin or by the service role.
  A trigger blocks privilege escalation even with a hand-crafted update.
- Order participants, totals and creation time are immutable.
- Message bodies, senders, receivers and listing context are immutable; receivers can only flip
  `is_read`.
- Reviews are accepted only from the buyer of a completed order, one per order. Public rating
  aggregates expose no buyer identity.
- `profiles.email` and `profiles.phone` are hidden from broad table reads using column-level
  grants. The owner reads them through `get_my_profile()`; admins through `admin_list_users()`.
- M-Pesa codes are unique and visible only to the seller and admins.
- Suspended sellers disappear from the public feed, cannot create listings, cannot receive orders,
  and cannot upload images.
- The storage bucket accepts only 5 MB images of four MIME types, inside the uploader's UID folder.

## 5.4 Verification record

Performed in this workspace:

| Check | Result |
| --- | --- |
| `npm run build` | Passed — 1,945 modules transformed |
| Entry bundle | ~123 kB (34 kB gzip) plus cached React/Supabase vendor chunks |
| Route code splitting | Product, Cart, Checkout, Orders, Messages, Seller, Admin, Profile, 404 are lazy |
| JSX binding audit | 27 source files, all JSX components bound |
| Identifier audit | No unbound identifiers |
| Emoji audit | No emoji/surrogate characters in UI source |
| Unused import audit | None |
| Live Supabase connectivity | 200 from `profiles`, `listings` and `get_seller_badges` using the anon key |
| Live RLS check | `profiles.email` read blocked (42501); `admin_stats()` blocked for anon (42501) |
| Live page render | Headless Chrome rendered `/register` and `/` with no connectivity alert |
| Email confirmation | Hosted project reports `mailer_autoconfirm: true` (verification disabled) |
| Username login | Installed and responding on the hosted project |
| Migration 002 | Included; run it on the hosted project before opening the quantity/rating screens |

The connected project responded successfully with the corrected URL
`https://fyfrotzpvovusqpbookw.supabase.co`. The base schema and username login are live; migration
002 (quantities, reviews, locations) must be run once before the new screens can query those
columns. The UI has no mock data and no offline fallback; with missing or placeholder credentials
it deliberately shows a setup screen instead of fake listings.

## 5.5 Source tree

```text
m-hustle/
├── index.html
├── package.json
├── package-lock.json
├── postcss.config.js
├── tailwind.config.js
├── vite.config.js
├── vercel.json
├── netlify.toml
├── .env.example
├── .gitignore
├── README.md
├── BLUEPRINT.md
├── scripts/
│   └── build-blueprint.mjs
├── supabase/
│   ├── schema.sql
│   └── migrations/
│       ├── 001_username_login.sql
│       └── 002_quantities_reviews_profile.sql
└── src/
    ├── main.jsx
    ├── App.jsx
    ├── index.css
    ├── components/
    │   ├── AuthShell.jsx
    │   ├── Footer.jsx
    │   ├── ListingCard.jsx
    │   ├── Navbar.jsx
    │   ├── ProtectedRoute.jsx
    │   ├── ScrollToTop.jsx
    │   ├── VerifiedBadge.jsx
    │   └── ui.jsx
    ├── context/
    │   └── CartContext.jsx
    ├── hooks/
    │   └── useAuth.jsx
    ├── lib/
    │   ├── constants.js
    │   ├── supabase.js
    │   └── utils.js
    └── pages/
        ├── AdminDashboard.jsx
        ├── BuyerOrders.jsx
        ├── Cart.jsx
        ├── Checkout.jsx
        ├── EditProfile.jsx
        ├── Home.jsx
        ├── Login.jsx
        ├── Messages.jsx
        ├── NotFound.jsx
        ├── ProductDetail.jsx
        ├── Register.jsx
        └── SellerDashboard.jsx
```

---

**M-Hustle v1.0** — built for Maseno University by HartTech. The campus marketplace, properly done.
