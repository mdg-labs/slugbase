import { SetMetadata } from "@nestjs/common";

export const SKIP_CSRF_KEY = "skip_csrf";

/** Mark a controller or route handler as exempt from CSRF verification. */
export const SkipCsrf = () => SetMetadata(SKIP_CSRF_KEY, true);
