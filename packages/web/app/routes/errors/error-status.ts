export type AppErrorStatus = 404 | 403 | 500;

export function isAppErrorStatus(value: number): value is AppErrorStatus {
  return value === 404 || value === 403 || value === 500;
}
