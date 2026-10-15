CREATE TABLE IF NOT EXISTS usage_collection_metadata (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  started_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO usage_collection_metadata(singleton) VALUES(true) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS usage_events (
  id bigserial PRIMARY KEY,
  event_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  board_key text NOT NULL CHECK(length(board_key) BETWEEN 1 AND 100),
  action text NOT NULL CHECK(action IN ('visit','click','change','submit','export','drop','download','open','close','gap')),
  control_key text,
  parameters jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(parameters)='object' AND octet_length(parameters::text)<=2048),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,event_id)
);
CREATE INDEX IF NOT EXISTS usage_events_user_time_idx ON usage_events(user_id,occurred_at DESC,id);
CREATE INDEX IF NOT EXISTS usage_events_received_idx ON usage_events(user_id,received_at);
CREATE INDEX IF NOT EXISTS usage_events_board_time_idx ON usage_events(board_key,occurred_at);

CREATE TABLE IF NOT EXISTS usage_chat_requests (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  model_config_id uuid NOT NULL REFERENCES model_configs(id) ON DELETE RESTRICT,
  board_key text NOT NULL,
  -- Input is already bounded by the existing 12MB chat route; redaction may expand text.
  -- No second truncation/byte limit may discard a successfully accepted prompt.
  prompt text NOT NULL DEFAULT '',
  prompt_redacted boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'processing' CHECK(status IN ('processing','success','failed','interrupted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS usage_chat_user_time_idx ON usage_chat_requests(user_id,created_at DESC,id);

CREATE TABLE IF NOT EXISTS usage_analysis_previews (
  id uuid PRIMARY KEY,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  content text NOT NULL CHECK(octet_length(content)<=131072),
  content_hash text NOT NULL,
  filters jsonb NOT NULL,
  includes_prompt_samples boolean NOT NULL,
  sample_count integer NOT NULL CHECK(sample_count BETWEEN 0 AND 8),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz,
  model_config_id uuid REFERENCES model_configs(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'preview' CHECK(status IN ('preview','processing','success','failed')),
  result text
);
CREATE INDEX IF NOT EXISTS usage_analysis_actor_idx ON usage_analysis_previews(actor_user_id,created_at DESC);
