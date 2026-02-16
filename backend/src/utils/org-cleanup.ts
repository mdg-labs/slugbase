/**
 * Scheduled orphan organization cleanup (Cloud mode only).
 * Finds orgs with 0 members and deletes them. Runs daily as a safety net.
 */

import cron from 'node-cron';
import { query } from '../db/index.js';
import { deleteOrganization } from './organizations.js';
import { isCloud } from '../config/mode.js';

export function startOrgCleanupJob(): void {
  if (!isCloud) return;

  // Run daily at 2:00 AM
  cron.schedule('0 2 * * *', async () => {
    try {
      const orphans = await query(
        `SELECT id FROM organizations o
         WHERE NOT EXISTS (SELECT 1 FROM org_members om WHERE om.org_id = o.id)`,
        []
      );
      const list = Array.isArray(orphans) ? orphans : orphans ? [orphans] : [];
      for (const row of list) {
        const orgId = (row as any).id;
        if (orgId) {
          try {
            await deleteOrganization(orgId);
            console.log(`Org cleanup: deleted orphan org ${orgId}`);
          } catch (err: any) {
            console.warn(`Org cleanup: failed to delete org ${orgId}:`, err?.message);
          }
        }
      }
    } catch (error: any) {
      console.warn('Org cleanup job error:', error?.message);
    }
  });

  console.log('Org cleanup job scheduled (daily at 2:00 AM)');
}
