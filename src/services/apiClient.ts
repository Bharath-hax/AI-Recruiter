import { auth, getWorkspaceAccessToken } from '../lib/firebase.ts';

async function buildAuthHeaders(isJson = true): Promise<Record<string, string>> {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new Error('Authentication required. Please sign in with Google.');
  }
  const idToken = await currentUser.getIdToken();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${idToken}`,
  };
  const workspaceToken = getWorkspaceAccessToken();
  if (workspaceToken) {
    headers['X-Workspace-Token'] = workspaceToken;
  }
  if (isJson) {
    headers['Content-Type'] = 'application/json';
  }
  return headers;
}

export async function apiFetch<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const headers = await buildAuthHeaders(options.body !== undefined);
  const res = await fetch(path, {
    ...options,
    headers: {
      ...headers,
      ...(options.headers as Record<string, string> | undefined),
    },
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Request failed with HTTP ${res.status}`);
  }
  return data as T;
}

export async function portalFetch<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(path, {
    ...options,
    headers: {
      ...headers,
      ...(options.headers as Record<string, string> | undefined),
    },
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Portal request failed with HTTP ${res.status}`);
  }
  return data as T;
}

export async function apiDownloadBlob(
  path: string,
  downloadFileName: string
): Promise<Blob> {
  const headers = await buildAuthHeaders(false);
  const res = await fetch(path, { headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Download failed with HTTP ${res.status}`);
  }
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = downloadFileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
  return blob;
}
