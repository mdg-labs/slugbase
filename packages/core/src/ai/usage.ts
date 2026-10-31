// The count of the fields of a saved bookmark that came from a suggestion (doc 02 section 14, doc 05 section 2.8). The client names them when it saves, and the
// count holds which fields they were and never what they held. A save that names none counts nothing, and naming fields never refuses a save: the client's claim is
// not checked against a suggestion, so a request that names them when AI is off or not configured is as good as any other.

/** The fields of a bookmark that can come from a suggestion, in the order they are recorded. */
export const AI_FIELDS = ["title", "slug", "tags"] as const;

export type AiField = (typeof AI_FIELDS)[number];

/** What a save that names the fields it took from a suggestion records. */
export interface AiUsageRecorder {
  /**
   * Holds the member's place in the workspace for a save that will count fields: it takes the locks the count's insert needs, before the save locks its bookmark (the order a
   * departure takes them in). False when the member has left the workspace, and the save then answers as for a bookmark that is not theirs.
   */
  hold(): Promise<boolean>;
  /** Counts that `fields` of the bookmark `bookmarkId`, in the transaction of the save, came from a suggestion. */
  record(request: { readonly bookmarkId: string; readonly fields: readonly AiField[] }): Promise<void>;
}

/** The fields a save names, without repeats and in the order of `AI_FIELDS`; empty when it names none. */
export function aiFieldsOf(fields: readonly AiField[] | undefined): readonly AiField[] {
  return fields === undefined ? [] : AI_FIELDS.filter((field) => fields.includes(field));
}
