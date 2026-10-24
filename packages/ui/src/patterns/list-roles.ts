/**
 * The roles of a list of records that can be selected (doc 03 section 15): a list while nothing is selected and an
 * ARIA grid, whose rows hold cells, while the selection is active.
 */
export function listRoles(selectionActive: boolean): { readonly list: "list" | "grid"; readonly row: "listitem" | "row"; readonly cell: "gridcell" | undefined } {
  return selectionActive ? { list: "grid", row: "row", cell: "gridcell" } : { list: "list", row: "listitem", cell: undefined };
}
