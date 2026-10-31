// The access matrix of doc 02 section 8.2, written down on its own, as the oracle of the within-workspace sharing suites (doc 08 section 3.3, doc 10 T2, T11
// and T12). It imports nothing from the code it judges: the table below is the doc's, cell by cell, and `expected` adds the one rule doc 04 section 2.4
// gives for a cell that is refused, that a caller who can see the object is answered `403` and one who cannot is answered `404`.
//
// `packages/core/test/sharing/access-matrix.test.ts` runs the table through the services of `@slugbase/core`, and
// `packages/server/test/routes/sharing-matrix.integration.test.ts` through the HTTP operations. The server suite holds a copy of this file under the same
// name and fails when the two differ, so one table judges both.
//
// A folder is a second kind of object the table judges. Its recipients read it through a direct or a team share, and the rows that apply to it are the two
// that name its shares, `share` and `see-recipients` (`FOLDER_ACTIONS`), for the relations of `FOLDER_RELATIONS`: no folder is filed in a folder, so the `folder`
// relation has no meaning for it. `expectedForFolder` gives the cell, by the same columns and the same rule of doc 04 section 2.4 as a bookmark's.
//
// The export column of the doc has no row here: no export operation exists yet, so there is nothing to ask. Its row joins the table with the operation.

/** How a member M relates to a bookmark that O owns, in the active workspace. */
export const RELATIONS = [
  "owner", // M = O
  "direct", // O shared the bookmark with M
  "team", // O shared it with a team M is in
  "folder", // it is filed in a folder O shared with M
  "none", // a member of the workspace with no share
  "admin", // an admin of the workspace with no share: administration is no access to content
  "former", // had a direct and a team share, and has left the workspace
] as const;

export type Relation = (typeof RELATIONS)[number];

/** The rows of the matrix. `file` is filing into folders, and `see-recipients` is "See who else it is shared with". */
export const ACTIONS = ["see", "open", "edit", "pin", "tag", "file", "delete", "share", "see-recipients"] as const;

export type Action = (typeof ACTIONS)[number];

/** What a request for an action gets: it is done; refused with `403`; refused with `404`; or, for a list, answered without the bookmark in it. */
export type Outcome = "allowed" | "forbidden" | "not_found" | "hidden";

/** The columns of the doc's table. */
type Column = "owner" | "viaShare" | "otherwise";

/** Doc 02 section 8.2, one row to an action: the columns are "M = O", "M has read via a share (direct, team, or containing shared folder)" and "Otherwise". */
const MATRIX: Readonly<Record<Action, Readonly<Record<Column, boolean>>>> = {
  see: { owner: true, viaShare: true, otherwise: false },
  open: { owner: true, viaShare: true, otherwise: false },
  edit: { owner: true, viaShare: false, otherwise: false },
  pin: { owner: true, viaShare: false, otherwise: false },
  tag: { owner: true, viaShare: false, otherwise: false },
  file: { owner: true, viaShare: false, otherwise: false },
  delete: { owner: true, viaShare: false, otherwise: false },
  share: { owner: true, viaShare: false, otherwise: false },
  "see-recipients": { owner: true, viaShare: false, otherwise: false },
};

function columnOf(relation: Exclude<Relation, "former">): Column {
  switch (relation) {
    case "owner":
      return "owner";
    case "direct":
    case "team":
    case "folder":
      return "viaShare";
    case "none":
    case "admin":
      return "otherwise";
  }
}

/**
 * What M's request for `action` on O's bookmark must get. A member who has left the workspace acts in none, so every operation that needs one answers `404`
 * (doc 04 section 3, "Unknown, or not visible to the caller"), whatever they once could read.
 */
export function expected(relation: Relation, action: Action): Outcome {
  if (relation === "former") {
    return "not_found";
  }
  const column = columnOf(relation);
  if (MATRIX[action][column]) {
    return "allowed";
  }
  if (action === "see") {
    return "hidden";
  }
  // Doc 04 section 2.4: 403 only when the caller can see the resource and may not perform the action; a resource the caller cannot see is 404.
  return column === "viaShare" ? "forbidden" : "not_found";
}

/** The relations a member can have to a folder O owns: a bookmark's, less the folder it is filed in. */
export const FOLDER_RELATIONS = ["owner", "direct", "team", "none", "admin", "former"] as const satisfies readonly Relation[];

export type FolderRelation = (typeof FOLDER_RELATIONS)[number];

/** The rows of the matrix that apply to a folder: sharing it, and seeing who else it is shared with. */
export const FOLDER_ACTIONS = ["share", "see-recipients"] as const satisfies readonly Action[];

export type FolderAction = (typeof FOLDER_ACTIONS)[number];

/** What M's request for `action` on O's folder must get: the table's cell for the same relation and action, since a folder is read through the same shares. */
export function expectedForFolder(relation: FolderRelation, action: FolderAction): Outcome {
  return expected(relation, action);
}
