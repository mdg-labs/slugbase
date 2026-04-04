import axios, { type AxiosInstance } from 'axios';
import { apiBaseUrl } from '../config/api';

function baseURLFromOptions(options: { baseUrl?: string; basePath?: string } = {}): string {
  if (options.baseUrl) return `${options.baseUrl.replace(/\/$/, '')}/api`;
  if (options.basePath) return `${options.basePath.replace(/\/$/, '')}/api`;
  return apiBaseUrl ? `${apiBaseUrl}/api` : '/api';
}

/**
 * Create an API client with the given base URL/path. Used by package consumers (e.g. cloud).
 */
export function createApiClient(options: { baseUrl?: string; basePath?: string } = {}): AxiosInstance {
  const client = axios.create({
    baseURL: baseURLFromOptions(options),
    withCredentials: true,
  });
  // Same CSRF and error handling as default api (simplified: no shared token state)
  client.interceptors.request.use(async (config) => {
    const method = config.method?.toUpperCase() || '';
    const skipVerify = config.url?.includes('/auth/mfa/verify');
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method) && !skipVerify) {
      try {
        const r = await client.get('/csrf-token');
        const token = r.data?.csrfToken;
        if (token) config.headers['X-CSRF-Token'] = token;
      } catch {
        // ignore
      }
    }
    return config;
  });
  client.interceptors.response.use(
    (r) => r,
    (error) => Promise.reject(error)
  );
  return client;
}

const api = axios.create({
  baseURL: baseURLFromOptions({}),
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
        '/auth/setup',
        '/auth/login',
        '/auth/logout',
        '/auth/refresh',
        '/auth/register',
        '/auth/verify-signup',
        '/auth/resend-signup-verification',
        '/auth/request-signup-resend',
        '/auth/mfa/verify',
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

// Response interceptor: refresh CSRF on 403.
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
    return Promise.reject(error);
  }
);

export default api;
