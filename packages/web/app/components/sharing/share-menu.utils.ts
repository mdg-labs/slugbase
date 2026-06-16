export function canShowShareMenu(
  canShare: boolean,
  ownerUserId: string,
  currentUserId: string | null,
): boolean {
  return canShare && currentUserId !== null && ownerUserId === currentUserId;
}
