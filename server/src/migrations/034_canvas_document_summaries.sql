ALTER TABLE canvas_documents
    ADD COLUMN title text NOT NULL DEFAULT '',
    ADD COLUMN document_created_at text,
    ADD COLUMN document_updated_at text,
    ADD COLUMN node_count integer NOT NULL DEFAULT 0 CHECK (node_count >= 0),
    ADD COLUMN connection_count integer NOT NULL DEFAULT 0 CHECK (connection_count >= 0),
    ADD COLUMN cover_url text;

-- One-time derivation; ordinary listing no longer reads the graph JSON.
UPDATE canvas_documents SET
    title=coalesce(document->>'title',''),
    document_created_at=document->>'createdAt',
    document_updated_at=document->>'updatedAt',
    node_count=CASE WHEN deleted THEN 0 ELSE jsonb_array_length(document->'nodes') END,
    connection_count=CASE WHEN deleted THEN 0 ELSE jsonb_array_length(document->'connections') END,
    cover_url=(SELECT node->'metadata'->>'content' FROM jsonb_array_elements(document->'nodes') AS node
        WHERE node->>'type'='image' AND coalesce(node->'metadata'->>'content','')<>'' LIMIT 1);
