import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import { getFunctions } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-functions.js';

// Firebase web config is public by design; database access is protected by
// Firestore rules and admin-checked Cloud Functions.
const firebaseConfig = {
  apiKey: 'AIzaSyCH97fgA6N3gHW4EOUS6eTuoDrzyi722Y8',
  authDomain: 'stbpplay-platform.firebaseapp.com',
  projectId: 'stbpplay-platform',
  storageBucket: 'stbpplay-platform.firebasestorage.app',
  messagingSenderId: '381757826652',
  appId: '1:381757826652:web:1eb1071963ec407ccb6899'
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const functions = getFunctions(app, 'northamerica-northeast1');
