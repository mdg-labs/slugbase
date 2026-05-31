import {
  createParamDecorator,
  type ExecutionContext,
  InternalServerErrorException,
} from "@nestjs/common";

import { ACTIVE_WORKSPACE_KEY } from "./tenant.guard.js";
import type { WorkspaceRecord } from "./workspace.types.js";

/**
 * Parameter decorator that extracts the resolved active workspace from the request.
 *
 * Must be used on a route protected by TenantGuard — the guard is responsible for
 * resolving membership and attaching the WorkspaceRecord to the request object.
 * Throws InternalServerErrorException if used without TenantGuard.
 *
 * @example
 * ```typescript
 * @Get("items")
 * @UseGuards(TenantGuard)
 * listItems(@ActiveWorkspace() workspace: WorkspaceRecord) { ... }
 * ```
 */
export const ActiveWorkspace = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): WorkspaceRecord => {
    const req = ctx.switchToHttp().getRequest<Record<string, unknown>>();
    const workspace = req[ACTIVE_WORKSPACE_KEY];
    if (!workspace) {
      throw new InternalServerErrorException(
        "@ActiveWorkspace() decorator requires TenantGuard on the route",
      );
    }
    return workspace as WorkspaceRecord;
  },
);
