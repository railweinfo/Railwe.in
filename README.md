# Night Duty Allowance (NDA) Register

A single-page web app for logging night duty shifts, calculating NDA amounts,
tracking Pay/DA history, and printing the official Form G-7. Data is saved
locally in the browser and — once you connect your own Firebase project —
synced privately to your Google account so it's available on any device.

This repo is set up so **you own the entire stack**: your own Google account,
your own Firebase project (free tier is enough), and your own GitHub repo.
Nothing is shared with, or dependent on, anyone else's account.

---

## 1. What you need to set up (one-time)

You said you want this on a **new Gmail, new Firebase project, and new
GitHub account**, separate from any other app. Here's the exact order:

### Step 1 — New Gmail account
1. Go to https://accounts.google.com/signup
2. Create the new account (this will be the account that owns the Firebase
   project, and the account you'll use to log into GitHub).

### Step 2 — New Firebase project
1. Go to https://console.firebase.google.com and sign in with the **new**
   Gmail account.
2. Click **Add project** → give it a name (e.g. `nda-register`) → follow the
   prompts (Google Analytics is optional, you can skip it).
3. Once the project is created, open it.
4. In the left sidebar: **Build → Authentication** → click **Get started**.
   - Go to the **Sign-in method** tab → click **Google** → toggle **Enable**
     → pick a support email → **Save**.
5. In the left sidebar: **Build → Firestore Database** → **Create database**.
   - Choose a location close to you (can't be changed later).
   - Start in **production mode** (the security rules in `firestore.rules`
     in this repo handle access control — you don't need "test mode").
6. Register a web app:
   - Click the gear icon (top left, next to "Project Overview") →
     **Project settings**.
   - Scroll to **Your apps** → click the **`</>`** (web) icon.
   - Give the app a nickname (e.g. `nda-web`) → **Register app**.
   - Firebase will show you a code block that looks like this:
     ```js
     const firebaseConfig = {
       apiKey: "AIza...",
       authDomain: "nda-register-xxxxx.firebaseapp.com",
       projectId: "nda-register-xxxxx",
       storageBucket: "nda-register-xxxxx.appspot.com",
       messagingSenderId: "123456789",
       appId: "1:123456789:web:abcdef123456"
     };
     ```
   - **Copy these six values.**

### Step 3 — Paste your Firebase config into this project
1. Open `js/firebase-config.js` in this repo.
2. Replace the placeholder values with the six values you copied above.
3. Save. That's the only file you need to edit — everything else already
   knows how to use it.

### Step 4 — Add your domain to Firebase's allowed list (for Google Sign-In)
This project's live domains are already added, but if you ever redeploy
elsewhere, add the new domain here:
1. Firebase console → **Authentication → Settings → Authorized domains**
2. Click **Add domain** → paste the bare domain (no `https://` or path).

Currently authorized: `railwe.in`, `www.railwe.in`, `auth.railwe.in`, and
the fallback `railweinfo.github.io`.

### Step 5 — Deploy the Firestore security rules
The rules in `firestore.rules` make sure each user can only read/write
their own data. Deploy them either by pasting the file's contents into
**Firebase console → Firestore Database → Rules tab → Publish** (easiest on
mobile, no CLI needed), or with the Firebase CLI:
```bash
npm install -g firebase-tools
firebase login          # log in with the same new Gmail account
firebase use --add      # pick your project, alias it "default"
firebase deploy --only firestore:rules
```
(This updates the `.firebaserc` file with your real project ID — it currently
has a placeholder.)

### Step 6 — New GitHub account + repo
1. Go to https://github.com/join and create a new account using the same
   new Gmail address.
2. Create a new repository (e.g. `nda-register-app`) — public or private,
   your choice (public is required for free GitHub Pages hosting on a
   personal account, unless you use GitHub Pro/Team).
3. Push this project to it:
   ```bash
   cd nda-app
   git init
   git add .
   git commit -m "Initial commit: NDA Register app with Firebase sync"
   git branch -M main
   git remote add origin https://github.com/YOUR-NEW-USERNAME/nda-register-app.git
   git push -u origin main
   ```

### Step 7 — Turn on GitHub Pages
1. In the new repo on GitHub: **Settings → Pages**.
2. Under **Build and deployment**, set **Source** to **GitHub Actions**.
3. The included workflow (`.github/workflows/deploy-pages.yml`) will
   automatically deploy the site on every push to `main`.
4. After the first push, check the **Actions** tab for the deploy run; once
   it finishes, the app is live at your GitHub Pages URL (before a custom
   domain is attached, this looks like
   `https://YOUR-USERNAME.github.io/YOUR-REPO/`).
5. Go back to Step 4 and make sure that exact domain is in Firebase's
   authorized domains list.

### Step 8 — Custom domain (railwe.in) — already set up for this project
This project is live at **railwe.in** (and **www.railwe.in**), not the
default GitHub Pages URL. If you ever need to redo this from scratch (new
domain, new registrar, domain expired and re-bought, etc.), here's the
full path:

1. **GitHub Pages custom domain**: repo → Settings → Pages → Custom domain
   → enter `railwe.in` → Save. This auto-creates a `CNAME` file in the repo
   root (already present in this project) containing just `railwe.in` — if
   that file is ever deleted or overwritten with different content, GitHub
   silently reverts to the default `.github.io` URL, so don't remove it.
2. **DNS records** (added at your registrar — GoDaddy in this project's
   case):
   - 4 **A** records, Name `@`, pointing to GitHub Pages' IPs:
     `185.199.108.153`, `185.199.109.153`, `185.199.110.153`,
     `185.199.111.153`
   - 1 **CNAME** record, Name `www`, pointing to
     `YOUR-USERNAME.github.io`
   - **Important**: delete any pre-existing "Parked" A record on `@` your
     registrar may have added by default — having it alongside the 4 GitHub
     A records causes DNS to resolve inconsistently (sometimes landing on
     the registrar's parking page instead of your site).
   - Also check for and disable any domain **Forwarding** feature at your
     registrar — that's a separate setting from DNS records and can also
     hijack the domain to a parking/lander page even when DNS itself is
     correct.
3. **Firebase authorized domains**: add both `railwe.in` and
   `www.railwe.in` (see Step 4 above).
4. **Auth subdomain, so Google's sign-in screen shows your domain instead
   of `*.firebaseapp.com`** — this is a separate, optional step:
   - Firebase console → **Hosting** → pick or create a hosting site (this
     project uses one named `nda-app`) → **Add custom domain** → enter
     `auth.railwe.in` → leave "Redirect to an existing website" unchecked.
   - Firebase shows a **TXT** record to add for verification (Name `auth`,
     value like `hosting-site=YOUR-SITE-NAME`). If a CNAME already exists on
     that same name, delete it first — DNS doesn't allow two different
     record types on the same name — then add the TXT record.
   - Once verified, Firebase mints an SSL certificate and shows the final
     DNS record to point `auth.railwe.in` at Firebase Hosting (add that
     too).
   - Once all three steps in Firebase show complete, add `auth.railwe.in`
     to Firebase's authorized domains list (Step 4 above), and update
     `authDomain` in `js/firebase-config.js` to `"auth.railwe.in"` — it's
     already set to that in this project.
   - **Do not change `authDomain` before `auth.railwe.in` is fully
     verified and connected** — pointing it at a domain that isn't yet
     serving Firebase's auth handler will break sign-in entirely until you
     revert it back to the default `YOUR-PROJECT-ID.firebaseapp.com`.

---

## 2. Using the app

- Open the deployed URL (or just open `index.html` locally for
  localStorage-only use without cloud sync).
- Click the lock icon in the top bar → **Sign in with Google** to enable
  cross-device sync. Without signing in, the app works exactly as before,
  saving only to that browser's local storage.
- Everything you already do — logging shifts, editing your profile and
  Pay/DA history, printing Form G-7 — works the same. Signing in just adds
  a private backup that follows your Google account to other devices.
- **Quick check login** — a small "Quick check login" link sits just below
  "Need help? Contact us" on the sign-in screen, for the app owner's own
  fast testing without going through Google sign-in. The password is
  `Test@9590`. **Read this before relying on it for anything beyond quick
  personal checks:**
  - This is a static site with no server, so the password check has to
    live in `js/firebase-init.js` and runs entirely in the browser. The
    password is stored there as a SHA-256 hash
    (`QUICK_CHECK_PASSWORD_HASH`), not in plain text, which stops someone
    casually reading the page's source from immediately seeing it — but
    that is **obscurity, not real security**. A determined person could
    still recover the password (e.g. by hashing common guesses and
    comparing, since the hash itself is public in the page source). There
    is no way to make a password genuinely secret in client-side code
    without a server to check it against instead.
  - This mode **never touches Firebase, Firestore, or cloud sync at
    all** — it only unlocks the app locally, exactly as if no one were
    signed in. Data entered this way stays in that browser's local
    storage only and never reaches any real account, by design.
  - To change the password, replace it in two places: generate a new
    SHA-256 hash (e.g. in a browser console:
    `crypto.subtle.digest('SHA-256', new TextEncoder().encode('newpassword')).then(b=>console.log(Array.from(new Uint8Array(b)).map(x=>x.toString(16).padStart(2,'0')).join('')))`)
    and paste the result into `QUICK_CHECK_PASSWORD_HASH` in
    `js/firebase-init.js`.
- Tap the **☰ menu button** at the top-left to open the side menu (branded
  "N NDA Register"). It links to **Home**, **About Us** (`about.html` —
  the company's public incorporation details, see below), **Contact Us**
  (`contact.html` — Sugamshree Workforce Management Pvt Ltd, email `railwe.info@gmail.com`, WhatsApp
  `+91 77197 76869`), and a **Clerk's Services** dropdown containing
  **Show Salary** (`show-salary.html`). To add more top-level menu items
  later, add another `<a class="sidebar-link">` inside the
  `.sidebar-links` block; to add more items under Clerk's Services, add
  another `<a class="sidebar-sublink">` inside `.sidebar-submenu`. Both
  need adding to `index.html`, `admin.html`, `contact.html`,
  `about.html`, and `show-salary.html` (the menu is duplicated per page
  since each page is a standalone HTML file).

### About Us

`about.html` shows only the company facts that are already public record
via the Ministry of Corporate Affairs (verifiable at mca.gov.in): company
name, CIN, incorporation date, company type, and registered office
address. The PAN and TAN shown on the actual incorporation certificate are
**not** published here — those are sensitive identifiers and have no
reason to be on a public page, unlike the CIN, which is designed to be
publicly searchable.

### Show Salary (salary slip generator)

`show-salary.html` is a self-contained tool, separate from the rest of the
app's login/trial system — **anyone who can reach the page can use it**,
with no password or sign-in gate. It:

1. Accepts the payroll **PDF** export (the JasperReports "PaySlipA4"
   layout — one page per employee). It reads each page's actual text
   positions rather than matching known field labels, so it isn't tied to
   a fixed list of earning/deduction names; a payroll report that starts
   printing a new allowance or deduction code is still read correctly,
   with no code change needed here.
2. As soon as parsing finishes, shows a plain **"✓ Upload Done"**
   confirmation plus a small summary (how many slips, which pay period,
   whether totals tally) and any warnings — skipped pages with no
   Employee No, an Employee No appearing on more than one page, or a
   slip's line items not summing to its own printed Gross Pay / Gross
   Deductions. There's deliberately no searchable table of every
   individual slip here; that was more to check through than useful
   before exporting. The warnings stay, since silently exporting a slip
   with a real data problem would be worse than a little extra text.
3. From there, typing a heading (optional — defaults to "Pay Slip Portal"
   plus the detected pay period) and tapping **"Export Payslip portal for
   employees"** immediately encrypts every employee's data individually
   with AES-256-GCM, using **their own Employee Number as the encryption
   key** (via PBKDF2 key derivation — nothing is sent to any server, this
   all happens in the browser), and downloads one standalone HTML file
   containing everyone's encrypted slip.

That downloaded file is what you share with employees (email, WhatsApp,
intranet, however you distribute it). When an employee opens it, they're
asked for their Employee Number; entering it decrypts and shows only their
own slip — the file contains everyone's data, but an employee has no way
to see anyone else's, since each record needs its own, different key to
decrypt. From there they can print the slip or export it as a PDF. The
same Earnings/Deductions reconciliation check also runs again inside the
generated portal, as a second safety net — if a slip's numbers don't add
up, the employee sees a small notice on their own slip asking them to
contact payroll.

**No password on this tool does not mean no security** — the real
protection is that the *output* file is still encrypted per employee. The
absence of a password here only affects who can *generate* a new portal
from a report; it has no effect on the privacy of slips already
generated and shared.

- **Returning to the app after already signing in once** shows a brief
  small spinner instead of the full "Sign in with Google" card — Firebase
  still has to reconfirm the session on every page load (that's a real
  security check, not something that can be skipped), but a
  `localStorage` flag (`ndaWasSignedIn`) lets the app guess that check will
  likely succeed and show a quieter loading state while it waits, instead
  of flashing the full sign-in message every time. The flag is cleared on
  sign-out and if the account turns out to be blocked, so those cases
  always show the full screen, not the quiet spinner.
- **Signing in on mobile** uses `signInWithRedirect` (navigate to Google,
  pick an account, navigate back) rather than `signInWithPopup`. Desktop
  still uses a popup, since that works cleanly there with no page reload.
  This was a deliberate fix: `signInWithPopup` silently falls back to a
  redirect on mobile browsers (Android Chrome especially) when it can't
  open a real popup, and without explicitly handling that, the page would
  reload at the plain sign-in screen for a few seconds before
  `onAuthStateChanged` caught up — which looked exactly like sign-in had
  failed and then mysteriously logged in on its own a moment later. A
  `sessionStorage` flag (`ndaRedirectPending`), set right before navigating
  to Google and cleared as soon as a definitive signed-in/signed-out answer
  comes back, lets the app recognize "I'm returning from that redirect"
  immediately on reload and show the same quiet spinner as a normal return
  visit (with a "Finishing sign-in..." label) instead of the full sign-in
  card. `getRedirectResult()` is also called explicitly on every load so a
  failed redirect sign-in shows a clear error instead of leaving the person
  stuck looking at an unexplained sign-in screen.
- **Sign-in unlocks instantly on repeat visits, trusting a cached access
  result, rather than waiting on Firestore first.** This was a deliberate
  choice to make sign-in feel fast, with a real tradeoff worth
  understanding:
  - The first time someone signs in (or if their cache is ever cleared),
    the app does the full real check before unlocking, same as always.
  - On every visit after that, a `localStorage` entry
    (`ndaAccessCache:{uid}`) records their last known trial/paid status,
    and the app unlocks with that cached value immediately — no waiting on
    a network round-trip at all.
  - The real check (`resolveAccess`) still runs every time, just silently
    in the background after the app is already unlocked, and updates the
    cache. If it comes back `blocked` — the admin blocked the account, or
    a trial expired — the app locks itself at that point.
  - **The tradeoff**: if the admin blocks someone (or their trial expires)
    while they're not actively using the app, they keep full access on any
    device where they're already signed in until the next time they open
    the app there (at which point the background check catches it within
    a second or two of unlocking, not before). This is a genuine security
    loosening compared to checking before every unlock — it was chosen
    deliberately to prioritize sign-in speed. Admins should be aware that
    blocking someone is not instantaneous across that person's already
    signed-in devices.
  - The cache is cleared on explicit sign-out, and admin accounts always
    go through the real check (never cached), since that's the one account
    that can change everyone else's access.
- **Two Firestore reads that used to run back-to-back now run in
  parallel** (`fetchBlockedMessage` — the admin's custom blocked-user
  message — and `resolveAccess` — this user's own status), cutting a full
  network round-trip off sign-in whenever the cache above doesn't apply.
- **A one-time internal "is this account mirrored to the admin's user
  list" check used to re-run on every single sign-in**, even though the
  answer never changes once true. It's now cached in `localStorage`
  (`ndaDirectoryConfirmed:{uid}`) after the first confirmation, so it's
  skipped entirely on later sign-ins.

## 3. Project structure

```
nda-app/
├── index.html              # The main app UI + logic
├── admin.html              # Standalone admin panel (admin Gmail only)
├── about.html              # "About Us" page (public company/incorporation facts)
├── contact.html            # "Contact Us" page (Sugamshree Workforce Management Pvt Ltd: email + WhatsApp)
├── show-salary.html        # "Clerk's Services → Show Salary": standalone
│                           # tool to upload a payroll report and generate
│                           # an encrypted, shareable salary-slip portal
├── CNAME                   # Tells GitHub Pages to serve this repo at
│                           # railwe.in instead of the default .github.io URL
├── js/
│   ├── firebase-config.js  # ← EDIT THIS with your Firebase project keys
│   ├── firebase-init.js    # Auth + sync + access-gate logic for index.html
│   └── admin-init.js       # Auth + user-management logic for admin.html
├── firestore.rules         # Security rules: data privacy + admin-only access control
├── firebase.json           # Firebase Hosting config (used for the auth.railwe.in
│                           # subdomain — see section 8)
├── .firebaserc             # Firebase project alias (auto-filled by `firebase use --add`)
├── .github/workflows/
│   └── deploy-pages.yml    # Auto-deploys to GitHub Pages on every push to main
└── .gitignore
```

## 4. Data model & privacy

- Each signed-in user's app data is stored at Firestore path
  `users/{their-uid}/ndaRegister/data` — a single document containing their
  duty entries, profile, Pay/DA history, and shift presets.
- Each signed-in user's access record is stored at
  `users/{their-uid}/ndaRegister/meta` — their trial/blocked/paid status.
- Firestore security rules (`firestore.rules`) enforce that a user can only
  read or write their own app data — this is checked server-side, not just
  assumed by the app's code.
- No data is shared between different Google accounts. No one but you (the
  project owner) and each individual signed-in user has access to this data.

## 5. Admin panel & access control

The app enforces mandatory Google sign-in, plus three account states:

- **Trial** — every new Google account gets a 30-day trial automatically on
  first sign-in.
- **Blocked** — either set manually by the admin, or automatic once a trial's
  30 days are up.
- **Paid** — permanent access, set manually by the admin. Never expires.

**The admin panel is a separate page: `admin.html`.** For this project,
that's **https://railwe.in/admin.html**. Bookmark that URL.

**Only `railwe.info@gmail.com` can get past its sign-in gate.** Anyone else
who signs in there sees a plain "this account doesn't have admin access"
message and a sign-out button — no user data, no controls. From the admin
panel you can:
- See every user, their status, and trial countdown
- Approve someone as permanent ("Make permanent")
- Restart a 30-day trial for someone
- Block anyone, anytime
- Edit the message shown to blocked / trial-ended users on the main app
  (saved live — changing it updates what everyone sees immediately)

This is enforced by `firestore.rules`, not just the admin.html UI: a regular
user's own account record can only ever be **created** once (to self-enroll
in a trial) and can never be **updated** by that same user — only the admin
account can change anyone's status. So even a technically savvy user
couldn't unblock themselves by tampering with requests directly, bypassing
admin.html entirely.

**Important:** if you ever need to change which Gmail address is the admin,
you must update it in **three places** and redeploy the rules:
1. `ADMIN_EMAIL` constant in `js/firebase-init.js`
2. `ADMIN_EMAIL` constant in `js/admin-init.js`
3. The `isAdmin()` function in `firestore.rules`

## 6. Lifetime activation payment (Razorpay)

Trial users see a floating **"Pay Rs. 11 for lifetime activation"** button
(shown with a struck-through Rs. 49 "was" price) at the bottom of the app.
Tapping it opens a small panel with a **Pay securely** button that opens
your Razorpay payment link (`https://rzp.io/rzp/azKs0dU`) in a new tab, so
the app stays open behind it. This replaces the earlier direct UPI deep
link; Razorpay's hosted page handles cards, UPI, netbanking and wallets
itself.

Both this floating button and the install banner have a close (X), but
closing either only hides it for that page view — it reappears the next
time the app is opened, until the underlying thing is actually resolved
(the account becomes `paid`, or the app is installed).

**Blocked and trial-ended users get the same pay button too** — right on
the sign-in gate screen where they'd otherwise be stuck, so anyone locked
out has an immediate, obvious way to pay and regain access instead of
being a dead end.

**How a payment is matched to an account.** A static Razorpay payment link
cannot be pre-filled with the payer's email the way the old UPI link could,
so the panel instead *displays* the signed-in user's email right beside the
button and asks them to enter that same address on Razorpay's form. That
email then shows on the payment in your Razorpay dashboard. This depends on
the person actually typing the matching email, so a payment can occasionally
arrive under a different address — match those by name or phone with the
person before upgrading them.

**This does not automatically activate anyone.** The link only opens the
Razorpay page; nothing in this app can tell whether a payment was actually
completed (that needs a server-side check, e.g. a Razorpay webhook handled
by a Cloud Function, which needs Firebase's paid Blaze plan and is not set
up). Instead:
1. Check your Razorpay dashboard (**Payments**) for the ₹11 payment and the
   email the payer entered.
2. In `admin.html`, find that email under **Users**.
3. Tap **"Make permanent"** to give them lifetime access.

The floating widget disappears automatically once a user is `paid` — it
only shows for accounts currently on an active trial or already blocked.

To change the link, edit the `RAZORPAY_PAYMENT_LINK` constant near the top
of `js/firebase-init.js`. The **amount actually charged is set on the
Razorpay link itself** in your Razorpay dashboard, not in this code — the
"Rs. 11" and struck-through "Rs. 49" text in `index.html` is display only,
so if you change the price on Razorpay, update that text to match.

## 7. Installable app (PWA)

The app can be installed to a phone's home screen like a real app — full
screen, its own icon, no browser address bar — instead of just a website
shortcut.

**You need to add 4 icon files** before this works. See `icons/README.txt`
in this package for exact filenames/sizes, or the short version:
- `icons/icon-192.png` — 192×192 px
- `icons/icon-512.png` — 512×512 px
- `icons/icon-maskable-192.png` — 192×192 px (with padding — see the txt file)
- `icons/icon-maskable-512.png` — 512×512 px (with padding)

If you only have one square logo image, you can use it for all 4 to start —
it'll still install correctly, just with a small chance of edge-cropping on
some Android phones' circular icon shapes.

**How it behaves for users:** once `manifest.json`, `sw.js`, and the icons
are all in place and deployed, visiting the site shows a gold banner at the
top: *"Install this app on your device for quick, full-screen access"* with
an **Install** button. This banner:
- Stays up across the whole session until they tap Install or the ✕ to
  dismiss it
- Reappears next time they visit if they dismissed it without installing
  (dismissal only lasts the current browser session, not permanently)
- Disappears automatically forever once the app is actually installed
- Never shows if they're already using the installed app

**Note:** `admin.html` intentionally has no install banner — it's an
internal tool for the admin, not something meant to sit on end users' home
screens.

## 8. Firebase Hosting's role in this project

Firebase Hosting is already in use here — not for the main app (that's
GitHub Pages, at railwe.in), but specifically for the `auth.railwe.in`
custom auth domain described in Step 8 of section 1. That hosting site
(named `nda-app` in the Firebase console) doesn't need any actual site
files deployed to it; its only job is to serve Firebase's own auth handler
pages under your domain instead of `*.firebaseapp.com`.

If you'd rather host the *entire* app on Firebase directly instead of (or
in addition to) GitHub Pages, that's also possible:
```bash
firebase deploy --only hosting
```
Your app would then be live at `https://YOUR-PROJECT-ID.web.app`. Remember
to add that domain to Firebase's authorized domains list too (Step 4 in
section 1).
