# M-Hustle v1.0

The premium campus marketplace for Maseno University, designed and built by **HartTech**. Built with React 18, Vite, Tailwind CSS and **Supabase only** — no FastAPI, no Node server, no mock data. Every listing, order, message and badge is backed by PostgreSQL and protected with Row Level Security.

> A single-document version of every source file, in the requested delivery order, is available in [`BLUEPRINT.md`](BLUEPRINT.md).

> **Upgrading an existing project?** Run [`supabase/migrations/002_quantities_reviews_profile.sql`](supabase/migrations/002_quantities_reviews_profile.sql) in the Supabase SQL Editor before loading this version. It adds `listings.quantity`, `profiles.location`, the `reviews` table and the rating functions. Without it, the feed and product pages will report missing columns.

---

## What is included

- **Buyer experience** — editorial home feed, server-backed search and category filters, product detail, persistent cart, multi-seller checkout, order history, confirm receipt, seller ratings, real-time chat.
- **Seller studio** — metrics, image-upload listing creation with stock quantity, listing lifecycle (active / sold / removed), stock management, incoming orders with handover details, mark delivered, subscription upgrades (Pro / Pro Max).
- **Profile editing** — full name, username, phone and an exact Maseno hostel dropdown.
- **Admin console** — platform stats, user suspension and deletion, listing moderation, M-Pesa subscription approvals.
- **Verification and ranking** — custom scalloped `VerifiedBadge` SVG. Pro Max and Pro rank first; within each tier, better-rated sellers rank above unrated sellers.
- **Design system** — `#0a0a12` ink canvas, radial orange/pink glows, glassmorphism cards, Sora/Inter typography, Lucide icons only, zero emoji in the UI.

## Tech stack

| Layer | Choice |
| --- | --- |
| UI | React 18, Vite 5 |
| Styling | Tailwind CSS 3 |
| Routing | React Router DOM 6 |
| Data, auth, storage, realtime | Supabase (`@supabase/supabase-js` v2) |
| Icons | lucide-react |
| Dates | date-fns |

There is **no backend folder**. The browser uses the Supabase anon key and RLS does the authorization.

---

## 1. Create the Supabase project

1. Create a project at [supabase.com](https://supabase.com).
2. Open **SQL Editor → New query**, paste the full contents of [`supabase/schema.sql`](supabase/schema.sql) and run it once.
   The script creates:
   - enums, tables, indexes and constraints
   - the auth trigger that creates `profiles`
   - helper functions (`is_admin`, `is_seller`, `is_username_available`, `login_email_for_username`, `get_my_profile`, `get_seller_badges`, `get_seller_ratings`)
   - the atomic checkout RPC `create_order` with stock reservation
   - admin RPCs (`admin_list_users`, `admin_set_suspension`, `admin_delete_user`, `admin_stats`)
   - triggers that protect roles, frozen order totals, message immutability and stock on cancellation
   - Row Level Security for all seven tables
   - the public `listing-images` storage bucket and its policies
   - the `messages` realtime publication

3. **Storage** is created by the SQL script. Confirm **Storage → listing-images** exists and is public. Uploads are restricted to `{auth.uid()}/…` folders and seller accounts.

4. **Authentication → URL Configuration**:
   - Site URL: `http://localhost:5173` during development, your deployed origin in production.
   - Redirect URLs: add the same origin(s), e.g. `http://localhost:5173/**`.

5. **Remove email verification**: open **Authentication → Providers → Email** and turn
   **Confirm email** off. Save. New accounts are signed in immediately after registration
   instead of being sent to a “check your inbox” screen. If your project was created before
   username login was added, also run
   [`supabase/migrations/001_username_login.sql`](supabase/migrations/001_username_login.sql)
   once in the SQL Editor.

6. **Existing projects created before quantities, ratings and profile locations**: run
   [`supabase/migrations/002_quantities_reviews_profile.sql`](supabase/migrations/002_quantities_reviews_profile.sql)
   once in the SQL Editor. A fresh project only needs the full `schema.sql`.

7. **Realtime** is enabled for `public.messages` by the script. No dashboard toggle is required on current Supabase projects.

## 2. Configure the frontend

```bash
cd m-hustle
cp .env.example .env
```

Fill in **Project Settings → API**:

```env
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-public-key
```

Then:

```bash
npm install
npm run dev
```

Open `http://localhost:5173`. If the environment file is missing, the app renders a guided setup screen instead of a broken marketplace.

> Never put the `service_role` key in this project. It is a browser app; only the anon key is used and RLS enforces every rule.

## 3. Sign-in and the first admin

Users can sign in with either their **email address** or their **username** on the same form.
A value without `@` is resolved to the account email through `login_email_for_username()`.

Register normally in the app (choose Buyer or Seller), then promote that account in the SQL Editor:

```sql
update public.profiles
set role = 'admin'
where lower(username) = lower('your_username');
```

Sign out and back in so the new role is loaded. Then navigate directly to
`http://localhost:5173/admin`. The admin entry is intentionally hidden from the navbar and home
page; the protected URL is the only way in.

Admin accounts are never creatable from the registration form — the profile trigger and insert RLS only allow `buyer` and `seller`, and the profile update trigger blocks role escalation from the client.

To verify the promotion worked:

```sql
select username, email, role from public.profiles
where lower(username) = lower('your_username');
```

## 4. M-Pesa configuration

Subscription payments are **manual and admin-approved** in v1:

1. Seller pays via Paybill and submits the M-Pesa confirmation code.
2. A `pending` row is created in `subscriptions`.
3. An admin reconciles the code and approves it. Approval writes `active`, sets `expires_at = now() + 30 days`, and the seller immediately gets the badge and feed priority.
4. M-Pesa codes are unique at the database level, so a code cannot be reused.

`src/lib/constants.js` contains `MPESA_PAYBILL`, `MPESA_ACCOUNT` and `SUPPORT_EMAIL`. The live collection details are:

- Paybill: **400200**
- Account: **1211964**

Sellers see these values on the subscription tab when they choose Pro or Pro Max.

Badges are resolved through `get_seller_badges()`, which only exposes `seller_id`, `plan` and `expires_at` for active, unexpired subscriptions. M-Pesa codes are never public.

## 5. Hostel locations

The **Edit profile** page offers exactly this list, also enforced by a database check constraint:

```js
const HOSTELS = [
  'Kilimanjaro', 'Niles', 'Nyabundi', 'ACV', 'Equator', 'Elgon',
  'Mara 1', 'Mara 2', 'Mara 3', 'Mara 4', 'Rusinga', 'Ndeere', 'Victoria'
]
```

The chosen hostel is shown on the seller card to help buyers plan a handover.

---

## Project structure

```
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
├── README.md
├── BLUEPRINT.md                # every file in one delivery document
├── scripts/
│   └── build-blueprint.mjs
├── supabase/
│   ├── schema.sql              # complete database, RLS, storage, realtime
│   └── migrations/
│       ├── 001_username_login.sql
│       └── 002_quantities_reviews_profile.sql
└── src/
    ├── main.jsx                # BrowserRouter + providers
    ├── App.jsx                 # routes, role guards, setup + suspension screens
    ├── index.css               # design system
    ├── components/
    │   ├── AuthShell.jsx
    │   ├── Footer.jsx
    │   ├── ListingCard.jsx
    │   ├── Navbar.jsx
    │   ├── ProtectedRoute.jsx
    │   ├── ScrollToTop.jsx
    │   ├── VerifiedBadge.jsx
    │   └── ui.jsx              # Alert, Modal, Spinner, StatCard, EmptyState…
    ├── context/
    │   └── CartContext.jsx     # localStorage cart
    ├── hooks/
    │   └── useAuth.jsx         # session + profile context
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

## Database at a glance

| Table | Purpose |
| --- | --- |
| `profiles` | One row per auth user: username, full name, email, role, phone, hostel location, suspension flag. |
| `listings` | Seller inventory with price, category, image, available `quantity`, status (`active`, `sold`, `deleted`). |
| `orders` | One order per seller at checkout, with handover location and contact phone. Total is always computed server-side. |
| `order_items` | Line items with quantity and `price_at_purchase` snapshot. |
| `subscriptions` | Pro / Pro Max requests: pending → active → expired, with unique M-Pesa code. |
| `messages` | Direct messages with optional listing context, read state and realtime delivery. |
| `reviews` | One buyer review per completed order: 1–5 stars and an optional comment. |

### Authorization model

- Anyone (including signed-out visitors) can read `active` listings from non-suspended sellers, public seller profile fields, active badges and aggregate seller ratings. Listings with zero stock are hidden.
- Sellers can insert and update only their own listings; they can never move a listing to another seller.
- Buyers can read their own orders; sellers can read orders addressed to them; admins can read everything.
- Only `create_order()` writes order rows, and it computes totals from database prices — a tampered browser cannot change what it pays.
- Stock is reserved when an order is created. Cancelling a pending order restores the quantity and relists the item if it had sold out.
- Buyers confirm receipt (`delivered → completed`). Only then can they submit one review for that order.
- Reviews are readable only by the buyer, the reviewed seller and admins; the public sees aggregate ratings through `get_seller_ratings()`.
- Sellers can only read their own subscriptions and can only insert a `pending` request. Only admins can activate one.
- Messages are readable only by the two participants; the receiver can only change `is_read`, and content is immutable by trigger.
- Admin helpers are `SECURITY DEFINER` and re-check `is_admin()` internally.

> **Private fields:** `profiles.email` and `profiles.phone` are not selectable through the public table read. The owner reads them via `get_my_profile()`; admins read them via `admin_list_users()`. This is enforced with column-level grants in the schema.

## Checkout and payment flow

1. Cart lives in `localStorage`, scoped to the device.
2. Checkout groups items by seller and calls `create_order` once per seller.
3. The RPC re-validates every listing (`active`, enough stock, same seller), locks the rows, sums the authoritative prices and creates `orders` + `order_items` in one transaction. The ordered quantity is reserved immediately.
4. Payment is **on handover** — cash or M-Pesa directly to the seller. M-Hustle does not collect the item price in v1.
5. If one seller's order fails in a multi-seller cart, successful orders are kept, their items are removed from the cart, and the failure is explained.
6. Cancelling a pending order restores the reserved stock. When the last unit is reserved, the listing automatically becomes `sold` and leaves the feed.

## Deployment

The app is a static SPA. Build with:

```bash
npm run build
npm run preview
```

- **Vercel** — import the repo; `vercel.json` rewrites all routes to `index.html`. Add the two environment variables in Project Settings.
- **Netlify** — `netlify.toml` includes the SPA redirect and build command. Add the environment variables.
- Add the deployed URL to Supabase **Authentication → URL Configuration**.
- Storage public URLs work from any origin; no extra CORS setup is needed for `listing-images`.

## Verification checklist

After wiring Supabase, test in this order:

1. Register a buyer and a seller. With email confirmation off, both should enter the app immediately; confirm both `profiles` rows exist with the correct roles.
2. Sign out and sign back in using the **username** instead of the email.
3. Open **Edit profile** and choose a hostel from the exact list. Save, refresh and confirm it persisted.
4. As the seller, upload a listing photo, set **quantity** to more than one and publish.
5. As the buyer, search/filter, open the listing, add two units, chat with the seller and check out. The listing stock must drop by two.
6. As the seller, open Orders → Mark delivered.
7. As the buyer, Confirm receipt. The order becomes `completed`, then click **Rate seller**, choose stars and submit.
8. Refresh the home feed. Better-rated sellers should rank above unrated sellers within the same plan tier.
9. As admin, approve a subscription after the seller submits an M-Pesa code. The blue/gold badge appears and the seller ranks in the premium tier.
10. Suspend a user. Their listings leave the feed and their write actions are rejected by RLS.
11. Run `npm run build` — the production bundle must compile without errors.

## Security notes

- The anon key is designed to be public; RLS is the barrier. Never ship the service-role key.
- `login_email_for_username()` is a `SECURITY DEFINER` function exposed to anonymous users so username sign-in works without a backend. It resolves an exact username to its account email. Usernames are public marketplace handles; never use a handle you consider private.
- Role escalation, suspension changes and email changes are blocked by trigger even if a client crafts a direct update.
- Order totals, participants and creation time are immutable.
- M-Pesa codes are unique and visible only to the seller and admins.
- Deletion of an account cascades profile, listings, orders, messages, reviews and subscriptions. Prefer suspension for moderation unless data removal is intended.
- `get_seller_badges()` and `get_seller_ratings()` are intentionally public and return only non-sensitive aggregate data.
- Bucket uploads are limited to 5 MB and JPG/PNG/WebP/AVIF; the UI validates the same limits.
- Reviews are accepted only for the buyer's own `completed` order, one per order, with a 1–5 rating.

## Troubleshooting

### The console shows `ERR_NAME_NOT_RESOLVED` for Supabase

The project URL in `.env` is wrong. It must be exactly:

```env
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
```

Do **not** include a `your-project-` prefix. The project ref must match the `ref` inside your anon key. After editing `.env`, stop the dev server completely and run `npm run dev` again — Vite only reads `.env` at boot.

You can confirm the host and key are reachable with:

```bash
curl -H "apikey: YOUR_ANON_KEY" https://YOUR_PROJECT_REF.supabase.co/rest/v1/profiles?select=id\&limit=1
```

A `200` with `[]` means the project and schema are reachable.

### `Cannot reach the server` on the registration form

1. Check the Supabase URL (see above).
2. Make sure the project is not paused in the Supabase dashboard.
3. Restart the dev server after changing `.env`.
4. Confirm the schema was applied: `profiles` and `listings` should return `200`, not `404`.

## Support

M-Hustle is designed and maintained by **HartTech**.

- Email: [helloharttech@gmail.com](mailto:helloharttech@gmail.com)
- Campus: Maseno University, Kisumu, Kenya

## v1 boundaries

- Manual M-Pesa reconciliation (no Daraja callback yet).
- One photo per listing.
- One review per completed order; buyers cannot edit a review in v1.
- Roles are chosen at registration. There is no self-service buyer-to-seller switch in v1; an admin can change a role in SQL, or the student can register a seller account with another email.
- No password-reset UI (Supabase's built-in email flow can be added).
- No automated subscription expiry job included; the badge query already ignores expired rows. A `pg_cron` snippet is provided at the end of `schema.sql` if you want to flip expired rows too.
- English-only UI, KES-only pricing.

---

Built for Maseno University by [HartTech](mailto:helloharttech@gmail.com). Keep the hustle on campus.
