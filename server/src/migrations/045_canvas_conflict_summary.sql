ALTER TABLE canvas_documents ADD COLUMN persistence_conflict jsonb;

-- Copy only the existing conflict metadata; never rewrite document/revision/owner.
-- Ordinary summary reads must not detoast the full graph to find this small field.
UPDATE canvas_documents SET persistence_conflict=document->'persistenceConflict'
WHERE NOT deleted AND document ? 'persistenceConflict'
    AND document->'persistenceConflict' <> 'null'::jsonb;
