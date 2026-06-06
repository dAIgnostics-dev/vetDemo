// Lokalni API klijent — zamjenjuje aws-amplify (AppSync/Cognito) pozivima
// prema lokalnom Flask backendu. Namjerno oponaša oblike koje App.jsx već
// koristi (client.models / client.mutations / client.graphql + auth funkcije)
// kako bi izmjene u App.jsx bile minimalne.

const API_URL = (import.meta.env.VITE_API_URL || 'http://localhost:8000').replace(/\/$/, '');

const TOKEN_KEY = 'vet_token';

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t) => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

async function request(path, { method = 'GET', body, auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) {
    const token = getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  if (!res.ok) {
    const message = payload?.error || payload?.errors?.[0]?.message || `HTTP ${res.status}`;
    throw new Error(message);
  }
  return payload;
}

// ---------- Auth (Cognito zamjena) ----------

export async function registerUser({ email, password, given_name, family_name }) {
  const data = await request('/auth/register', {
    method: 'POST',
    auth: false,
    body: { email, password, given_name, family_name },
  });
  setToken(data.token);
  return data.attributes;
}

export async function loginUser({ email, password }) {
  const data = await request('/auth/login', {
    method: 'POST',
    auth: false,
    body: { email, password },
  });
  setToken(data.token);
  return data.attributes;
}

export async function logoutUser() {
  try {
    await request('/auth/logout', { method: 'POST' });
  } catch {
    // ignoriraj — svejedno čistimo lokalni token
  }
  clearToken();
}

// Iste potpise kao aws-amplify/auth:
export async function fetchUserAttributes() {
  return request('/auth/me');
}

export async function updateUserAttributes({ userAttributes }) {
  return request('/auth/attributes', {
    method: 'PUT',
    body: {
      given_name: userAttributes.given_name,
      family_name: userAttributes.family_name,
    },
  });
}

export async function updatePassword({ oldPassword, newPassword }) {
  return request('/auth/password', {
    method: 'POST',
    body: { oldPassword, newPassword },
  });
}

// ---------- client (AppSync zamjena) ----------

export const client = {
  models: {
    Diagnosis: {
      async list() {
        return request('/diagnoses'); // { data: [...] }
      },
      async create({ details, keywords, report }) {
        return request('/diagnoses', {
          method: 'POST',
          body: { details, keywords, report },
        });
      },
      async delete({ id }) {
        return request(`/diagnoses/${id}`, { method: 'DELETE' });
      },
    },
  },

  // client.mutations.generateReport({ keywords }) → { data: <json string>, errors }
  mutations: {
    async generateReport({ keywords }) {
      try {
        const payload = await request('/generate-report', {
          method: 'POST',
          body: { keywords },
        });
        return { data: payload.data, errors: payload.errors };
      } catch (e) {
        return { data: null, errors: [{ message: e.message }] };
      }
    },
  },

  async acceptGenerated({ keywords, dg, opis }) {
    return request('/accept-generated', {
      method: 'POST',
      body: { keywords, dg, opis },
    });
  },

  // client.graphql({ query, variables }) — koristi se samo za searchDatabase.
  // Vraćamo { data: <json string>, errors }; App radi data?.searchDatabase ?? data.
  async graphql({ variables } = {}) {
    try {
      const payload = await request('/search-database', {
        method: 'POST',
        body: { keywords: variables?.keywords || [] },
      });
      return { data: payload.data, errors: payload.errors };
    } catch (e) {
      return { data: null, errors: [{ message: e.message }] };
    }
  },
};
