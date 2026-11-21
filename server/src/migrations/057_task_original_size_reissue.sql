ALTER TABLE tasks ADD COLUMN original_size_source_id uuid REFERENCES tasks(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX tasks_original_size_source_unique ON tasks(original_size_source_id) WHERE original_size_source_id IS NOT NULL;
