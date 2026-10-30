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
