import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { request, type AuthState } from './features/auth/api';
import { ProspectsWorkspace } from './features/prospects/ProspectsWorkspace';
import { DiscoveryWorkspace } from './features/discovery/DiscoveryWorkspace';
import './styles.css';

const initialSetupToken = new URLSearchParams(window.location.hash.slice(1)).get('setup') || '';
const temporaryLoginPassword = import.meta.env.DEV ? import.meta.env.VITE_TEMPORARY_LOGIN_PASSWORD || '' : '';

export default function App() {
  const [state, setState] = useState<AuthState | null>(null);
  const [initialError, setInitialError] = useState('');
  const username = 'ehudaiuser';
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pendingState = useRef<Promise<AuthState> | null>(null);
  const setupMode = !!state?.setupRequired && !!initialSetupToken;

  const loadState = useCallback(async () => {
    setInitialError('');
    // Coalesce StrictMode's initial effects into one cookie/CSRF handshake.
    pendingState.current ??= request<AuthState>('/auth/state');
    const operation = pendingState.current;
    try {
      const result = await operation;
      setState(result);
    } catch (cause) { setInitialError(cause instanceof Error ? cause.message : 'Could not load sign-in.'); }
    finally { if (pendingState.current === operation) pendingState.current = null; }
  }, []);

  useEffect(() => { void loadState(); }, [loadState]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!state || busy) return;
    setError('');
    if (setupMode && password !== confirmation) {
      setError('The passwords do not match. Enter the same password in both fields.');
      return;
    }
    setBusy(true);
    try {
      const result = await request<{ username: string; csrfToken: string }>(
        setupMode ? '/auth/setup' : '/auth/login',
        setupMode ? { password, setupToken: initialSetupToken } : { username, password },
        state.csrfToken,
      );
      setState({ authenticated: true, setupRequired: false, ...result });
      setPassword('');
      setConfirmation('');
      setVisible(false);
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not sign in. Try again.');
      // Refresh CSRF state without retrying a password request automatically.
      try { setState(await request<AuthState>('/auth/state')); } catch { /* Preserve the visible form error. */ }
    } finally { setBusy(false); }
  }

  async function logout() {
    if (!state || busy) return;
    setBusy(true);
    setError('');
    try {
      await request('/auth/logout', {}, state.csrfToken);
      setState(null);
      await loadState();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not sign out. Try again.'); }
    finally { setBusy(false); }
  }

  return (
    <div className="app-shell">
      <header className="masthead">
        <a className="wordmark" href="/" aria-label="Ehud Radar home"><span>ehud</span><span className="wordmark-divider" />radar</a>
        <span className="workspace-label">Marketing workspace</span>
      </header>
      {!state ? (
        <main className="auth-main"><section className="auth-content" aria-live="polite">
          <h1>{initialError ? 'Could not connect' : 'Opening your workspace…'}</h1>
          {initialError && <><p className="intro">{initialError}</p><button className="primary-button" onClick={() => void loadState()}>Try again</button></>}
        </section></main>
      ) : state.authenticated ? (
        new URLSearchParams(window.location.search).get('view') === 'discovery'
          ? <DiscoveryWorkspace csrfToken={state.csrfToken} username={state.username} onSessionExpired={loadState} onLogout={() => void logout()} logoutBusy={busy} logoutError={error} />
          : <ProspectsWorkspace csrfToken={state.csrfToken} username={state.username} onSessionExpired={loadState} onLogout={() => void logout()} logoutBusy={busy} logoutError={error} />
      ) : (
        <main className="auth-main">
          <section className="auth-content" aria-labelledby="auth-heading">
            <h1 id="auth-heading">{setupMode ? 'Make it yours.' : 'Welcome back.'}</h1>
            <p className="intro">{setupMode ? 'Choose a password for your shared Ehud Radar account.' : 'Sign in to your Ehud Radar workspace.'}</p>
            <form onSubmit={(event) => void submit(event)}>
              <div className="form-field"><label htmlFor="username">Username</label><input id="username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} readOnly required maxLength={100} disabled={busy} /></div>
              <div className="form-field"><label htmlFor="password">{setupMode ? 'Choose a password' : 'Password'}</label>
                <div className="password-field"><input id="password" name="password" type={visible ? 'text' : 'password'} autoComplete={setupMode ? 'new-password' : 'current-password'} value={password} onChange={(event) => setPassword(event.target.value)} required minLength={setupMode ? 12 : undefined} maxLength={setupMode ? 72 : 200} disabled={busy} aria-describedby={setupMode ? 'password-help' : undefined} /><button className="visibility-button" type="button" onClick={() => setVisible((current) => !current)} aria-label={visible ? 'Hide password' : 'Show password'} aria-pressed={visible} disabled={busy}>{visible ? 'Hide' : 'Show'}</button></div>
                {setupMode && <p className="field-help" id="password-help">Use at least 12 characters.</p>}
              </div>
              {setupMode && <div className="form-field"><label htmlFor="confirmation">Confirm password</label><input id="confirmation" name="confirmation" type={visible ? 'text' : 'password'} autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} required minLength={12} maxLength={72} disabled={busy} /></div>}
              {state.setupRequired && !setupMode && <p className="setup-message">This account needs a password. Open the local setup link to create it.</p>}
              {error && <p className="error-message" role="alert">{error}</p>}
              {!state.setupRequired && temporaryLoginPassword && <button className="text-button temporary-login-button" type="button" disabled={busy} onClick={() => { setPassword(temporaryLoginPassword); setVisible(false); setError(''); }}>Fill temporary login</button>}
              {!state.setupRequired && state.demoPassword && <button className="text-button temporary-login-button" type="button" disabled={busy} onClick={() => { setPassword(state.demoPassword || ''); setVisible(false); setError(''); }}>Fill login</button>}
              <button className="primary-button" type="submit" disabled={busy || (state.setupRequired && !setupMode)}>{busy ? (setupMode ? 'Creating account…' : 'Signing in…') : setupMode ? 'Create password & enter' : 'Sign in'}</button>
            </form>
            <p className="shared-note">One account. One shared workspace.</p>
          </section>
        </main>
      )}
      <footer className="page-footer">Ehud AI · A new way to tell stories.</footer>
    </div>
  );
}
