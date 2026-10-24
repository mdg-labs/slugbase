import { z } from "zod";

// The SPA's CSP has no 'unsafe-eval', and Zod's JIT probe (`new Function("")`)
// reports a violation even though it catches the throw. Zod skips the probe only
// when `jitless` is set before the first object schema is built, so this module
// must be the first import of the package entry.
z.config({ jitless: true });
