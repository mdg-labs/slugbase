/**
 * Plan restriction error codes and messages for Cloud mode.
 */

import { FREE_BOOKMARK_LIMIT } from './organizations.js';

export const PLAN_ERRORS = {
  BOOKMARK_LIMIT: {
    code: 'PLAN_LIMIT_BOOKMARKS',
    get message() {
      return `You've reached the Free plan limit (${FREE_BOOKMARK_LIMIT} bookmarks). Upgrade to add more.`;
    },
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
