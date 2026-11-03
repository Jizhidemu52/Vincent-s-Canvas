CREATE TABLE release_notes (
    version text PRIMARY KEY CHECK (version ~ '^v[0-9]+\.[0-9]+\.[0-9]+$'),
    title text NOT NULL DEFAULT '' CHECK (char_length(title) <= 80),
    content text NOT NULL DEFAULT '' CHECK (char_length(content) <= 4000),
    revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    published_at timestamptz,
    CONSTRAINT release_notes_published_content CHECK (
        published_at IS NULL OR (btrim(title) <> '' AND btrim(content) <> '')
    )
);

CREATE INDEX release_notes_published_page ON release_notes (published_at DESC, version DESC)
    WHERE published_at IS NOT NULL;
CREATE INDEX release_notes_admin_page ON release_notes (updated_at DESC, version DESC);
