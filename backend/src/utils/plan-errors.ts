/**
 * Plan restriction error codes and messages for Cloud mode.
 */

export const PLAN_ERRORS = {
  BOOKMARK_LIMIT: {
    code: 'PLAN_LIMIT_BOOKMARKS',
    message: "You've reached the Free plan limit (100 bookmarks). Upgrade to add more.",
  },
  SHARE_TO_TEAM: {
    code: 'PLAN_SHARE_TO_TEAM',
    message: 'Sharing to teams is available on the Team plan.',
  },
  FOLDER_SHARING: {
    code: 'PLAN_FOLDER_SHARING',
    message: 'Folder sharing is available on the Team plan.',
  },
} as const;
