/** Release announcements are plain text. Never render title/content as HTML. */
export type PublicReleaseNote = {
  version: string;
  title: string;
  content: string;
  publishedAt: string;
};

export type AdminReleaseNote = Omit<PublicReleaseNote, "publishedAt"> & {
  revision: number;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
};

export type ReleaseNotesPage<T> = { notes: T[]; hasMore: boolean };
export type ReleaseNoteDraftInput = { title: string; content: string; expectedRevision: number | null };
export type ReleaseNotePublishInput = { expectedRevision: number };
