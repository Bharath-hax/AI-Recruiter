import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  onAuthStateChanged,
  type User,
} from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json' with { type: 'json' };

export const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.events',
];

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const googleAuthProvider = new GoogleAuthProvider();

for (const scope of SCOPES) {
  googleAuthProvider.addScope(scope);
}

let isSigningIn = false;
let cachedWorkspaceAccessToken: string | null = null;

export const initAuthListener = (
  onUserChange: (user: User | null, workspaceToken: string | null) => void
) => {
  return onAuthStateChanged(auth, (user) => {
    if (!user && !isSigningIn) {
      cachedWorkspaceAccessToken = null;
    }
    onUserChange(user, cachedWorkspaceAccessToken);
  });
};

export const signInWithGooglePopup = async (): Promise<{
  user: User;
  idToken: string;
  workspaceAccessToken: string | null;
}> => {
  try {
    isSigningIn = true;
    const result = await signInWithPopup(auth, googleAuthProvider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    cachedWorkspaceAccessToken = credential?.accessToken ?? null;
    const idToken = await result.user.getIdToken();
    return {
      user: result.user,
      idToken,
      workspaceAccessToken: cachedWorkspaceAccessToken,
    };
  } finally {
    isSigningIn = false;
  }
};

export const getWorkspaceAccessToken = (): string | null => {
  return cachedWorkspaceAccessToken;
};

export const signOutUser = async () => {
  cachedWorkspaceAccessToken = null;
  await auth.signOut();
};
