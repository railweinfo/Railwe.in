// ============================================================================
// Admin panel logic for admin.html.
//
// Only the ADMIN_EMAIL account can see anything past the sign-in gate here.
// Anyone else who signs in gets a clear "not an admin" message and a
// sign-out button — they never see the user list or the message editor.
//
// This file is intentionally separate from js/firebase-init.js (used by
// index.html) so the admin surface has no code path shared with the regular
// app, and can be reasoned about on its own.
//
// Security note: hiding the UI here is a convenience, not the real
// protection. The real protection is firestore.rules, which only allows
// writes to status fields / the config/access doc from the admin's UID.
// Even if someone bypassed this page entirely and called Firestore
// directly, the rules would still reject them.
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
  updateDoc,
  getDoc,
  getDocs,
  collection,
  serverTimestamp,
  Timestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const ADMIN_EMAIL = 'railwe.info@gmail.com';
const TRIAL_DAYS = 30;
const DEFAULT_BLOCKED_MESSAGE = 'Your 30-day trial has ended. Please contact the administrator to continue using this app.';

const isConfigured = firebaseConfig.apiKey && !firebaseConfig.apiKey.startsWith('REPLACE_WITH');

let app, auth, db;
let adminUsersCache = [];
let adminFilter = 'all';

if (isConfigured) {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
} else {
  console.warn('Admin panel: Firebase is not configured. Edit js/firebase-config.js.');
}

function isAdminUser(user) {
  return !!user && user.email === ADMIN_EMAIL;
}

function accessConfigRef() {
  return doc(db, 'config', 'access');
}

function userMetaRef(uid) {
  return doc(db, 'users', uid, 'ndaRegister', 'meta');
}

function userDirectoryRef(uid) {
  return doc(db, 'userDirectory', uid);
}

// ---- Gate state ----

function showChecking(isChecking) {
  const gate = document.getElementById('authGate');
  gate.classList.toggle('checking', isChecking);
  document.getElementById('gateLoading').style.display = isChecking ? '' : 'none';
}

function showSignedOut() {
  document.getElementById('gateSignedOut').style.display = '';
  document.getElementById('gateDenied').style.display = 'none';
}

function showDenied(email) {
  document.getElementById('gateSignedOut').style.display = 'none';
  document.getElementById('gateDenied').style.display = '';
  document.getElementById('deniedMessage').textContent =
    `The account ${email || ''} doesn't have admin access.`;
}

function showGateError(message) {
  const el = document.getElementById('gateError');
  if (message) {
    el.textContent = message;
    el.classList.add('show');
  } else {
    el.classList.remove('show');
    el.textContent = '';
  }
}

function unlockAdmin() {
  document.body.classList.add('admin-unlocked');
}

function lockAdmin() {
  document.body.classList.remove('admin-unlocked');
}

// ---- Auth actions ----

async function handleGoogleSignIn() {
  if (!isConfigured) {
    showGateError('Firebase isn\u2019t configured. Edit js/firebase-config.js.');
    return;
  }
  showGateError(null);
  try {
    const provider = new GoogleAuthProvider();
    await signInWithPopup(auth, provider);
  } catch (err) {
    console.error('Sign-in failed:', err);
    if (err.code === 'auth/popup-closed-by-user') return;
    showGateError('Sign-in failed. Please try again.');
  }
}

async function handleSignOut() {
  await signOut(auth);
}

// ---- Blocked-message editor ----

async function loadBlockedMessage() {
  const textarea = document.getElementById('blockedMessage');
  try {
    const snap = await getDoc(accessConfigRef());
    textarea.value = (snap.exists() && snap.data().blockedMessage) || DEFAULT_BLOCKED_MESSAGE;
  } catch (err) {
    console.error('Could not load blocked-message config:', err);
    textarea.value = DEFAULT_BLOCKED_MESSAGE;
  }
}

async function saveBlockedMessage() {
  const textarea = document.getElementById('blockedMessage');
  const status = document.getElementById('messageSaveStatus');
  try {
    await setDoc(accessConfigRef(), { blockedMessage: textarea.value, updatedAt: serverTimestamp() });
    status.textContent = 'Saved.';
    setTimeout(() => { status.textContent = ''; }, 2500);
  } catch (err) {
    console.error('Could not save blocked-message config:', err);
    status.textContent = 'Failed to save.';
  }
}

// ---- User list ----

function formatDate(d) {
  if (!d) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function daysLeft(d) {
  if (!d) return null;
  return Math.ceil((d.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

function renderUserList() {
  const list = document.getElementById('userList');
  const filtered = adminFilter === 'all'
    ? adminUsersCache
    : adminUsersCache.filter(u => u.status === adminFilter);

  if (filtered.length === 0) {
    list.innerHTML = '<p class="loading-msg">No users in this category.</p>';
    return;
  }

  list.innerHTML = filtered.map(u => {
    const endsAt = u.trialEndsAt;
    let sub = '';
    if (u.status === 'trial' && endsAt) {
      const left = daysLeft(endsAt);
      sub = left >= 0 ? `Trial ends ${formatDate(endsAt)} (${left}d left)` : `Trial ended ${formatDate(endsAt)}`;
    } else if (u.status === 'paid') {
      sub = 'Permanent access';
    } else if (u.status === 'blocked') {
      sub = endsAt ? `Trial ended ${formatDate(endsAt)}` : 'Blocked by admin';
    }
    return `
      <div class="user-card" data-uid="${u.uid}">
        <div class="user-top">
          <div>
            <div class="user-email">${escapeHtml(u.email || u.uid)}</div>
            <div class="user-sub">${escapeHtml(sub)}</div>
          </div>
          <span class="status-badge ${u.status}">${u.status}</span>
        </div>
        <div class="user-actions">
          <button class="action-btn approve" data-action="paid" data-uid="${u.uid}" ${u.status === 'paid' ? 'disabled' : ''}>Make permanent</button>
          <button class="action-btn extend" data-action="trial" data-uid="${u.uid}" ${u.status === 'trial' ? 'disabled' : ''}>Restart trial</button>
          <button class="action-btn block" data-action="blocked" data-uid="${u.uid}" ${u.status === 'blocked' ? 'disabled' : ''}>Block</button>
        </div>
      </div>
    `;
  }).join('');

  list.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', () => handleAdminAction(btn.dataset.uid, btn.dataset.action));
  });
}

async function handleAdminAction(uid, action) {
  try {
    const updates = { status: action };
    if (action === 'trial') {
      const now = Timestamp.now();
      updates.trialStartedAt = now;
      updates.trialEndsAt = Timestamp.fromMillis(now.toMillis() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
    }
    // Keep both records in sync: meta (used by the app's own access check)
    // and userDirectory (the flat mirror this admin panel lists from).
    await Promise.all([
      updateDoc(userMetaRef(uid), updates),
      updateDoc(userDirectoryRef(uid), updates)
    ]);
    await loadUsers();
  } catch (err) {
    console.error('Admin action failed:', err);
    alert('Could not update this user. Check the console for details.');
  }
}

async function loadUsers() {
  const list = document.getElementById('userList');
  list.innerHTML = '<p class="loading-msg">Loading users&hellip;</p>';
  try {
    // Plain top-level collection read — no collection-group query needed,
    // so this only relies on the straightforward "admin can list
    // userDirectory" rule in firestore.rules.
    const snap = await getDocs(collection(db, 'userDirectory'));

    const users = [];
    snap.forEach(docSnap => {
      const data = docSnap.data();
      users.push({
        uid: docSnap.id,
        email: data.email,
        status: data.status,
        trialEndsAt: data.trialEndsAt && data.trialEndsAt.toDate ? data.trialEndsAt.toDate() : null,
        createdAt: data.createdAt && data.createdAt.toDate ? data.createdAt.toDate() : null
      });
    });
    users.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    adminUsersCache = users;
    renderUserList();
  } catch (err) {
    console.error('Could not load users:', err);
    const detail = (err && (err.code || err.message)) ? `${err.code || ''} ${err.message || ''}`.trim() : String(err);
    list.innerHTML = `<p class="loading-msg">Could not load users: ${escapeHtml(detail)}</p>`;
  }
}

// ---- Wiring ----

function wireUpUI() {
  document.getElementById('gateGoogleSignInBtn').addEventListener('click', handleGoogleSignIn);
  document.getElementById('gateSignOutBtn').addEventListener('click', handleSignOut);
  document.getElementById('topSignOutBtn').addEventListener('click', handleSignOut);
  document.getElementById('saveMessageBtn').addEventListener('click', saveBlockedMessage);

  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      adminFilter = btn.dataset.filter;
      renderUserList();
    });
  });
}

function init() {
  wireUpUI();
  showChecking(true);
  showSignedOut();

  if (!isConfigured) {
    showChecking(false);
    showGateError('Firebase isn\u2019t configured. Edit js/firebase-config.js.');
    return;
  }

  onAuthStateChanged(auth, async (user) => {
    showChecking(false);

    if (!user) {
      showSignedOut();
      lockAdmin();
      return;
    }

    if (!isAdminUser(user)) {
      showDenied(user.email);
      lockAdmin();
      return;
    }

    // Confirmed admin.
    unlockAdmin();
    loadBlockedMessage();
    loadUsers();
  });
}

document.addEventListener('DOMContentLoaded', init);
