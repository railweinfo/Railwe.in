// ============================================================================
// Firebase init: Auth (Google) + Firestore sync + access control (trial /
// blocked / paid), for the NDA Register app.
//
// This file does NOT know anything about NDA-specific data structures beyond
// the four top-level keys the app already persists locally: entries, profile,
// shiftPresets, viewMode. It exposes a small window.NdaCloud API that
// index.html's existing saveState()/loadState() functions call into.
//
// Design:
//  - Local-first: the app keeps working offline via localStorage exactly as
//    before. Firestore is an additional, best-effort sync layer.
//  - Each signed-in user's app data lives at: users/{uid}/ndaRegister/data
//  - Each signed-in user's ACCESS record lives at: users/{uid}/ndaRegister/meta
//    { email, displayName, status: 'trial'|'blocked'|'paid',
//      trialStartedAt, trialEndsAt, createdAt }
//    On first-ever sign-in, THIS file creates that doc with status 'trial'
//    and a 30-day window. Firestore security rules (see firestore.rules)
//    only allow the ADMIN account to change status after that — a user can
//    never unblock or extend their own trial by editing their own doc.
//  - One global doc, config/access, holds the admin-editable message shown
//    to blocked / trial-ended users (edited from admin.html).
//  - The mandatory sign-in gate (#authGate) blocks the whole app (.wrap)
//    until the signed-in user's status is 'trial' (unexpired) or 'paid'.
//  - The admin panel itself lives at admin.html / js/admin-init.js — this
//    file has no admin UI, but the admin account's OWN sign-in still goes
//    through this same trial/blocked/paid check like anyone else's (the
//    admin is just always treated as 'paid', see isAdminUser() below).
// ============================================================================

import { firebaseConfig } from './firebase-config.js';

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  onAuthStateChanged,
  getRedirectResult
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  onSnapshot,
  serverTimestamp,
  Timestamp,
  enableIndexedDbPersistence
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const ADMIN_EMAIL = 'railwe.info@gmail.com';
const TRIAL_DAYS = 30;
const DEFAULT_BLOCKED_MESSAGE = 'Your 30-day trial has ended. Please contact the administrator to continue using this app.';
const UPI_ID = 'neha.0083@ptyes';
// The actual amount charged via UPI. The struck-through "Rs. 49" shown next
// to the button in index.html is a display-only "offer" price and is NOT
// read from here — if you change this amount, update that strikethrough
// text in index.html separately if you want the discount framing to match.
const UPI_AMOUNT = '11';
const UPI_PAYEE_NAME = 'NDA Register';

// Used purely to soften the loading experience: when this is set, we
// already expect Firebase to confirm the person as signed in on this
// load, so we show a small quiet spinner instead of the full sign-in card
// while that confirmation happens. It is NOT used for any access-control
// decision — resolveAccess() and the real onAuthStateChanged callback are
// still what actually determine whether the app unlocks.
const WAS_SIGNED_IN_KEY = 'ndaWasSignedIn';

// Set right before navigating away for a mobile redirect sign-in, cleared
// once that sign-in attempt has been resolved one way or another. Lets the
// page load right after returning from Google recognize "I'm coming back
// from a redirect" and show a quiet loading state instead of the full
// sign-in card. sessionStorage (not localStorage) is intentional — it
// should only apply to this one round trip, not linger across visits.
const REDIRECT_PENDING_KEY = 'ndaRedirectPending';

// Caches the last known access decision (trial/paid/blocked) per account,
// so a returning sign-in can unlock the app INSTANTLY using the cached
// result instead of waiting on a Firestore round-trip first. This was a
// deliberate choice to prioritize speed: once someone has signed in and
// been confirmed trial/paid, later visits on this device trust that
// immediately rather than re-checking before unlocking.
//
// This does NOT mean access is never re-verified — resolveAccess() still
// runs in the background right after the cached unlock, silently, and
// updates the cache. If that real check comes back "blocked" (admin
// revoked access, or a trial expired), the app locks itself at that point
// rather than staying unlocked forever. So an admin's block still takes
// effect — just not necessarily on the very next page load, only once the
// background check completes (typically within a second or two, same as
// before, just no longer blocking the visible unlock).
function accessCacheKey(uid) {
  return 'ndaAccessCache:' + uid;
}
function readAccessCache(uid) {
  try {
    const raw = localStorage.getItem(accessCacheKey(uid));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || (parsed.status !== 'trial' && parsed.status !== 'paid')) return null;
    return parsed;
  } catch (e) {
    return null;
  }
}
function writeAccessCache(uid, access) {
  try {
    if (access.status === 'trial' || access.status === 'paid') {
      localStorage.setItem(accessCacheKey(uid), JSON.stringify({
        status: access.status,
        trialEndsAt: access.trialEndsAt ? access.trialEndsAt.toISOString() : null
      }));
    } else {
      localStorage.removeItem(accessCacheKey(uid));
    }
  } catch (e) {}
}

const isConfigured = firebaseConfig.apiKey && !firebaseConfig.apiKey.startsWith('REPLACE_WITH');

let app, auth, db, currentUser = null;
let unsubscribeSnapshot = null;
let suppressNextRemoteEcho = false;
let cachedBlockedMessage = DEFAULT_BLOCKED_MESSAGE;

if (isConfigured) {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
  enableIndexedDbPersistence(db).catch((err) => {
    // Fails silently in multi-tab scenarios or unsupported browsers —
    // the app still works, just without Firestore's own offline cache.
    console.warn('Firestore offline persistence not enabled:', err.code);
  });
} else {
  console.warn(
    'NDA Register: Firebase is not configured yet. Cloud sync is disabled. ' +
    'Edit js/firebase-config.js with your Firebase project keys to enable it.'
  );
}

function isAdminUser(user) {
  return !!user && user.email === ADMIN_EMAIL;
}

// Sync status used to show a small dot + label in the top bar; that UI
// element has been removed at the person's request, so this is now a
// deliberate no-op. Left in place (rather than deleting every call site)
// so nothing else in this file needs to change.
function setSyncStatus(state, label) {
  // Intentionally does nothing.
}

// ---- Mandatory sign-in + access gate ----
// The app UI (.wrap) is hidden by CSS until <body> has the "app-unlocked"
// class. These functions are the only things that add/remove it, and they
// also switch which panel of #authGate is visible.
function unlockApp() {
  document.body.classList.add('app-unlocked');
  try { localStorage.setItem(WAS_SIGNED_IN_KEY, '1'); } catch (e) {}
}

// ---- Quick-check password login ----
//
// A deliberately separate, low-key way for the app's owner to open the
// app for a quick look without going through Google sign-in — useful for
// fast manual testing. This is intentionally NOT a real authentication
// system: it's a static site with no server, so the check below has to
// live in this file and can be read by anyone who looks at the page's
// source. Hashing the password (SHA-256) means the literal password
// isn't sitting in plain text, which stops casual inspection, but it is
// NOT real security — a determined person could still recover it. That
// tradeoff is intentional and accepted for this tool's purpose.
//
// Crucially, this mode never touches Firebase, Firestore, or any real
// user's data: it only flips the same CSS class the real unlock flow
// uses to reveal the app, and the app then runs exactly as it already
// does with no one signed in — local-only (localStorage), no cloud sync
// at all. Nothing here can write to, read from, or interfere with any
// real account.
const QUICK_CHECK_PASSWORD_HASH = '3f67bc0457807c2298a5b1852f790457cdeb80e2f7674e1a7aae46a7abd252b4';

async function sha256Hex(text) {
  const enc = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function wireUpQuickCheck() {
  const toggle = document.getElementById('quickCheckToggle');
  const form = document.getElementById('quickCheckForm');
  const input = document.getElementById('quickCheckPassword');
  const submit = document.getElementById('quickCheckSubmit');
  const errorEl = document.getElementById('quickCheckError');
  if (!toggle || !form || !input || !submit || !errorEl) return;

  toggle.addEventListener('click', (e) => {
    e.preventDefault();
    const showing = form.style.display !== 'none';
    form.style.display = showing ? 'none' : 'block';
    if (!showing) input.focus();
  });

  async function attemptUnlock() {
    errorEl.textContent = '';
    const value = input.value;
    if (!value) return;
    let hash;
    try {
      hash = await sha256Hex(value);
    } catch (err) {
      // crypto.subtle requires a secure context (https, or localhost).
      // Fail safe with a clear message rather than silently doing nothing.
      errorEl.textContent = 'Could not verify password on this page (requires HTTPS).';
      return;
    }
    if (hash === QUICK_CHECK_PASSWORD_HASH) {
      input.value = '';
      errorEl.textContent = '';
      document.body.classList.add('app-unlocked');
      // Deliberately NOT calling unlockApp(), NOT setting WAS_SIGNED_IN_KEY,
      // NOT touching currentUser, Firestore listeners, or sync state of any
      // kind — this path stays completely separate from the real sign-in
      // system so it can never be confused with (or interfere with) it.
    } else {
      errorEl.textContent = 'Incorrect password.';
    }
  }

  submit.addEventListener('click', attemptUnlock);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') attemptUnlock();
  });
}

function lockApp() {
  document.body.classList.remove('app-unlocked');
  const gate = document.getElementById('authGate');
  if (gate) { gate.classList.remove('checking'); gate.classList.remove('quiet-check'); }
}

function showGateChecking(isChecking) {
  const gate = document.getElementById('authGate');
  if (!gate) return;
  gate.classList.toggle('checking', isChecking);
  const loading = document.getElementById('authGateLoading');
  if (loading) loading.style.display = isChecking ? '' : 'none';
}

function showGateSignedOut() {
  document.getElementById('gateSignedOutView').style.display = '';
  document.getElementById('gateBlockedView').style.display = 'none';
  try { localStorage.removeItem(WAS_SIGNED_IN_KEY); } catch (e) {}
}

function showGateBlocked(message) {
  document.getElementById('gateSignedOutView').style.display = 'none';
  document.getElementById('gateBlockedView').style.display = '';
  document.getElementById('gateBlockedMessage').textContent = message || cachedBlockedMessage;
  const gateUpiLink = document.getElementById('gateUpiLink');
  if (gateUpiLink) {
    gateUpiLink.href = buildUpiLink(currentUser ? currentUser.email : null);
  }
  // Someone landing here shouldn't get a quiet, blink-and-you-miss-it
  // re-check next time — they need to actually see this screen (and the
  // pay/contact options on it), so make sure future loads show it plainly.
  try { localStorage.removeItem(WAS_SIGNED_IN_KEY); } catch (e) {}
}

function showGateError(message) {
  const el = document.getElementById('gateAuthError');
  if (!el) return;
  if (message) {
    el.textContent = message;
    el.classList.add('show');
  } else {
    el.classList.remove('show');
    el.textContent = '';
  }
}

function showAuthError(message) {
  const el = document.getElementById('authError');
  if (!el) return;
  if (message) {
    el.textContent = message;
    el.classList.add('show');
  } else {
    el.classList.remove('show');
    el.textContent = '';
  }
}

function updateAuthUI(user) {
  const authAvatar = document.getElementById('authAvatar');
  const authBtn = document.getElementById('authBtn');
  const panelOut = document.getElementById('authPanelSignedOut');
  const panelIn = document.getElementById('authPanelSignedIn');

  if (user) {
    authBtn.title = `Signed in as ${user.email}`;
    authBtn.setAttribute('aria-label', authBtn.title);
    const initial = (user.displayName || user.email || '?').charAt(0).toUpperCase();
    // Always show the initial first — guaranteed to render with no network
    // dependency. If a photo URL exists, layer a real <img> element on top
    // (not an inline onerror= attribute, which some installed-PWA/CSP
    // contexts can silently block) and only reveal it once it has
    // genuinely finished loading; if it fails, the initial underneath
    // stays visible instead of leaving a blank box.
    authAvatar.textContent = initial;
    authAvatar.classList.add('signed-in');
    if (user.photoURL) {
      const img = new Image();
      img.alt = '';
      img.referrerPolicy = 'no-referrer'; // Google's photo CDN can reject requests that send a referrer
      img.onload = () => {
        authAvatar.textContent = '';
        authAvatar.appendChild(img);
      };
      img.onerror = () => {
        // Leave the initial in place — nothing else to do.
      };
      img.src = user.photoURL;
    }
    if (panelOut) panelOut.style.display = 'none';
    if (panelIn) {
      panelIn.style.display = '';
      document.getElementById('authUserPhoto').src = user.photoURL || '';
      document.getElementById('authUserName').textContent = user.displayName || 'Signed in';
      document.getElementById('authUserEmail').textContent = user.email || '';
    }
  } else {
    authBtn.title = 'Sign in to sync';
    authBtn.setAttribute('aria-label', 'Sign in to sync');
    authAvatar.innerHTML = '&#128272;';
    authAvatar.classList.remove('signed-in');
    if (panelOut) panelOut.style.display = '';
    if (panelIn) panelIn.style.display = 'none';
    setSyncStatus(null, '');
  }
}

function userDataRef(uid) {
  return doc(db, 'users', uid, 'ndaRegister', 'data');
}

function userMetaRef(uid) {
  return doc(db, 'users', uid, 'ndaRegister', 'meta');
}

function userDirectoryRef(uid) {
  return doc(db, 'userDirectory', uid);
}

function accessConfigRef() {
  return doc(db, 'config', 'access');
}

// ---- Floating lifetime-activation payment widget ----
// Only shown to users on an active trial (not blocked, not already paid,
// not the admin). Tapping the FAB opens a small panel with a UPI deep link
// that pre-fills the amount, payee, AND the signed-in user's email in the
// payment note/remarks field — so when the admin checks their UPI app or
// bank statement, the payer's email is right there in the transaction,
// identifying who paid. The admin then finds that email in admin.html's
// Users list and taps "Make permanent" themselves; this link only OPENS
// the user's UPI app, it cannot confirm or auto-report that payment
// actually completed, so nothing here can upgrade anyone's status on its
// own — see firestore.rules, which only lets the admin account do that.
function buildUpiLink(email) {
  const note = email ? `NDA Register lifetime - ${email}` : 'NDA Register lifetime activation';
  const params = new URLSearchParams({
    pa: UPI_ID,
    pn: UPI_PAYEE_NAME,
    am: UPI_AMOUNT,
    cu: 'INR',
    tn: note
  });
  return `upi://pay?${params.toString()}`;
}

let paymentWidgetDismissedThisVisit = false;

function showPaymentWidget(show) {
  const widget = document.getElementById('paymentWidget');
  if (widget) widget.style.display = (show && !paymentWidgetDismissedThisVisit) ? '' : 'none';
  // Rebuild the link each time the widget is shown, since the email isn't
  // known until the user is signed in.
  if (show && currentUser) {
    const payUpiLink = document.getElementById('payUpiLink');
    if (payUpiLink) payUpiLink.href = buildUpiLink(currentUser.email);
  }
}

function wirePaymentWidget() {
  const payFabBtn = document.getElementById('payFabBtn');
  const payFabDismissBtn = document.getElementById('payFabDismissBtn');
  const paymentPanel = document.getElementById('paymentPanel');
  const payPanelCloseBtn = document.getElementById('payPanelCloseBtn');
  const payUpiLink = document.getElementById('payUpiLink');

  payFabBtn.addEventListener('click', () => {
    paymentPanel.style.display = paymentPanel.style.display === 'none' ? '' : 'none';
  });
  payPanelCloseBtn.addEventListener('click', () => {
    paymentPanel.style.display = 'none';
  });
  // A real <a href="upi://..."> tag that the browser navigates as a
  // genuine click is the reliable way to hand off to the UPI app on
  // mobile — see the matching comment on gateUpiLink for why this isn't
  // target="_blank" or driven from window.location.href in the handler.
  // This listener just refreshes href immediately beforehand as a safety
  // net in case the email wasn't known yet when the widget first showed.
  payUpiLink.addEventListener('click', () => {
    if (currentUser) payUpiLink.href = buildUpiLink(currentUser.email);
  });
  // Closing with X only hides it for this page view (in-memory flag, not
  // saved anywhere) — reloading or reopening the app always shows it
  // again, until the account is actually upgraded to paid.
  payFabDismissBtn.addEventListener('click', () => {
    paymentWidgetDismissedThisVisit = true;
    document.getElementById('paymentWidget').style.display = 'none';
    paymentPanel.style.display = 'none';
  });
}

// ---- App-data sync (entries/profile/etc) ----

function startListening(uid) {
  if (unsubscribeSnapshot) unsubscribeSnapshot();
  setSyncStatus('syncing', 'Syncing…');
  unsubscribeSnapshot = onSnapshot(
    userDataRef(uid),
    (snap) => {
      setSyncStatus('synced', 'Synced');
      if (snap.exists() && !suppressNextRemoteEcho) {
        const data = snap.data();
        if (window.NdaCloud.onRemoteData) window.NdaCloud.onRemoteData(data);
      }
      suppressNextRemoteEcho = false;
    },
    (err) => {
      console.error('Firestore sync error:', err);
      setSyncStatus('error', 'Sync error');
    }
  );
}

async function pushToCloud(payload) {
  if (!isConfigured || !currentUser) return;
  try {
    setSyncStatus('syncing', 'Saving…');
    suppressNextRemoteEcho = true; // don't re-apply our own write when the snapshot fires
    await setDoc(userDataRef(currentUser.uid), {
      ...payload,
      updatedAt: serverTimestamp()
    });
    setSyncStatus('synced', 'Synced');
  } catch (err) {
    console.error('Failed to sync to Firestore:', err);
    setSyncStatus('error', 'Sync failed');
  }
}

async function pullFromCloudOnce(uid) {
  const snap = await getDoc(userDataRef(uid));
  return snap.exists() ? snap.data() : null;
}

// ---- Access control (trial / blocked / paid) ----

// Reads (or creates, on first sign-in) the user's meta doc, and returns
// { status: 'trial'|'blocked'|'paid', trialEndsAt: Date|null }.
// Trial expiry is also checked client-side here (in addition to whatever
// the admin panel shows) so a trial silently "expires" on the day it ends
// without the admin needing to manually flip it to blocked.
async function resolveAccess(user) {
  if (isAdminUser(user)) {
    return { status: 'paid', trialEndsAt: null }; // admin always has full access
  }

  const metaRef = userMetaRef(user.uid);
  const snap = await getDoc(metaRef);

  if (!snap.exists()) {
    // First-ever sign-in: self-enroll in a 30-day trial. The security rules
    // validate that trialStartedAt/trialEndsAt exactly match request.time,
    // so this is the ONLY status a brand-new user can ever create for
    // themselves — they cannot hand themselves "paid" or a longer trial.
    const now = Timestamp.now();
    const trialEnds = Timestamp.fromMillis(now.toMillis() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
    const metaDoc = {
      email: user.email,
      displayName: user.displayName || '',
      status: 'trial',
      trialStartedAt: now,
      trialEndsAt: trialEnds,
      createdAt: now
    };
    try {
      await setDoc(metaRef, metaDoc);
      // Also mirror into the flat userDirectory collection, so the admin
      // panel can list every user with a plain top-level collection read
      // instead of a collection-group query across nested subcollections.
      try {
        await setDoc(userDirectoryRef(user.uid), metaDoc);
        try { localStorage.setItem(backfillConfirmedKey(user.uid), '1'); } catch (e) {}
      } catch (dirErr) {
        // Non-fatal: the user's own trial access still works even if this
        // mirror write fails; they just won't show up in the admin list
        // until the next successful sync. Deliberately NOT caching the
        // confirmed flag here, since the mirror write actually failed —
        // the next sign-in should genuinely retry it.
        console.warn('Could not mirror trial record to userDirectory:', dirErr);
      }
      return { status: 'trial', trialEndsAt: trialEnds.toDate() };
    } catch (err) {
      console.error('Could not create trial record:', err);
      // Fail closed: if we can't verify/create access, don't let them in.
      return { status: 'blocked', trialEndsAt: null };
    }
  }

  const meta = snap.data();
  if (meta.status === 'paid') return { status: 'paid', trialEndsAt: null };
  if (meta.status === 'blocked') return { status: 'blocked', trialEndsAt: null };

  // status === 'trial': check client-side whether it has expired.
  const endsAt = meta.trialEndsAt && meta.trialEndsAt.toDate ? meta.trialEndsAt.toDate() : null;
  if (endsAt && endsAt.getTime() < Date.now()) {
    return { status: 'blocked', trialEndsAt: endsAt, expired: true };
  }
  await backfillDirectoryIfMissing(user, meta);
  return { status: 'trial', trialEndsAt: endsAt };
}

// One-time backfill for accounts created before the userDirectory mirror
// existed: if this user's meta doc is a still-active trial but they have no
// userDirectory entry yet, create one now so they show up in the admin
// panel. This mirrors resolveAccess()'s own trial-creation rule exactly
// (same fields, same validation), so it only ever works for a genuine
// active trial — never for backfilling "paid" or "blocked" client-side.
//
// This used to run a getDoc() on EVERY sign-in for every trial user, even
// though the answer ("yes, already mirrored") never changes once true —
// that was one of several redundant network round-trips stacking up and
// slowing sign-in down. Now, once confirmed for this uid, that fact is
// cached in localStorage so later sign-ins on this device skip the check
// entirely. If the browser's storage is ever cleared, worst case this
// just runs the real check again once — it isn't a security-relevant
// value, only a "don't bother re-checking" shortcut.
function backfillConfirmedKey(uid) {
  return 'ndaDirectoryConfirmed:' + uid;
}
async function backfillDirectoryIfMissing(user, meta) {
  if (isAdminUser(user)) return;
  try {
    if (localStorage.getItem(backfillConfirmedKey(user.uid)) === '1') return;
  } catch (e) {}
  try {
    const dirSnap = await getDoc(userDirectoryRef(user.uid));
    if (dirSnap.exists()) {
      try { localStorage.setItem(backfillConfirmedKey(user.uid), '1'); } catch (e) {}
      return;
    }
    if (meta.status !== 'trial') return; // can only self-create a trial entry
    await setDoc(userDirectoryRef(user.uid), {
      email: meta.email || user.email,
      displayName: meta.displayName || user.displayName || '',
      status: 'trial',
      trialStartedAt: meta.trialStartedAt,
      trialEndsAt: meta.trialEndsAt,
      createdAt: meta.createdAt || meta.trialStartedAt
    });
    try { localStorage.setItem(backfillConfirmedKey(user.uid), '1'); } catch (e) {}
  } catch (err) {
    // Non-fatal — worst case this account just doesn't appear in the admin
    // list until the admin manually adds it or the rules are adjusted.
    console.warn('Could not backfill userDirectory entry:', err);
  }
}

async function fetchBlockedMessage() {
  try {
    const snap = await getDoc(accessConfigRef());
    if (snap.exists() && snap.data().blockedMessage) {
      cachedBlockedMessage = snap.data().blockedMessage;
    }
  } catch (err) {
    console.warn('Could not fetch admin blocked-message config:', err);
  }
  return cachedBlockedMessage;
}

// ---- Auth actions ----

// Popups are unreliable on mobile browsers (Android Chrome in particular) —
// Firebase's signInWithPopup silently falls back to a full-page redirect in
// that case, which used to catch people off guard: the page would reload at
// the sign-in screen for a few seconds before onAuthStateChanged caught up,
// looking exactly like sign-in had failed and then mysteriously succeeded
// on its own. Choosing redirect mode explicitly on mobile, rather than
// leaving it to that silent fallback, means we can show a clear "taking you
// to Google..." state immediately instead of nothing happening until the
// fallback kicks in.
function isMobileBrowser() {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

async function handleGoogleSignIn() {
  if (!isConfigured) {
    showAuthError('Cloud sync isn\u2019t set up yet. See js/firebase-config.js for setup steps.');
    showGateError('Sign-in isn\u2019t configured yet. Contact the app owner.');
    return;
  }
  showAuthError(null);
  showGateError(null);
  const provider = new GoogleAuthProvider();

  if (isMobileBrowser()) {
    // This navigates away from the page immediately — there is no "after"
    // to run here on success; the result is picked up by getRedirectResult
    // / onAuthStateChanged when the page reloads back from Google.
    try { sessionStorage.setItem(REDIRECT_PENDING_KEY, '1'); } catch (e) {}
    try {
      await signInWithRedirect(auth, provider);
    } catch (err) {
      console.error('Google sign-in (redirect) failed to start:', err);
      try { sessionStorage.removeItem(REDIRECT_PENDING_KEY); } catch (e) {}
      showAuthError('Sign-in failed. Please try again.');
      showGateError('Sign-in failed. Please try again.');
    }
    return;
  }

  try {
    await signInWithPopup(auth, provider);
  } catch (err) {
    console.error('Google sign-in failed:', err);
    if (err.code === 'auth/popup-closed-by-user') return;
    showAuthError('Sign-in failed. Please try again.');
    showGateError('Sign-in failed. Please try again.');
  }
}

async function handleSignOut() {
  if (unsubscribeSnapshot) { unsubscribeSnapshot(); unsubscribeSnapshot = null; }
  if (currentUser) {
    try { localStorage.removeItem(accessCacheKey(currentUser.uid)); } catch (e) {}
  }
  await signOut(auth);
  document.getElementById('authModal').classList.remove('show');
  // If the app was unlocked via quick-check password login (no real
  // Firebase user, so onAuthStateChanged never fires to lock it back up),
  // tapping Sign Out still needs to return to the gate correctly.
  if (!currentUser) {
    document.body.classList.remove('app-unlocked');
  }
}

// ---- Wiring ----

function wireUpUI() {
  const authBtn = document.getElementById('authBtn');
  const authModal = document.getElementById('authModal');
  const authModalClose = document.getElementById('authModalClose');
  const googleSignInBtn = document.getElementById('googleSignInBtn');
  const signOutBtn = document.getElementById('signOutBtn');
  const gateGoogleSignInBtn = document.getElementById('gateGoogleSignInBtn');
  const gateSignOutBtn = document.getElementById('gateSignOutBtn');
  const gateUpiLink = document.getElementById('gateUpiLink');

  authBtn.addEventListener('click', () => authModal.classList.add('show'));
  authModalClose.addEventListener('click', () => authModal.classList.remove('show'));
  authModal.addEventListener('click', (e) => { if (e.target === authModal) authModal.classList.remove('show'); });
  googleSignInBtn.addEventListener('click', handleGoogleSignIn);
  signOutBtn.addEventListener('click', handleSignOut);
  gateGoogleSignInBtn.addEventListener('click', handleGoogleSignIn);
  gateSignOutBtn.addEventListener('click', handleSignOut);

  wireUpQuickCheck();

  // A real <a href="upi://..."> tag that the browser navigates as a
  // genuine click is the reliable way to hand off to the UPI app on
  // mobile — using target="_blank" or driving navigation entirely from a
  // JS click handler (e.g. setting window.location.href inside the
  // listener) are both known to be unreliable for custom URI schemes like
  // upi:// on various mobile browsers. So this link keeps its normal
  // href-based navigation; this listener just refreshes href immediately
  // beforehand in case the email wasn't known yet when the gate first
  // rendered.
  gateUpiLink.addEventListener('click', () => {
    gateUpiLink.href = buildUpiLink(currentUser ? currentUser.email : null);
  });

  wirePaymentWidget();
}

function init() {
  wireUpUI();

  const gate = document.getElementById('authGate');
  let expectedSignedIn = false;
  try { expectedSignedIn = localStorage.getItem(WAS_SIGNED_IN_KEY) === '1'; } catch (e) {}

  // On mobile, handleGoogleSignIn navigates away via signInWithRedirect
  // rather than opening a popup — so on the page load right after someone
  // picks their Google account, we're "returning from redirect" and should
  // show a quiet "Finishing sign-in..." state instead of the full sign-in
  // card, even on a first-ever sign-in where the normal quiet-check flag
  // (WAS_SIGNED_IN_KEY) wouldn't otherwise be set yet. We use our own
  // sessionStorage flag for this (set right before navigating away, in
  // handleGoogleSignIn) rather than inspecting Firebase's own internal
  // "firebase:pendingRedirect:..." key — that key is set and cleared
  // entirely by the SDK's internal timing and isn't guaranteed to still be
  // present by the time this code runs, so it isn't a reliable signal here.
  let returningFromRedirect = false;
  try { returningFromRedirect = sessionStorage.getItem(REDIRECT_PENDING_KEY) === '1'; } catch (e) {}

  if ((expectedSignedIn || returningFromRedirect) && gate) gate.classList.add('quiet-check');

  showGateChecking(true);
  showGateSignedOut();

  if (!isConfigured) {
    // Firebase isn't set up at all — we can't require sign-in without it,
    // so fail safe by keeping the app locked and telling the person why,
    // rather than silently letting everyone in.
    if (gate) gate.classList.remove('quiet-check');
    showGateChecking(false);
    showGateError('Sign-in isn\u2019t configured yet. Contact the app owner.');
    updateAuthUI(null);
    return;
  }

  // Explicitly resolve any pending redirect sign-in up front. This doesn't
  // change what onAuthStateChanged eventually reports, but catching a
  // failure here (e.g. the redirect sign-in itself errored) lets us show a
  // clear message immediately rather than leaving the person stuck looking
  // at a sign-in screen with no explanation.
  getRedirectResult(auth).catch((err) => {
    console.error('Redirect sign-in failed:', err);
    try { sessionStorage.removeItem(REDIRECT_PENDING_KEY); } catch (e) {}
    if (gate) gate.classList.remove('quiet-check');
    showGateError('Sign-in failed. Please try again.');
  });

  onAuthStateChanged(auth, async (user) => {
    currentUser = user;
    updateAuthUI(user);
    // Whatever happens next, this round trip (if there was one) is over.
    try { sessionStorage.removeItem(REDIRECT_PENDING_KEY); } catch (e) {}

    if (!user) {
      if (gate) gate.classList.remove('quiet-check');
      showGateChecking(false);
      showGateSignedOut();
      lockApp();
      showPaymentWidget(false);
      if (unsubscribeSnapshot) { unsubscribeSnapshot(); unsubscribeSnapshot = null; }
      return;
    }

    // Admins always get a real check — the cache-and-trust shortcut below
    // is specifically about not re-verifying ordinary trial/paid users on
    // every visit, and doesn't need to apply to the one account that can
    // change everyone else's access anyway.
    const cached = isAdminUser(user) ? null : readAccessCache(user.uid);

    const unlockWith = (access) => {
      if (gate) gate.classList.remove('quiet-check');
      unlockApp();
      showGateError(null);
      showPaymentWidget(access.status === 'trial' && !isAdminUser(user));
    };

    if (cached) {
      // Trust the cache immediately — unlock right now, no network wait.
      showGateChecking(false);
      unlockWith(cached);
      try {
        const cloudData = await pullFromCloudOnce(user.uid);
        if (cloudData && window.NdaCloud.onRemoteData) {
          window.NdaCloud.onRemoteData(cloudData);
        } else if (window.NdaCloud.getLocalSnapshot) {
          await pushToCloud(window.NdaCloud.getLocalSnapshot());
        }
      } catch (err) {
        console.error('Initial cloud sync failed:', err);
        setSyncStatus('error', 'Sync error');
      }
      startListening(user.uid);
      document.getElementById('authModal').classList.remove('show');

      // Now verify for real, silently, in the background. This is what
      // makes an admin block or a trial expiry still eventually take
      // effect even though we didn't wait for it before unlocking.
      fetchBlockedMessage().catch(() => {});
      resolveAccess(user).then((realAccess) => {
        writeAccessCache(user.uid, realAccess);
        if (realAccess.status === 'blocked') {
          if (unsubscribeSnapshot) { unsubscribeSnapshot(); unsubscribeSnapshot = null; }
          showGateBlocked(cachedBlockedMessage);
          lockApp();
          showPaymentWidget(false);
        }
      }).catch((err) => {
        console.warn('Background access re-check failed (staying on cached access):', err);
      });
      return;
    }

    // No usable cache — first sign-in on this device/account, or the
    // cache was cleared. Fall back to the real check before unlocking,
    // same as before, just with fetchBlockedMessage and resolveAccess run
    // in parallel rather than one after another.
    let access;
    const [, accessResult] = await Promise.allSettled([
      fetchBlockedMessage(),
      resolveAccess(user)
    ]);
    if (accessResult.status === 'fulfilled') {
      access = accessResult.value;
    } else {
      console.error('Could not resolve access status:', accessResult.reason);
      access = { status: 'blocked' };
    }
    showGateChecking(false);

    if (access.status === 'blocked') {
      if (gate) gate.classList.remove('quiet-check');
      showGateBlocked(cachedBlockedMessage);
      lockApp();
      showPaymentWidget(false);
      return;
    }

    writeAccessCache(user.uid, access);
    unlockWith(access);
    try {
      const cloudData = await pullFromCloudOnce(user.uid);
      if (cloudData && window.NdaCloud.onRemoteData) {
        window.NdaCloud.onRemoteData(cloudData);
      } else if (window.NdaCloud.getLocalSnapshot) {
        await pushToCloud(window.NdaCloud.getLocalSnapshot());
      }
    } catch (err) {
      console.error('Initial cloud sync failed:', err);
      setSyncStatus('error', 'Sync error');
    }
    startListening(user.uid);
    document.getElementById('authModal').classList.remove('show');
  });
}

// Public API consumed by index.html.
// index.html's inline script runs BEFORE this module (see the <script> tag
// order in index.html) and sets onRemoteData / getLocalSnapshot on
// window.NdaCloud. We merge into that object rather than replacing it, so
// those hooks survive regardless of load order either way.
window.NdaCloud = Object.assign(window.NdaCloud || {}, {
  isConfigured,
  isSignedIn: () => !!currentUser,
  onRemoteData: (window.NdaCloud && window.NdaCloud.onRemoteData) || null,
  getLocalSnapshot: (window.NdaCloud && window.NdaCloud.getLocalSnapshot) || null,
  push: (payload) => pushToCloud(payload)
});

document.addEventListener('DOMContentLoaded', init);
