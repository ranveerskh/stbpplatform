import { initializeApp, getApps } from "firebase/app";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut } from "firebase/auth";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "stbpplay-platform",
  appId: import.meta.env.VITE_FIREBASE_APP_ID || "",
};

export const firebaseReady = Boolean(firebaseConfig.apiKey && firebaseConfig.authDomain && firebaseConfig.projectId && firebaseConfig.appId);
export const firebaseAuth = firebaseReady
  ? getAuth(getApps()[0] || initializeApp(firebaseConfig))
  : null;

export async function signInAdmin() {
  if (!firebaseAuth) throw new Error("Firebase web app settings are not configured yet.");
  return signInWithPopup(firebaseAuth, new GoogleAuthProvider());
}

export async function signOutAdmin() {
  if (firebaseAuth) await signOut(firebaseAuth);
}

export async function getAdminToken() {
  if (!firebaseAuth?.currentUser) throw new Error("Sign in first.");
  return firebaseAuth.currentUser.getIdToken();
}
