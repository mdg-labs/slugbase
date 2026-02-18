import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import AdminTeams from '../../components/admin/AdminTeams';
import { useOrgPlan } from '../../contexts/OrgPlanContext';
import { appBasePath } from '../../config/api';
import { isCloud } from '../../config/mode';

export default function AdminTeamsPage() {
  const navigate = useNavigate();
  const { plan } = useOrgPlan();
  const showTeamsTab = !isCloud || (plan != null && plan !== 'free' && plan !== 'personal');

  useEffect(() => {
    if (!showTeamsTab && plan != null) {
      navigate(`${appBasePath || ''}/admin/members`, { replace: true });
    }
  }, [showTeamsTab, plan, navigate]);

  if (!showTeamsTab && plan != null) {
    return null;
  }

  return <AdminTeams />;
}
