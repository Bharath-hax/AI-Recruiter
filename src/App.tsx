/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useState } from 'react';
import type { User } from 'firebase/auth';
import { GoogleSignInGate } from './components/GoogleSignInGate.tsx';
import {
  initAuthListener,
  signInWithGooglePopup,
  signOutUser,
} from './lib/firebase.ts';
import { EmployeePortalPage } from './pages/EmployeePortalPage.tsx';
import { ManagerDashboardPage } from './pages/ManagerDashboardPage.tsx';

function getPortalTokenFromLocation(): string | null {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('portal')?.trim();
  return token && token.length > 0 ? token : null;
}

export default function App() {
  const [portalToken, setPortalToken] = useState<string | null>(() =>
    getPortalTokenFromLocation()
  );
  const [authReady, setAuthReady] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [workspaceToken, setWorkspaceToken] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = initAuthListener((currentUser, wsToken) => {
      setUser(currentUser);
      setWorkspaceToken(wsToken);
      setAuthReady(true);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    const handlePopState = () => {
      setPortalToken(getPortalTokenFromLocation());
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const navigateToEmployeePortal = useCallback((token: string) => {
    const nextUrl = `/?portal=${encodeURIComponent(token)}`;
    window.history.pushState({}, '', nextUrl);
    setPortalToken(token);
  }, []);

  const navigateToManagerDashboard = useCallback(() => {
    window.history.pushState({}, '', '/');
    setPortalToken(null);
  }, []);

  const handleGoogleSignIn = async () => {
    setSigningIn(true);
    setAuthError(null);
    try {
      const res = await signInWithGooglePopup();
      setUser(res.user);
      setWorkspaceToken(res.workspaceAccessToken);
    } catch (err: unknown) {
      setAuthError(
        err instanceof Error ? err.message : 'Google Sign-In failed. Please try again.'
      );
    } finally {
      setSigningIn(false);
    }
  };

  const handleSignOut = async () => {
    await signOutUser();
    setUser(null);
    setWorkspaceToken(null);
  };

  // PAGE TWO: Dedicated Employee AI Voice Bot & GitHub Submission Portal (/?portal=<token>)
  if (portalToken) {
    return (
      <EmployeePortalPage
        portalToken={portalToken}
        canReturnToManager={Boolean(user)}
        onReturnToManager={navigateToManagerDashboard}
      />
    );
  }

  // PAGE ONE: Manager Dashboard (/)
  if (!authReady) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-8">
        <div className="w-64 h-3 bg-slate-200 rounded" />
      </div>
    );
  }

  if (!user) {
    return (
      <GoogleSignInGate
        onSignIn={handleGoogleSignIn}
        isLoading={signingIn}
        error={authError}
      />
    );
  }

  return (
    <ManagerDashboardPage
      workspaceConnected={Boolean(workspaceToken)}
      onReconnectWorkspace={handleGoogleSignIn}
      onSignOut={handleSignOut}
      onOpenEmployeePortal={navigateToEmployeePortal}
    />
  );
}
