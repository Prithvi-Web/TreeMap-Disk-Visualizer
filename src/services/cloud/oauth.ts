import http from 'http';
import crypto from 'crypto';
import { URL } from 'url';
import { readJsonFile, writeJsonFile } from '../storage';
import { AppError } from '../../middleware/errorHandler';

/**
 * cloud/oauth — OAuth 2.0 authorization-code flow with PKCE for the cloud
 * providers (Phase 8). A short-lived loopback server on a FIXED port catches
 * the redirect (fixed so users can register the exact redirect URI in their
 * provider console); web mode gets a copy-paste fallback where the user
 * pastes the redirect URL or code instead. Tokens live in cloud-tokens.json
 * in the app-data dir — locally, never anywhere else.
 */

export const LOOPBACK_PORT = 53682;
export const REDIRECT_URI = `http://127.0.0.1:${LOOPBACK_PORT}/oauth/callback`;
const AUTH_TIMEOUT_MS = 5 * 60_000;
const TOKENS_FILE = 'cloud-tokens.json';

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms when accessToken expires (0 = unknown/never). */
  expiresAt: number;
  /** Account label ("you@gmail.com") captured at connect time. */
  account?: string;
}

type TokenStore = Record<string, TokenSet>;

export async function getTokens(providerId: string): Promise<TokenSet | undefined> {
  const store = await readJsonFile<TokenStore>(TOKENS_FILE, {});
  return store[providerId];
}

export async function saveTokens(providerId: string, tokens: TokenSet): Promise<void> {
  const store = await readJsonFile<TokenStore>(TOKENS_FILE, {});
  store[providerId] = tokens;
  await writeJsonFile(TOKENS_FILE, store);
}

/** Disconnect: wipe this provider's tokens (the whole point of the button). */
export async function deleteTokens(providerId: string): Promise<void> {
  const store = await readJsonFile<TokenStore>(TOKENS_FILE, {});
  delete store[providerId];
  await writeJsonFile(TOKENS_FILE, store);
}

/* ---------------- PKCE ---------------- */

const b64url = (buf: Buffer): string => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function makePkce(): { verifier: string; challenge: string } {
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/* ---------------- pending authorizations ---------------- */

interface PendingAuth {
  providerId: string;
  verifier: string;
  state: string;
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  extraTokenParams?: Record<string, string>;
  timer: NodeJS.Timeout;
}

let pending: PendingAuth | null = null;
let loopback: http.Server | null = null;

function stopLoopback(): void {
  if (loopback) {
    loopback.close();
    loopback = null;
  }
  if (pending) {
    clearTimeout(pending.timer);
    pending = null;
  }
}

/** Called on graceful shutdown alongside the other cleanup. */
export function stopOAuth(): void {
  stopLoopback();
}

export interface AuthStartParams {
  providerId: string;
  authUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  scope: string;
  extraAuthParams?: Record<string, string>;
  extraTokenParams?: Record<string, string>;
}

export interface AuthStart {
  authorizeUrl: string;
  redirectUri: string;
}

/**
 * Begin an authorization: build the consent URL and start the loopback
 * listener. Resolves once the listener is actually bound, so the redirect
 * can never race the bind. Completion happens either via the loopback
 * redirect or via finishAuthManually() with the pasted redirect URL/code.
 */
export function startAuth(params: AuthStartParams, onDone: (err: Error | null) => void): Promise<AuthStart> {
  stopLoopback(); // one auth at a time — a fresh attempt supersedes the old

  const { verifier, challenge } = makePkce();
  const state = b64url(crypto.randomBytes(16));
  const url = new URL(params.authUrl);
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', params.scope);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  for (const [k, v] of Object.entries(params.extraAuthParams ?? {})) url.searchParams.set(k, v);

  pending = {
    providerId: params.providerId,
    verifier,
    state,
    tokenUrl: params.tokenUrl,
    clientId: params.clientId,
    clientSecret: params.clientSecret,
    extraTokenParams: params.extraTokenParams,
    timer: setTimeout(() => {
      stopLoopback();
      onDone(new Error('Sign-in timed out — try connecting again'));
    }, AUTH_TIMEOUT_MS),
  };
  pending.timer.unref();

  loopback = http.createServer((req, res) => {
    void (async () => {
      try {
        const reqUrl = new URL(req.url ?? '/', `http://127.0.0.1:${LOOPBACK_PORT}`);
        if (reqUrl.pathname !== '/oauth/callback') {
          res.writeHead(404).end();
          return;
        }
        await completeWithRedirect(reqUrl);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body style="font-family:sans-serif;background:#0b1220;color:#dbe4f3;display:flex;align-items:center;justify-content:center;height:100vh;"><div><h2>✅ Connected</h2><p>You can close this tab and return to TreeMap.</p></div></body></html>');
        stopLoopback();
        onDone(null);
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Sign-in failed: ' + (err instanceof Error ? err.message : String(err)));
        stopLoopback();
        onDone(err instanceof Error ? err : new Error(String(err)));
      }
    })();
  });
  return new Promise<AuthStart>((resolve, reject) => {
    loopback!.once('error', (err) => {
      stopLoopback();
      const wrapped = new Error(`Couldn't open the sign-in listener on port ${LOOPBACK_PORT} (${err.message}) — is another app using it?`);
      reject(wrapped);
      onDone(wrapped);
    });
    loopback!.listen(LOOPBACK_PORT, '127.0.0.1', () => {
      loopback!.unref();
      resolve({ authorizeUrl: url.toString(), redirectUri: REDIRECT_URI });
    });
  });
}

/** Shared: validate state, exchange the code, persist tokens. */
async function completeWithRedirect(redirect: URL): Promise<void> {
  if (!pending) throw new Error('No sign-in in progress');
  const err = redirect.searchParams.get('error');
  if (err) throw new Error(redirect.searchParams.get('error_description') || err);
  const code = redirect.searchParams.get('code');
  const state = redirect.searchParams.get('state');
  if (!code) throw new Error('The redirect is missing the authorization code');
  if (state !== pending.state) throw new Error('State mismatch — start the sign-in again');
  await exchangeCode(code);
}

/** Copy-paste fallback: accepts the full redirect URL or just the code. */
export async function finishAuthManually(input: string): Promise<string> {
  if (!pending) throw new AppError(409, 'NO_AUTH_PENDING', 'Start the connection first, then paste the code');
  const trimmed = input.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    await completeWithRedirect(new URL(trimmed));
  } else {
    await exchangeCode(trimmed);
  }
  const provider = pending.providerId;
  stopLoopback();
  return provider;
}

async function exchangeCode(code: string): Promise<void> {
  if (!pending) throw new Error('No sign-in in progress');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: pending.clientId,
    code_verifier: pending.verifier,
    ...(pending.clientSecret ? { client_secret: pending.clientSecret } : {}),
    ...(pending.extraTokenParams ?? {}),
  });
  const resp = await fetch(pending.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const json = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  if (!resp.ok || typeof json.access_token !== 'string') {
    throw new Error(`Token exchange failed (${resp.status}): ${String(json.error_description ?? json.error ?? 'unknown error').slice(0, 200)}`);
  }
  await saveTokens(pending.providerId, {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : undefined,
    expiresAt: typeof json.expires_in === 'number' ? Date.now() + json.expires_in * 1000 : 0,
  });
}

/* ---------------- refresh ---------------- */

/** A valid access token for this provider, refreshing if within a minute of expiry. */
export async function freshAccessToken(
  providerId: string,
  tokenUrl: string,
  clientId: string,
  clientSecret?: string,
): Promise<string> {
  const tokens = await getTokens(providerId);
  if (!tokens) throw new AppError(401, 'NOT_CONNECTED', 'That account is not connected');
  if (!tokens.expiresAt || tokens.expiresAt - Date.now() > 60_000) return tokens.accessToken;
  if (!tokens.refreshToken) return tokens.accessToken; // provider gave no refresh token — use until it 401s

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
    client_id: clientId,
    ...(clientSecret ? { client_secret: clientSecret } : {}),
  });
  const resp = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const json = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  if (!resp.ok || typeof json.access_token !== 'string') {
    throw new AppError(401, 'REFRESH_FAILED', 'The saved sign-in expired — reconnect the account in Settings');
  }
  const next: TokenSet = {
    ...tokens,
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : tokens.refreshToken,
    expiresAt: typeof json.expires_in === 'number' ? Date.now() + json.expires_in * 1000 : 0,
  };
  await saveTokens(providerId, next);
  return next.accessToken;
}
