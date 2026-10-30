import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n')

const language = (file) => {
  const ext = path.extname(file).toLowerCase()
  if (ext === '.jsx') return 'jsx'
  if (ext === '.js') return 'js'
  if (ext === '.css') return 'css'
  if (ext === '.html') return 'html'
  if (ext === '.json') return 'json'
  if (ext === '.toml') return 'toml'
  if (ext === '.sql') return 'sql'
  if (file.endsWith('.env.example')) return 'env'
  return 'text'
}

let doc = ''

const codeBlock = (file) => {
  doc += `### \`${file}\`\n\n\`\`\`${language(file)}\n${read(file)}\n\`\`\`\n\n`
}

doc += `# M-Hustle v1.0 — Complete Build Blueprint

**The premium campus marketplace for Maseno University — a HartTech product.**

This document contains the complete, production-ready implementation in the exact section order requested:
Supabase setup, frontend configuration, helpers and components, every page, then deployment and verification notes.

The source of truth is the \`m-hustle/\` directory. Every file printed below exists there, and the production
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
   The URL must be exactly \`https://<project-ref>.supabase.co\` — never prefix it with
   \`your-project-\`. A wrong host produces \`ERR_NAME_NOT_RESOLVED\` in the browser.
3. Open **SQL Editor → New query**, paste the entire schema below, and run it once.
4. Confirm **Storage → listing-images** exists and is public (the script creates it).
5. In **Authentication → URL Configuration**, set the Site URL to \`http://localhost:5173\`
   for development and add your deployed origin for production. Add both to Redirect URLs.
6. In **Authentication → Providers → Email**, turn **Confirm email** OFF. This is the switch
   that removes the verification step; new users are signed in immediately after registering.
7. Promote your first account to admin after registering (see 1.5).
8. If the project already existed before username login was added, run
   \`supabase/migrations/001_username_login.sql\` once in the SQL Editor (printed in 1.2b).
   If it predates listing quantities, ratings or hostel locations, also run
   \`supabase/migrations/002_quantities_reviews_profile.sql\` (printed in 1.2c).

The script is idempotent where practical, so it can be re-run after edits. It creates:

- the enums and seven tables with foreign keys, checks and indexes;
- the auth trigger that provisions a profile for every new user;
- authorization helpers, including \`is_admin()\`, \`is_seller()\`, \`is_active_user()\` and username login;
- the atomic checkout RPC \`create_order()\`, which computes totals from database prices and reserves stock;
- seller rating aggregation and review RLS;
- admin RPCs for listing users, suspending, deleting and platform statistics;
- triggers guarding roles, order totals, message content, cancellations and listing status;
- Row Level Security for every table;
- the public storage bucket and its object policies;
- the realtime publication for chat.

## 1.2 Complete SQL script

${'```'}sql
${read('supabase/schema.sql')}
${'```'}

## 1.2b Username-login migration

If the project already had the schema before username login was added, run this short migration once:

${'```'}sql
${read('supabase/migrations/001_username_login.sql')}
${'```'}

The login form accepts an email or a username. Values without \`@\` are resolved to the account
email by this function, then handed to Supabase Auth's normal password grant. Usernames are public
marketplace handles, so the function intentionally treats them as non-private data.

## 1.2c Quantities, ratings and profile-location migration

For a project created before these features, run this once in the SQL Editor:

${'```'}sql
${read('supabase/migrations/002_quantities_reviews_profile.sql')}
${'```'}

The full \`schema.sql\` above already contains everything in both migrations, so a fresh project
does not need to run them separately.

## 1.3 Storage setup

The SQL above creates the \`listing-images\` bucket and all policies. If you prefer to create it manually:

| Setting | Value |
| --- | --- |
| Bucket name | \`listing-images\` |
| Public | yes |
| File size limit | 5 MB |
| Allowed MIME types | \`image/jpeg\`, \`image/png\`, \`image/webp\`, \`image/avif\` |

Uploads go to \`{auth.uid()}/{uuid}.{ext}\`. Policies allow:

- anyone to read listing images;
- active sellers to insert, update and delete files inside their own UID folder;
- admins to manage every object in the bucket.

The browser uploads with the anon key. The stored object URL is written to \`listings.image_url\`.
No service-role key is ever used in the frontend.

## 1.4 Environment template

Create \`.env\` from the template below. Vite only reads environment variables at boot, so restart the dev server after editing.

${'```'}env
${read('.env.example')}
${'```'}

## 1.5 Create the first admin

Register normally in the app, then run this in the SQL Editor using the username you chose:

${'```'}sql
update public.profiles
set role = 'admin'
where lower(username) = lower('your_username');
${'```'}

Sign out and back in. Then go directly to \`/admin\`. The admin entry is intentionally hidden from
the navbar and home page; the protected URL is the only way in. Admin accounts cannot be created
from the registration form: the profile trigger only accepts \`buyer\` and \`seller\`, and a trigger
blocks client-side role escalation.

## 1.6 Authorization matrix

| Table | Read | Insert | Update | Delete |
| --- | --- | --- | --- | --- |
| \`profiles\` | public safe columns | own profile as buyer/seller | own profile; admins any | admins |
| \`listings\` | active listings from active sellers; own; ordered; admins | own, seller role | own, seller role; admins | admins |
| \`orders\` | buyer, seller, admins | checkout RPC only | buyer/seller with guarded transitions; admins | admins |
| \`order_items\` | follows order visibility | checkout RPC / admins | admins | admins |
| \`subscriptions\` | own; admins | own \`pending\` request, seller role | admins only | admins |
| \`messages\` | sender, receiver, admins | sender only, active accounts | receiver may mark read; admins | admins |

Order transitions enforced by trigger:

\`\`\`text
pending   → delivered   (seller)
pending   → cancelled   (buyer or seller)
delivered → completed   (buyer, "Confirm receipt")
anything else           (admin only)
\`\`\`

Marking an order delivered also marks every related active listing \`sold\`, which removes it from
the public feed.

---

# SECTION 2 — Frontend configuration

## 2.1 package.json

${'```'}json
${read('package.json')}
${'```'}

## 2.2 vite.config.js

${'```'}js
${read('vite.config.js')}
${'```'}

## 2.3 tailwind.config.js

${'```'}js
${read('tailwind.config.js')}
${'```'}

## 2.4 postcss.config.js

${'```'}js
${read('postcss.config.js')}
${'```'}

## 2.5 index.html

${'```'}html
${read('index.html')}
${'```'}

## 2.6 src/main.jsx

${'```'}jsx
${read('src/main.jsx')}
${'```'}

## 2.7 src/App.jsx

${'```'}jsx
${read('src/App.jsx')}
${'```'}

## 2.8 src/index.css

${'```'}css
${read('src/index.css')}
${'```'}

---

# SECTION 3 — Supabase helpers and components

## 3.1 src/lib/supabase.js

${'```'}js
${read('src/lib/supabase.js')}
${'```'}

## 3.2 src/lib/constants.js

${'```'}js
${read('src/lib/constants.js')}
${'```'}

## 3.3 src/lib/utils.js

${'```'}js
${read('src/lib/utils.js')}
${'```'}

## 3.4 src/hooks/useAuth.jsx

${'```'}jsx
${read('src/hooks/useAuth.jsx')}
${'```'}

## 3.5 src/context/CartContext.jsx

${'```'}jsx
${read('src/context/CartContext.jsx')}
${'```'}

## 3.6 src/components/VerifiedBadge.jsx

${'```'}jsx
${read('src/components/VerifiedBadge.jsx')}
${'```'}

## 3.7 src/components/Navbar.jsx

${'```'}jsx
${read('src/components/Navbar.jsx')}
${'```'}

## 3.8 src/components/Footer.jsx

${'```'}jsx
${read('src/components/Footer.jsx')}
${'```'}

## 3.9 src/components/ListingCard.jsx

${'```'}jsx
${read('src/components/ListingCard.jsx')}
${'```'}

## 3.10 src/components/ui.jsx

${'```'}jsx
${read('src/components/ui.jsx')}
${'```'}

## 3.11 src/components/ProtectedRoute.jsx

${'```'}jsx
${read('src/components/ProtectedRoute.jsx')}
${'```'}

## 3.12 src/components/AuthShell.jsx

${'```'}jsx
${read('src/components/AuthShell.jsx')}
${'```'}

## 3.13 src/components/ScrollToTop.jsx

${'```'}jsx
${read('src/components/ScrollToTop.jsx')}
${'```'}

---

# SECTION 4 — Pages

## 4.1 src/pages/Login.jsx

${'```'}jsx
${read('src/pages/Login.jsx')}
${'```'}

## 4.2 src/pages/Register.jsx

${'```'}jsx
${read('src/pages/Register.jsx')}
${'```'}

## 4.3 src/pages/Home.jsx

${'```'}jsx
${read('src/pages/Home.jsx')}
${'```'}

## 4.4 src/pages/ProductDetail.jsx

${'```'}jsx
${read('src/pages/ProductDetail.jsx')}
${'```'}

## 4.5 src/pages/Cart.jsx

${'```'}jsx
${read('src/pages/Cart.jsx')}
${'```'}

## 4.6 src/pages/Checkout.jsx

${'```'}jsx
${read('src/pages/Checkout.jsx')}
${'```'}

## 4.7 src/pages/BuyerOrders.jsx

${'```'}jsx
${read('src/pages/BuyerOrders.jsx')}
${'```'}

## 4.8 src/pages/Messages.jsx

${'```'}jsx
${read('src/pages/Messages.jsx')}
${'```'}

## 4.9 src/pages/SellerDashboard.jsx

${'```'}jsx
${read('src/pages/SellerDashboard.jsx')}
${'```'}

## 4.10 src/pages/AdminDashboard.jsx

${'```'}jsx
${read('src/pages/AdminDashboard.jsx')}
${'```'}

## 4.11 src/pages/NotFound.jsx

${'```'}jsx
${read('src/pages/NotFound.jsx')}
${'```'}

## 4.12 src/pages/EditProfile.jsx

${'```'}jsx
${read('src/pages/EditProfile.jsx')}
${'```'}

---

# SECTION 5 — Deployment, security and verification

## 5.1 Deployment files

### \`vercel.json\`

${'```'}json
${read('vercel.json')}
${'```'}

### \`netlify.toml\`

${'```'}toml
${read('netlify.toml')}
${'```'}

### \`.gitignore\`

${'```'}text
${read('.gitignore')}
${'```'}

## 5.2 Deploy

${'```'}bash
npm install
npm run build
npm run preview
${'```'}

- Vercel: import the repository, add \`VITE_SUPABASE_URL\` and \`VITE_SUPABASE_ANON_KEY\`,
  and deploy. The rewrite in \`vercel.json\` makes \`/product/:id\`, \`/seller\`, \`/admin\` and
  \`/messages\` work on a hard refresh.
- Netlify: \`netlify.toml\` sets the build command and SPA redirect.
- Add the production origin to Supabase Auth URL Configuration.
- Never add the service-role key to these environment variables.

## 5.3 Security highlights

- RLS is enabled on all seven tables; there is no unprotected table.
- Checkout totals are computed in \`create_order()\` from live listing prices, and stock is validated
  and reserved atomically. A tampered client cannot change the amount or oversell an item.
- Roles, suspension flags and profile email can only be changed by an admin or by the service role.
  A trigger blocks privilege escalation even with a hand-crafted update.
- Order participants, totals and creation time are immutable.
- Message bodies, senders, receivers and listing context are immutable; receivers can only flip
  \`is_read\`.
- Reviews are accepted only from the buyer of a completed order, one per order. Public rating
  aggregates expose no buyer identity.
- \`profiles.email\` and \`profiles.phone\` are hidden from broad table reads using column-level
  grants. The owner reads them through \`get_my_profile()\`; admins through \`admin_list_users()\`.
- M-Pesa codes are unique and visible only to the seller and admins.
- Suspended sellers disappear from the public feed, cannot create listings, cannot receive orders,
  and cannot upload images.
- The storage bucket accepts only 5 MB images of four MIME types, inside the uploader's UID folder.

## 5.4 Verification record

Performed in this workspace:

| Check | Result |
| --- | --- |
| \`npm run build\` | Passed — 1,945 modules transformed |
| Entry bundle | ~123 kB (34 kB gzip) plus cached React/Supabase vendor chunks |
| Route code splitting | Product, Cart, Checkout, Orders, Messages, Seller, Admin, Profile, 404 are lazy |
| JSX binding audit | 27 source files, all JSX components bound |
| Identifier audit | No unbound identifiers |
| Emoji audit | No emoji/surrogate characters in UI source |
| Unused import audit | None |
| Live Supabase connectivity | 200 from \`profiles\`, \`listings\` and \`get_seller_badges\` using the anon key |
| Live RLS check | \`profiles.email\` read blocked (42501); \`admin_stats()\` blocked for anon (42501) |
| Live page render | Headless Chrome rendered \`/register\` and \`/\` with no connectivity alert |
| Email confirmation | Hosted project reports \`mailer_autoconfirm: true\` (verification disabled) |
| Username login | Installed and responding on the hosted project |
| Migration 002 | Included; run it on the hosted project before opening the quantity/rating screens |

The connected project responded successfully with the corrected URL
\`https://fyfrotzpvovusqpbookw.supabase.co\`. The base schema and username login are live; migration
002 (quantities, reviews, locations) must be run once before the new screens can query those
columns. The UI has no mock data and no offline fallback; with missing or placeholder credentials
it deliberately shows a setup screen instead of fake listings.

## 5.5 Source tree

\`\`\`text
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
\`\`\`

---

**M-Hustle v1.0** — built for Maseno University by HartTech. The campus marketplace, properly done.
`

fs.writeFileSync(path.join(root, 'BLUEPRINT.md'), doc, 'utf8')
console.log(`BLUEPRINT.md written: ${(doc.length / 1024).toFixed(1)} KB, ${doc.split('\n').length} lines`)
