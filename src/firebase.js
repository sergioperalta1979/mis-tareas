import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth, GoogleAuthProvider } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyBZSl6WTpZ5zcq1m3MOzkYUfHZ-4_IsJjM",
  authDomain: "mis-tareas-b1f5e.firebaseapp.com",
  projectId: "mis-tareas-b1f5e",
  storageBucket: "mis-tareas-b1f5e.firebasestorage.app",
  messagingSenderId: "1023812920399",
  appId: "1:1023812920399:web:c59f1dfa402140fb9c763a"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
