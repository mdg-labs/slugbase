// The plan of the candidate scan of `/go` (doc 05 section 4, doc 08 section 5.3), and the one assertion that every plan of it is held to. The assertion is a function of the plan alone, so the test that plans
// the statement as `slugbase_app` and the tests that hand it a plan known to be bad (an index that is gone, a slug that is only a filter) hold the statement to the same rule.

export interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Index Cond"?: string;
  Plans?: PlanNode[];
}

export function nodesOf(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(nodesOf)];
}

const SHARE_TABLES = ["bookmark_shares", "folder_bookmarks", "folder_shares"];

/**
 * Throws when the plan of the candidate scan of `slug` is not the one doc 05 section 4 describes: an Index Only Scan of `bookmarks_slug_idx` whose index condition holds the slug and the workspace, as the only
 * read of `bookmarks`, with no sequential scan anywhere and the share tables probed by index. The slug must be in the *index condition*: a comparison that is not leakproof (`citext`'s equality) stays an Index Only Scan
 * of the same index under row-level security but is evaluated as a filter over every entry of the workspace. Each message names the rule that failed.
 */
export function assertSlugCandidatePlan(nodes: readonly PlanNode[], slug: string): void {
  const scans = nodes.filter((node) => node["Index Name"] === "bookmarks_slug_idx");
  if (scans.length === 0) {
    throw new Error("no bookmarks_slug_idx scan in the plan");
  }
  const scanTypes = scans.map((node) => node["Node Type"]);
  if (scanTypes.length !== 1 || scanTypes[0] !== "Index Only Scan") {
    throw new Error(`bookmarks_slug_idx is not scanned by one Index Only Scan: ${scanTypes.join(", ")}`);
  }
  const condition = scans[0]?.["Index Cond"] ?? "";
  if (!condition.includes(`slug = '${slug}'::text`)) {
    throw new Error(`the slug is not in the index condition of bookmarks_slug_idx (${condition})`);
  }
  if (!condition.includes("workspace_id")) {
    throw new Error(`the workspace is not in the index condition of bookmarks_slug_idx (${condition})`);
  }
  const sequential = nodes.filter((node) => node["Node Type"] === "Seq Scan").map((node) => node["Relation Name"] ?? "?");
  if (sequential.length > 0) {
    throw new Error(`sequential scan of ${sequential.join(", ")}`);
  }
  const bookmarkReads = nodes.filter((node) => node["Relation Name"] === "bookmarks").map((node) => node["Node Type"]);
  if (bookmarkReads.length !== 1 || bookmarkReads[0] !== "Index Only Scan") {
    throw new Error(`bookmarks is not read by one Index Only Scan: ${bookmarkReads.join(", ")}`);
  }
  // The shares are probed for the candidates only: each by its index, with the candidate's identifier or the account as the condition, never read as a whole.
  const probes = nodes.filter((node) => SHARE_TABLES.includes(node["Relation Name"] ?? ""));
  if (probes.length === 0) {
    throw new Error("no share table is probed");
  }
  for (const node of probes) {
    if (!/Index/.test(node["Node Type"])) {
      throw new Error(`${node["Relation Name"] ?? "?"} is read by ${node["Node Type"]}, not by an index`);
    }
  }
}
