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
        '/auth/setup',
        '/auth/login',
        '/auth/logout',
        '/auth/refresh',
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
    if (isCloud && error.response?.status === 401 && error.config && !error.config._retryRefresh) {
      error.config._retryRefresh = true;
      try {
        await api.post('/auth/refresh');
        return api.request(error.config);
      } catch {
        // refresh failed, reject original error
      }
    }
    return Promise.reject(error);
  }
);

export default api;
