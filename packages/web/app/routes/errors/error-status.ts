export type AppErrorStatus = 404 | 403 | 401 | 500 | 503;

export function isAppErrorStatus(value: number): value is AppErrorStatus {
  return value === 404 || value === 403 || value === 401 || value === 500 || value === 503;
}
