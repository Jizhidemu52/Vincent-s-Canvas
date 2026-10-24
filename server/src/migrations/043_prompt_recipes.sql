-- Authoring data is imported separately; migrations never silently activate recipes.
CREATE TABLE prompt_recipes (
  key text PRIMARY KEY,
  settings jsonb NOT NULL,
  current_version_id text,
  updated_at text NOT NULL
);
CREATE TABLE prompt_recipe_versions (
  id text PRIMARY KEY,
  recipe_key text NOT NULL REFERENCES prompt_recipes(key),
  version integer NOT NULL CHECK(version > 0),
  content_hash text NOT NULL,
  content jsonb NOT NULL,
  created_by text NOT NULL,
  created_at text NOT NULL,
  UNIQUE(recipe_key, version),
  UNIQUE(recipe_key, content_hash)
);
ALTER TABLE prompt_recipes ADD CONSTRAINT prompt_recipes_current_version_fk
  FOREIGN KEY(current_version_id) REFERENCES prompt_recipe_versions(id);
CREATE TABLE prompt_compilations (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  request_id text NOT NULL,
  input_hash text NOT NULL,
  recipe_key text NOT NULL REFERENCES prompt_recipes(key),
  recipe_version_id text NOT NULL REFERENCES prompt_recipe_versions(id),
  status text NOT NULL CHECK(status IN ('optimizing','success','failed','uncertain')),
  reused_from_id text REFERENCES prompt_compilations(id),
  details jsonb NOT NULL,
  created_at text NOT NULL,
  UNIQUE(user_id, request_id)
);
CREATE INDEX prompt_compilations_cache_idx ON prompt_compilations(user_id,input_hash,created_at DESC) WHERE reused_from_id IS NULL;
CREATE INDEX prompt_compilations_recipe_idx ON prompt_compilations(recipe_key,created_at DESC);
ALTER TABLE tasks ADD COLUMN user_input jsonb;
ALTER TABLE tasks ADD COLUMN prompt_compilation_id text REFERENCES prompt_compilations(id);
ALTER TABLE tasks ADD COLUMN prompt_optimized boolean NOT NULL DEFAULT false;

-- Durable batch admission is separate from image execution. Legacy batches are closed, never replayed.
ALTER TABLE batch_tasks ADD COLUMN admission_input_hash text;
ALTER TABLE batch_tasks ADD COLUMN admission_status text NOT NULL DEFAULT 'complete'
  CHECK(admission_status IN ('admitting','complete','interrupted'));
ALTER TABLE batch_tasks ADD COLUMN admission_token uuid;
ALTER TABLE batch_tasks ADD COLUMN admission_lease_expires_at timestamptz;
ALTER TABLE batch_tasks ADD COLUMN admission_failures jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK(jsonb_typeof(admission_failures)='array');
