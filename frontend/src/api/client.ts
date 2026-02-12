import axios from 'axios';
import { apiBaseUrl } from '../config/api';
import { isCloud } from '../config/mode';

const api = axios.create({
  baseURL: apiBaseUrl ? `${apiBaseUrl}/api` : '/api',
  withCredentials: true,
});

// CSRF token management
let csrfToken: string | null = null;
let csrfTokenPromise: Promise<void> | null = null;

// Fetch CSRF token on initialization
async function fetchCSRFToken() {
  try {
    const response = await api.get('/csrf-token');
    csrfToken = response.data.csrfToken;
  } catch (error) {
    console.warn('Failed to fetch CSRF token:', error);
    // If token fetch fails, set to empty string to allow requests without token
    // The backend will generate a token on first request
    csrfToken = '';
  }
}

// Fetch CSRF token immediately (but don't block)
csrfTokenPromise = fetchCSRFToken();

// Request interceptor to add CSRF token to state-changing requests
api.interceptors.request.use(
  async (config) => {
    // Wait for initial CSRF token fetch if it's still in progress
    if (csrfTokenPromise) {
      await csrfTokenPromise;
      csrfTokenPromise = null;
    }

    // Only add CSRF token for state-changing methods
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(config.method?.toUpperCase() || '')) {
      // Skip CSRF for certain endpoints
      const skipCSRF = [
        '/password-reset',
        '/contact',
        '/auth/setup',
        '/auth/login',
        '/auth/logout',
        '/auth/refresh',
        '/auth/register',
        '/auth/verify-signup',
        '/auth/resend-signup-verification',
        '/auth/request-signup-resend',
        '/billing/create-checkout-session',
        '/billing/create-portal-session',
        '/csrf-token',
      ].some((path) => config.url?.includes(path));

      if (!skipCSRF) {
        // If we don't have a token yet, try to fetch it
        if (!csrfToken) {
          await fetchCSRFToken();
        }
        if (csrfToken) {
          config.headers['X-CSRF-Token'] = csrfToken;
        }
      }
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Deduplicate refresh: multiple concurrent 401s share a single refresh attempt to avoid rate limiting
let refreshPromise: Promise<boolean> | null = null;

async function tryRefreshToken(): Promise<boolean> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = api
    .post('/auth/refresh')
    .then(() => true)
    .catch(() => false)
    .finally(() => { refreshPromise = null; });
  return refreshPromise;
}

// Response interceptor: refresh CSRF on 403; in CLOUD, refresh access token on 401 and retry
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (error.response?.status === 403 && error.config && !error.config._retry) {
      error.config._retry = true;
      await fetchCSRFToken();
      if (csrfToken && error.config.headers) {
        error.config.headers['X-CSRF-Token'] = csrfToken;
      }
      return api.request(error.config);
    }
    // Skip refresh when the failed request was /auth/refresh (avoid recursion)
    const isAuthRefresh = (error.config?.url ?? '').includes('/auth/refresh');
    if (isCloud && error.response?.status === 401 && error.config && !error.config._retryRefresh && !isAuthRefresh) {
      error.config._retryRefresh = true;
      const refreshed = await tryRefreshToken();
      if (refreshed) return api.request(error.config);
    }
    return Promise.reject(error);
  }
);

export default api;
