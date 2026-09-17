// ============================================================================
// Firebase init: Auth (Google) + Firestore sync for the NDA Register app.
//
// This file does NOT know anything about NDA-specific data structures beyond
// the four top-level keys the app already persists locally: entries, profile,
// shiftPresets, viewMode. It exposes a small window.NdaCloud API that
// index.html's existing saveState()/loadState() functions call into.
//
// Design:
//  - Local-first: the app keeps working offline via localStorage exactly as
//    before. Firestore is an additional, best-effort sync layer.
//  - Each signed-in user's data lives at: users/{uid}/ndaRegister/data
//  - Data is private: Firestore security rules (see firestore.rules) only
//    allow a user to read/write their own document.
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
  enableIndexedDbPersistence
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const isConfigured = firebaseConfig.apiKey && !firebaseConfig.apiKey.startsWith('REPLACE_WITH');

let app, auth, db, currentUser = null;
let unsubscribeSnapshot = null;
let suppressNextRemoteEcho = false;
let onRemoteDataCallback = null; // set by index.html

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

function setSyncStatus(state, label) {
  const el = document.getElementById('syncStatus');
  if (!el) return;
  el.classList.remove('synced', 'syncing', 'error', 'show');
  if (state) {
    el.classList.add(state, 'show');
  }
  el.innerHTML = `<span class="dot"></span>${label || ''}`;
}

function updateAuthUI(user) {
  const authAvatar = document.getElementById('authAvatar');
  const authBtn = document.getElementById('authBtn');
  const panelOut = document.getElementById('authPanelSignedOut');
  const panelIn = document.getElementById('authPanelSignedIn');

  if (user) {
    authBtn.title = `Signed in as ${user.email}`;
    authBtn.setAttribute('aria-label', authBtn.title);
    if (user.photoURL) {
      authAvatar.innerHTML = `<img src="${user.photoURL}" alt="">`;
      authAvatar.classList.add('signed-in');
    } else {
      authAvatar.textContent = (user.displayName || user.email || '?').charAt(0).toUpperCase();
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

function userDocRef(uid) {
  return doc(db, 'users', uid, 'ndaRegister', 'data');
}

function startListening(uid) {
  if (unsubscribeSnapshot) unsubscribeSnapshot();
  setSyncStatus('syncing', 'Syncing…');
  unsubscribeSnapshot = onSnapshot(
    userDocRef(uid),
    (snap) => {
      setSyncStatus('synced', 'Synced');
      if (snap.exists() && !suppressNextRemoteEcho) {
        const data = snap.data();
        if (onRemoteDataCallback) onRemoteDataCallback(data);
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
    await setDoc(userDocRef(currentUser.uid), {
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
  const snap = await getDoc(userDocRef(uid));
  return snap.exists() ? snap.data() : null;
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

async function handleGoogleSignIn() {
  if (!isConfigured) {
    showAuthError('Cloud sync isn\u2019t set up yet. See js/firebase-config.js for setup steps.');
    return;
  }
  showAuthError(null);
  try {
    const provider = new GoogleAuthProvider();
    await signInWithPopup(auth, provider);
  } catch (err) {
    console.error('Google sign-in failed:', err);
    if (err.code === 'auth/popup-closed-by-user') return;
    showAuthError('Sign-in failed. Please try again.');
  }
}

async function handleSignOut() {
  if (unsubscribeSnapshot) { unsubscribeSnapshot(); unsubscribeSnapshot = null; }
  await signOut(auth);
  document.getElementById('authModal').classList.remove('show');
}

function wireUpUI() {
  const authBtn = document.getElementById('authBtn');
  const authModal = document.getElementById('authModal');
  const authModalClose = document.getElementById('authModalClose');
  const googleSignInBtn = document.getElementById('googleSignInBtn');
  const signOutBtn = document.getElementById('signOutBtn');

  authBtn.addEventListener('click', () => authModal.classList.add('show'));
  authModalClose.addEventListener('click', () => authModal.classList.remove('show'));
  authModal.addEventListener('click', (e) => { if (e.target === authModal) authModal.classList.remove('show'); });
  googleSignInBtn.addEventListener('click', handleGoogleSignIn);
  signOutBtn.addEventListener('click', handleSignOut);
}

function init() {
  wireUpUI();

  if (!isConfigured) {
    updateAuthUI(null);
    return;
  }

  onAuthStateChanged(auth, async (user) => {
    currentUser = user;
    updateAuthUI(user);

    if (user) {
      // On sign-in, merge: if the cloud has data, prefer it (most recent
      // cross-device state); otherwise push whatever is currently local so
      // the first-ever sign-in doesn't wipe fresh local entries.
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
    } else {
      if (unsubscribeSnapshot) { unsubscribeSnapshot(); unsubscribeSnapshot = null; }
    }
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
