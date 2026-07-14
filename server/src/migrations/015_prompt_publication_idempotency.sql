CREATE TABLE IF NOT EXISTS prompt_publication_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id text NOT NULL CHECK (char_length(request_id) BETWEEN 8 AND 160),
    actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    source_template_id uuid NOT NULL REFERENCES prompt_templates(id) ON DELETE RESTRICT,
    source_version_id uuid NOT NULL REFERENCES prompt_template_versions(id) ON DELETE RESTRICT,
    published_template_id uuid NOT NULL REFERENCES prompt_templates(id) ON DELETE RESTRICT,
    published_version_id uuid NOT NULL REFERENCES prompt_template_versions(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(actor_user_id,request_id)
);
