CREATE TABLE image_conversations (
    id                          uuid PRIMARY KEY,
    owner_user_id               uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    project_uuid               uuid REFERENCES projects(id) ON DELETE RESTRICT,
    canvas_external_id         text,
    entrypoint                 text NOT NULL CHECK (entrypoint IN ('standalone', 'canvas')),
    title                      text CHECK (title IS NULL OR char_length(title) BETWEEN 1 AND 200),
    active_version_id          uuid,
    state_revision             bigint NOT NULL DEFAULT 0 CHECK (state_revision BETWEEN 0 AND 9000000000000000),
    last_message_seq           bigint NOT NULL DEFAULT 0 CHECK (last_message_seq BETWEEN 0 AND 9000000000000000),
    last_image_no              bigint NOT NULL DEFAULT 0 CHECK (last_image_no BETWEEN 0 AND 9000000000000000),
    last_event_seq             bigint NOT NULL DEFAULT 0 CHECK (last_event_seq BETWEEN 0 AND 9000000000000000),
    context_summary            jsonb NOT NULL DEFAULT '{"schemaVersion":1,"text":"","goals":[],"unresolvedQuestions":[]}'::jsonb
        CHECK (jsonb_typeof(context_summary) = 'object'),
    context_summary_through_seq bigint NOT NULL DEFAULT 0,
    create_request_id          text NOT NULL CHECK (char_length(create_request_id) BETWEEN 1 AND 160),
    create_request_hash        text NOT NULL CHECK (create_request_hash ~ '^[0-9a-f]{64}$'),
    created_at                 timestamptz NOT NULL DEFAULT now(),
    updated_at                 timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT image_conversations_owner_identity UNIQUE (id, owner_user_id),
    CONSTRAINT image_conversations_create_request UNIQUE (owner_user_id, create_request_id),
    CONSTRAINT image_conversations_summary_position CHECK (
        context_summary_through_seq BETWEEN 0 AND last_message_seq
    ),
    CONSTRAINT image_conversations_canvas_binding CHECK (
        (entrypoint = 'standalone' AND canvas_external_id IS NULL)
        OR (entrypoint = 'canvas' AND canvas_external_id IS NOT NULL AND char_length(canvas_external_id) > 0)
    ),
    CONSTRAINT image_conversations_canvas_owner FOREIGN KEY (owner_user_id, canvas_external_id)
        REFERENCES canvas_documents(owner_user_id, external_id) ON DELETE RESTRICT
);

CREATE INDEX image_conversations_owner_list
    ON image_conversations (owner_user_id, created_at DESC, id DESC);
CREATE INDEX image_conversations_project
    ON image_conversations (project_uuid) WHERE project_uuid IS NOT NULL;
CREATE INDEX image_conversations_canvas
    ON image_conversations (owner_user_id, canvas_external_id)
    WHERE canvas_external_id IS NOT NULL;

CREATE TABLE image_conversation_turns (
    id                          uuid PRIMARY KEY,
    conversation_id             uuid NOT NULL,
    owner_user_id                uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    client_request_id            text NOT NULL CHECK (char_length(client_request_id) BETWEEN 1 AND 160),
    payload_hash                 text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
    input_payload                jsonb NOT NULL CHECK (jsonb_typeof(input_payload) = 'object'),
    accepted_revision            bigint NOT NULL CHECK (accepted_revision BETWEEN 1 AND 9000000000000000),
    input_active_version_id      uuid,
    base_version_id              uuid,
    output_version_id            uuid,
    reply_to_turn_id             uuid,
    intent                       text CHECK (intent IN ('discuss', 'clarify', 'restore', 'edit', 'generate_new')),
    state                        text NOT NULL DEFAULT 'accepted' CHECK (state IN (
        'accepted', 'planning', 'queued', 'generating', 'uncertain',
        'completed', 'failed', 'cancelled', 'detached'
    )),
    planner_status               text NOT NULL DEFAULT 'not_started' CHECK (planner_status IN (
        'not_started', 'in_flight', 'succeeded', 'failed', 'unknown'
    )),
    planner_request_id           text CHECK (planner_request_id IS NULL OR char_length(planner_request_id) BETWEEN 1 AND 160),
    planner_dispatch_started_at  timestamptz,
    planner_lease_token          uuid,
    planner_lease_expires_at     timestamptz,
    execution_epoch              bigint NOT NULL DEFAULT 0 CHECK (execution_epoch BETWEEN 0 AND 9000000000000000),
    plan                         jsonb CHECK (plan IS NULL OR jsonb_typeof(plan) = 'object'),
    context_manifest             jsonb CHECK (context_manifest IS NULL OR jsonb_typeof(context_manifest) = 'object'),
    settings_snapshot            jsonb CHECK (settings_snapshot IS NULL OR jsonb_typeof(settings_snapshot) = 'object'),
    task_id                      uuid UNIQUE REFERENCES tasks(id) ON DELETE RESTRICT,
    task_request_id              text UNIQUE REFERENCES tasks(request_id) ON DELETE RESTRICT
        CHECK (task_request_id IS NULL OR char_length(task_request_id) BETWEEN 1 AND 160),
    auto_activate                boolean NOT NULL DEFAULT true,
    last_error                   jsonb CHECK (last_error IS NULL OR jsonb_typeof(last_error) = 'object'),
    created_at                   timestamptz NOT NULL DEFAULT now(),
    updated_at                   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT image_turns_conversation_identity UNIQUE (conversation_id, id),
    CONSTRAINT image_turns_client_request UNIQUE (owner_user_id, client_request_id),
    CONSTRAINT image_turns_owner_conversation FOREIGN KEY (conversation_id, owner_user_id)
        REFERENCES image_conversations(id, owner_user_id) ON DELETE RESTRICT,
    CONSTRAINT image_turns_reply_same_conversation FOREIGN KEY (conversation_id, reply_to_turn_id)
        REFERENCES image_conversation_turns(conversation_id, id) ON DELETE RESTRICT,
    CONSTRAINT image_turns_not_self_reply CHECK (reply_to_turn_id IS NULL OR reply_to_turn_id <> id),
    CONSTRAINT image_turns_task_pair CHECK ((task_id IS NULL) = (task_request_id IS NULL)),
    CONSTRAINT image_turns_planner_lease_pair CHECK (
        (planner_lease_token IS NULL) = (planner_lease_expires_at IS NULL)
    ),
    CONSTRAINT image_turns_dispatch_metadata CHECK (
        planner_status NOT IN ('in_flight', 'unknown')
        OR (planner_request_id IS NOT NULL AND planner_dispatch_started_at IS NOT NULL)
    ),
    CONSTRAINT image_turns_nonimage_no_task CHECK (
        intent IS NULL OR intent NOT IN ('discuss', 'clarify', 'restore')
        OR (task_id IS NULL AND task_request_id IS NULL)
    ),
    CONSTRAINT image_turns_detached_no_activation CHECK (state <> 'detached' OR NOT auto_activate)
);

CREATE UNIQUE INDEX image_turns_single_flight
    ON image_conversation_turns (conversation_id)
    WHERE state IN ('accepted', 'planning', 'queued', 'generating', 'uncertain');
CREATE INDEX image_turns_conversation_history
    ON image_conversation_turns (conversation_id, created_at DESC, id DESC);
CREATE INDEX image_turns_planner_recovery
    ON image_conversation_turns (state, planner_lease_expires_at, updated_at)
    WHERE state IN ('accepted', 'planning', 'uncertain');
CREATE INDEX image_turns_task_reconciliation
    ON image_conversation_turns (state, updated_at)
    WHERE task_id IS NOT NULL AND state IN ('queued', 'generating', 'uncertain', 'detached');

CREATE TABLE image_conversation_versions (
    id                   uuid PRIMARY KEY,
    conversation_id      uuid NOT NULL REFERENCES image_conversations(id) ON DELETE RESTRICT,
    root_version_id      uuid NOT NULL,
    parent_version_id    uuid,
    version_no           bigint NOT NULL CHECK (version_no BETWEEN 1 AND 9000000000000000),
    image_no             bigint NOT NULL CHECK (image_no BETWEEN 1 AND 9000000000000000),
    label                text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 200),
    asset_id             uuid NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
    source               text NOT NULL CHECK (source IN ('upload', 'generated')),
    turn_id              uuid,
    output_index         integer NOT NULL DEFAULT 0 CHECK (output_index = 0),
    requested_state      jsonb NOT NULL DEFAULT '{"schemaVersion":1,"goals":[],"constraints":[]}'::jsonb
        CHECK (jsonb_typeof(requested_state) = 'object'),
    observation          jsonb CHECK (observation IS NULL OR jsonb_typeof(observation) = 'object'),
    acceptance           text NOT NULL DEFAULT 'unreviewed' CHECK (acceptance IN ('unreviewed', 'accepted', 'rejected')),
    parameters           jsonb CHECK (parameters IS NULL OR jsonb_typeof(parameters) = 'object'),
    actual_dimensions    jsonb CHECK (actual_dimensions IS NULL OR jsonb_typeof(actual_dimensions) = 'object'),
    created_at           timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT image_versions_conversation_identity UNIQUE (conversation_id, id),
    CONSTRAINT image_versions_root_identity UNIQUE (conversation_id, root_version_id, id),
    CONSTRAINT image_versions_root_number UNIQUE (conversation_id, root_version_id, version_no),
    CONSTRAINT image_versions_image_number UNIQUE (conversation_id, image_no),
    CONSTRAINT image_versions_root_shape CHECK (
        (parent_version_id IS NULL AND root_version_id = id AND version_no = 1)
        OR (parent_version_id IS NOT NULL AND parent_version_id <> id AND root_version_id <> id AND version_no > 1)
    ),
    CONSTRAINT image_versions_root_same_conversation FOREIGN KEY (conversation_id, root_version_id)
        REFERENCES image_conversation_versions(conversation_id, id)
        DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT image_versions_parent_same_root FOREIGN KEY (conversation_id, root_version_id, parent_version_id)
        REFERENCES image_conversation_versions(conversation_id, root_version_id, id)
        DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT image_versions_turn_same_conversation FOREIGN KEY (conversation_id, turn_id)
        REFERENCES image_conversation_turns(conversation_id, id) ON DELETE RESTRICT,
    CONSTRAINT image_versions_source_shape CHECK (
        (source = 'upload' AND turn_id IS NULL AND parameters IS NULL AND parent_version_id IS NULL)
        OR (source = 'generated' AND turn_id IS NOT NULL AND parameters IS NOT NULL)
    )
);

CREATE UNIQUE INDEX image_versions_turn_output
    ON image_conversation_versions (turn_id, output_index) WHERE source = 'generated';
CREATE INDEX image_versions_asset ON image_conversation_versions (asset_id);
CREATE INDEX image_versions_history ON image_conversation_versions (conversation_id, image_no);

ALTER TABLE image_conversations ADD CONSTRAINT image_conversations_active_same_conversation
    FOREIGN KEY (id, active_version_id)
    REFERENCES image_conversation_versions(conversation_id, id)
    DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE image_conversation_turns ADD CONSTRAINT image_turns_input_active_same_conversation
    FOREIGN KEY (conversation_id, input_active_version_id)
    REFERENCES image_conversation_versions(conversation_id, id) ON DELETE RESTRICT;
ALTER TABLE image_conversation_turns ADD CONSTRAINT image_turns_base_same_conversation
    FOREIGN KEY (conversation_id, base_version_id)
    REFERENCES image_conversation_versions(conversation_id, id) ON DELETE RESTRICT;
ALTER TABLE image_conversation_turns ADD CONSTRAINT image_turns_output_same_conversation
    FOREIGN KEY (conversation_id, output_version_id)
    REFERENCES image_conversation_versions(conversation_id, id) ON DELETE RESTRICT;

CREATE TABLE image_conversation_messages (
    id                  uuid PRIMARY KEY,
    conversation_id     uuid NOT NULL REFERENCES image_conversations(id) ON DELETE RESTRICT,
    turn_id             uuid,
    seq                 bigint NOT NULL CHECK (seq BETWEEN 1 AND 9000000000000000),
    role                text NOT NULL CHECK (role IN ('user', 'assistant')),
    kind                text NOT NULL CHECK (kind IN ('text', 'image', 'status')),
    text                text,
    attachments         jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(attachments) = 'array'),
    created_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT image_messages_sequence UNIQUE (conversation_id, seq),
    CONSTRAINT image_messages_turn_same_conversation FOREIGN KEY (conversation_id, turn_id)
        REFERENCES image_conversation_turns(conversation_id, id) ON DELETE RESTRICT,
    CONSTRAINT image_messages_user_has_turn CHECK (role <> 'user' OR turn_id IS NOT NULL),
    CONSTRAINT image_messages_content CHECK (
        (text IS NOT NULL AND char_length(text) > 0) OR jsonb_array_length(attachments) > 0
    ),
    CONSTRAINT image_messages_image_attachment CHECK (kind <> 'image' OR jsonb_array_length(attachments) > 0)
);

CREATE UNIQUE INDEX image_messages_one_user_per_turn
    ON image_conversation_messages (turn_id) WHERE role = 'user';
CREATE INDEX image_messages_turn ON image_conversation_messages (turn_id) WHERE turn_id IS NOT NULL;

CREATE TABLE image_conversation_events (
    conversation_id uuid NOT NULL REFERENCES image_conversations(id) ON DELETE RESTRICT,
    seq             bigint NOT NULL CHECK (seq BETWEEN 1 AND 9000000000000000),
    turn_id         uuid,
    event_type      text NOT NULL CHECK (event_type IN (
        'conversation.created', 'turn.accepted', 'turn.updated', 'plan.ready',
        'task.queued', 'task.progress', 'version.created', 'active.changed',
        'turn.completed', 'turn.failed', 'turn.cancelled', 'turn.detached',
        'turn.uncertain', 'message.created', 'context_summary.updated', 'settings.resolved'
    )),
    payload         jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (conversation_id, seq),
    CONSTRAINT image_events_turn_same_conversation FOREIGN KEY (conversation_id, turn_id)
        REFERENCES image_conversation_turns(conversation_id, id) ON DELETE RESTRICT
);

CREATE INDEX image_events_retention ON image_conversation_events (created_at);
CREATE INDEX image_events_turn ON image_conversation_events (turn_id) WHERE turn_id IS NOT NULL;
