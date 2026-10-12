CREATE TABLE design_library_publications (
    id uuid PRIMARY KEY,
    author_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    author_name text NOT NULL,
    department_id uuid REFERENCES departments(id) ON DELETE RESTRICT,
    department_name text,
    title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
    thought text NOT NULL DEFAULT '' CHECK (char_length(thought) <= 12000),
    prompt text NOT NULL DEFAULT '' CHECK (char_length(prompt) <= 12000),
    tags jsonb NOT NULL DEFAULT '[]'::jsonb,
    status text NOT NULL DEFAULT 'published' CHECK (status IN ('published','withdrawn','taken_down')),
    request_id text NOT NULL,
    payload_hash text NOT NULL,
    moderation_reason text,
    moderated_by uuid REFERENCES users(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    UNIQUE(author_id, request_id)
);
CREATE INDEX design_library_company_time ON design_library_publications(created_at DESC,id DESC) WHERE status='published';
CREATE INDEX design_library_author_time ON design_library_publications(author_id,created_at DESC,id DESC);
CREATE INDEX design_library_department_time ON design_library_publications(department_id,created_at DESC,id DESC);

-- Snapshot objects are independent of private assets; there is deliberately no source asset FK.
CREATE TABLE design_library_images (
    id uuid PRIMARY KEY,
    entry_id uuid NOT NULL REFERENCES design_library_publications(id) ON DELETE RESTRICT,
    position integer NOT NULL,
    object_key text NOT NULL UNIQUE,
    filename text NOT NULL,
    mime_type text NOT NULL CHECK (mime_type IN ('image/png','image/jpeg','image/webp','image/gif')),
    byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 20971520),
    width integer,
    height integer,
    UNIQUE(entry_id,position),
    UNIQUE(entry_id,id)
);

CREATE TABLE design_library_deliveries (
    operation_key text PRIMARY KEY,
    actor_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    entry_id uuid NOT NULL,
    image_id uuid NOT NULL,
    action text NOT NULL CHECK (action IN ('download','reuse')),
    request_id text NOT NULL,
    asset_id uuid REFERENCES assets(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL,
    FOREIGN KEY(entry_id,image_id) REFERENCES design_library_images(entry_id,id) ON DELETE RESTRICT,
    CHECK ((action='reuse' AND asset_id IS NOT NULL) OR (action='download' AND asset_id IS NULL))
);
CREATE INDEX design_library_delivery_actor ON design_library_deliveries(actor_id,created_at DESC);

CREATE TABLE design_library_receipts (
    id uuid PRIMARY KEY,
    receipt_key text NOT NULL UNIQUE,
    entry_id uuid NOT NULL REFERENCES design_library_publications(id) ON DELETE RESTRICT,
    image_id uuid,
    action text NOT NULL CHECK (action IN ('view','download','reuse','prompt_copy')),
    actor_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    actor_name text NOT NULL,
    department_name text,
    request_id text NOT NULL,
    created_at timestamptz NOT NULL,
    FOREIGN KEY(entry_id,image_id) REFERENCES design_library_images(entry_id,id) ON DELETE RESTRICT,
    CHECK ((action IN ('download','reuse') AND image_id IS NOT NULL) OR action='view' OR (action='prompt_copy' AND image_id IS NULL))
);
CREATE INDEX design_library_receipt_metrics ON design_library_receipts(entry_id,action,image_id,actor_id);
CREATE INDEX design_library_receipt_activity ON design_library_receipts(entry_id,created_at DESC,id DESC) WHERE action IN ('download','reuse');
