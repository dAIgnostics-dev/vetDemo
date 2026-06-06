// Lokalni Authenticator — zamjenjuje @aws-amplify/ui-react <Authenticator>.
// Zadržava isti render-prop API:  <Authenticator>{({ signOut, user }) => ...}</Authenticator>
// te koristi components.Header / components.Footer ako su proslijeđeni (logo + brand).

import React, { useEffect, useState } from 'react';
import {
  fetchUserAttributes,
  loginUser,
  registerUser,
  logoutUser,
  getToken,
} from './api';

export function Authenticator({ children, components = {} }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState('login'); // 'login' | 'register'
  const [form, setForm] = useState({
    email: '',
    password: '',
    confirm: '',
    given_name: '',
    family_name: '',
  });
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Pokušaj obnoviti sesiju iz spremljenog tokena.
  useEffect(() => {
    (async () => {
      if (!getToken()) {
        setLoading(false);
        return;
      }
      try {
        const attrs = await fetchUserAttributes();
        setUser({ signInDetails: { loginId: attrs.email } });
      } catch {
        // nevažeći/istekao token
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const handleChange = (e) =>
    setForm((f) => ({ ...f, [e.target.name]: e.target.value }));

  const switchMode = (next) => {
    setMode(next);
    setError('');
  };

  const signOut = async () => {
    await logoutUser();
    setUser(null);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (mode === 'register' && form.password !== form.confirm) {
      setError('Lozinke se ne podudaraju.');
      return;
    }

    setSubmitting(true);
    try {
      const attrs =
        mode === 'login'
          ? await loginUser({ email: form.email, password: form.password })
          : await registerUser({
              email: form.email,
              password: form.password,
              given_name: form.given_name,
              family_name: form.family_name,
            });
      setUser({ signInDetails: { loginId: attrs.email } });
    } catch (err) {
      setError(err.message || 'Greška pri prijavi.');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center' }}>
        <div className="loading-spinner" />
      </div>
    );
  }

  if (user) {
    return children({ signOut, user });
  }

  const Header = components.Header;
  const Footer = components.Footer;

  return (
    <div className="card login-card">
      {Header ? <Header /> : null}

      <div className="login-tabs">
        <button
          type="button"
          className={`login-tab ${mode === 'login' ? 'active' : ''}`}
          onClick={() => switchMode('login')}
        >
          Prijava
        </button>
        <button
          type="button"
          className={`login-tab ${mode === 'register' ? 'active' : ''}`}
          onClick={() => switchMode('register')}
        >
          Registracija
        </button>
      </div>

      <form onSubmit={handleSubmit} className="login-form">
        {mode === 'register' && (
          <div className="login-row">
            <div>
              <label className="input-label">Ime</label>
              <input name="given_name" value={form.given_name} onChange={handleChange} required />
            </div>
            <div>
              <label className="input-label">Prezime</label>
              <input name="family_name" value={form.family_name} onChange={handleChange} required />
            </div>
          </div>
        )}

        <div>
          <label className="input-label">Email</label>
          <input type="email" name="email" value={form.email} onChange={handleChange} required />
        </div>

        <div>
          <label className="input-label">Lozinka</label>
          <input type="password" name="password" value={form.password} onChange={handleChange} required />
        </div>

        {mode === 'register' && (
          <div>
            <label className="input-label">Potvrdi lozinku</label>
            <input type="password" name="confirm" value={form.confirm} onChange={handleChange} required />
          </div>
        )}

        {error && <p className="login-error">{error}</p>}

        <button className="btn btn-primary login-submit" disabled={submitting}>
          {submitting ? <div className="loading-spinner" /> : mode === 'login' ? 'Prijavi se' : 'Registriraj se'}
        </button>
      </form>

      {Footer ? <Footer /> : null}
    </div>
  );
}
