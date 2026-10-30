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
