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
  signOut,
  onAuthStateChanged
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
const UPI_AMOUNT = '49';
const UPI_PAYEE_NAME = 'NDA Register';

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

function setSyncStatus(state, label) {
  const el = document.getElementById('syncStatus');
  if (!el) return;
  el.classList.remove('synced', 'syncing', 'error', 'show');
  if (state) {
    el.classList.add(state, 'show');
  }
  el.innerHTML = `<span class="dot"></span>${label || ''}`;
}

// ---- Mandatory sign-in + access gate ----
// The app UI (.wrap) is hidden by CSS until <body> has the "app-unlocked"
// class. These functions are the only things that add/remove it, and they
// also switch which panel of #authGate is visible.
function unlockApp() {
  document.body.classList.add('app-unlocked');
}

function lockApp() {
  document.body.classList.remove('app-unlocked');
  const gate = document.getElementById('authGate');
  if (gate) gate.classList.remove('checking');
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
}

function showGateBlocked(message) {
  document.getElementById('gateSignedOutView').style.display = 'none';
  document.getElementById('gateBlockedView').style.display = '';
  document.getElementById('gateBlockedMessage').textContent = message || cachedBlockedMessage;
  const gateUpiLink = document.getElementById('gateUpiLink');
  if (gateUpiLink) {
    gateUpiLink.href = buildUpiLink(currentUser ? currentUser.email : null);
  }
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
    if (user.photoURL) {
      // If the Google profile photo fails to load (e.g. flaky network,
      // some carriers/networks blocking Google's photo CDN), fall back to
      // showing the person's initial instead of leaving a blank box.
      authAvatar.innerHTML = `<img src="${user.photoURL}" alt="" onerror="this.parentElement.textContent='${initial}';">`;
      authAvatar.classList.add('signed-in');
    } else {
      authAvatar.textContent = initial;
      authAvatar.classList.add('signed-in');
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
      } catch (dirErr) {
        // Non-fatal: the user's own trial access still works even if this
        // mirror write fails; they just won't show up in the admin list
        // until the next successful sync.
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
async function backfillDirectoryIfMissing(user, meta) {
  if (isAdminUser(user)) return;
  try {
    const dirSnap = await getDoc(userDirectoryRef(user.uid));
    if (dirSnap.exists()) return; // already mirrored, nothing to do
    if (meta.status !== 'trial') return; // can only self-create a trial entry
    await setDoc(userDirectoryRef(user.uid), {
      email: meta.email || user.email,
      displayName: meta.displayName || user.displayName || '',
      status: 'trial',
      trialStartedAt: meta.trialStartedAt,
      trialEndsAt: meta.trialEndsAt,
      createdAt: meta.createdAt || meta.trialStartedAt
    });
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

async function handleGoogleSignIn() {
  if (!isConfigured) {
    showAuthError('Cloud sync isn\u2019t set up yet. See js/firebase-config.js for setup steps.');
    showGateError('Sign-in isn\u2019t configured yet. Contact the app owner.');
    return;
  }
  showAuthError(null);
  showGateError(null);
  try {
    const provider = new GoogleAuthProvider();
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
  await signOut(auth);
  document.getElementById('authModal').classList.remove('show');
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
  showGateChecking(true);
  showGateSignedOut();

  if (!isConfigured) {
    // Firebase isn't set up at all — we can't require sign-in without it,
    // so fail safe by keeping the app locked and telling the person why,
    // rather than silently letting everyone in.
    showGateChecking(false);
    showGateError('Sign-in isn\u2019t configured yet. Contact the app owner.');
    updateAuthUI(null);
    return;
  }

  onAuthStateChanged(auth, async (user) => {
    currentUser = user;
    updateAuthUI(user);

    if (!user) {
      showGateChecking(false);
      showGateSignedOut();
      lockApp();
      showPaymentWidget(false);
      if (unsubscribeSnapshot) { unsubscribeSnapshot(); unsubscribeSnapshot = null; }
      return;
    }

    // Signed in — now check trial/blocked/paid status before unlocking.
    await fetchBlockedMessage();
    let access;
    try {
      access = await resolveAccess(user);
    } catch (err) {
      console.error('Could not resolve access status:', err);
      access = { status: 'blocked' };
    }
    showGateChecking(false);

    if (access.status === 'blocked') {
      showGateBlocked(cachedBlockedMessage);
      lockApp();
      showPaymentWidget(false);
      return;
    }

    // trial (unexpired) or paid — proceed as before.
    unlockApp();
    showGateError(null);
    showPaymentWidget(access.status === 'trial' && !isAdminUser(user));
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
