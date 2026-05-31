import { BadRequestException } from "@nestjs/common";

import type { BulkSelectionBody } from "./bulk.types.js";

export function assertBulkSelection(body: BulkSelectionBody): void {
  const hasIds = (body.bookmarkIds?.length ?? 0) > 0;
  const hasSelectAll = body.selectAll === true;

  if (hasIds && hasSelectAll) {
    throw new BadRequestException(
      "Provide bookmarkIds or selectAll: true, not both",
    );
  }
  if (!hasIds && !hasSelectAll) {
    throw new BadRequestException(
      "Provide bookmarkIds or selectAll: true",
    );
  }
}
