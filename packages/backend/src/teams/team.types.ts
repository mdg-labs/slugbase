import type { TeamSort } from "./team.validation.js";

export interface TeamRecord {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  memberCount: number;
  memberIds: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateTeamData {
  name: string;
  description?: string | null;
  memberIds?: string[];
}

export interface UpdateTeamData {
  name?: string;
  description?: string | null;
}

/** Raw HTTP query - sort is parsed in the service before listing. */
export interface ListTeamsQuery {
  q?: string;
  sort?: string;
  page?: number;
  pageSize?: number;
}

export interface ParsedListTeamsQuery {
  q?: string;
  sort: TeamSort;
  page?: number;
  pageSize?: number;
}

export interface PaginatedTeams {
  items: TeamRecord[];
  total: number;
  page: number;
  pageSize: number;
}
