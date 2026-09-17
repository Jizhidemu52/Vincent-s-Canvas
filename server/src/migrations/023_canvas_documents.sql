CREATE TABLE canvas_documents (
    owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    external_id text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 200),
    revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
    deleted boolean NOT NULL DEFAULT false,
    document jsonb,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_user_id, external_id),
    CHECK ((deleted AND document IS NULL) OR (NOT deleted AND document IS NOT NULL AND jsonb_typeof(document)='object'))
);
CREATE INDEX canvas_documents_owner_updated_idx ON canvas_documents(owner_user_id, updated_at DESC);
