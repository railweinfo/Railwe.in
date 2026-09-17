// ============================================================================
// FIREBASE CONFIG — EDIT THIS FILE, NOTHING ELSE
// ============================================================================
// 1. Go to https://console.firebase.google.com
// 2. Create a new project (use your new Gmail account to sign in first)
// 3. Inside the project: Build > Authentication > Get started > enable "Google"
//    as a sign-in provider
// 4. Inside the project: Build > Firestore Database > Create database
//    (start in "production mode" — the security rules in firestore.rules
//    handle access control)
// 5. Project settings (gear icon) > General > "Your apps" > Add app > Web (</>)
// 6. Copy the firebaseConfig object Firebase gives you and paste the values
//    below, replacing the placeholders.
// 7. Deploy firestore.rules (see README.md) so users can only read/write
//    their own data.
// ============================================================================

export const firebaseConfig = {
  apiKey: "AIzaSyCiBxQNgF4dvRfhEEf1q7nup7txcTc7DMw",
  authDomain: "nda-app-d52e1.firebaseapp.com",
  projectId: "nda-app-d52e1",
  storageBucket: "nda-app-d52e1.firebasestorage.app",
  messagingSenderId: "864253343132",
  appId: "1:864253343132:web:5787b48d56336a71c98459"
};
