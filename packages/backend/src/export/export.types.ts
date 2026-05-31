/** Lossless export entry — mirrors import JSON shape (spec §13). */
export type ExportBookmarkEntry = {
  title: string;
  url: string;
  slug: string | null;
  forwardingEnabled: boolean;
  pinned: boolean;
  folders: string[];
  tags: string[];
};
