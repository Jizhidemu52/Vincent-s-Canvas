-- Stable public image aliases do not depend on model names, activation or list order.
CREATE SEQUENCE model_public_number_seq;
ALTER TABLE model_configs ADD COLUMN public_number integer UNIQUE CHECK (public_number > 0);

WITH numbered AS (
  SELECT id, row_number() OVER (ORDER BY created_at, id)::integer AS number
  FROM model_configs
  WHERE capabilities && ARRAY['generate','edit','upscale','remove_background','batch']::text[]
    AND NOT capabilities && ARRAY['chat','video','audio']::text[]
)
UPDATE model_configs m SET public_number=n.number FROM numbered n WHERE n.id=m.id;
SELECT setval('model_public_number_seq', GREATEST(COALESCE(MAX(public_number),0),1), COALESCE(MAX(public_number),0)>0)
FROM model_configs;

CREATE FUNCTION assign_model_public_number() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- A model keeps its assigned identity even after a capability change.
  IF TG_OP='UPDATE' AND OLD.public_number IS NOT NULL THEN
    NEW.public_number := OLD.public_number;
  ELSIF NEW.capabilities && ARRAY['generate','edit','upscale','remove_background','batch']::text[]
    AND NOT NEW.capabilities && ARRAY['chat','video','audio']::text[] THEN
    NEW.public_number := nextval('model_public_number_seq');
  ELSE
    NEW.public_number := NULL;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER model_public_number_before_write BEFORE INSERT OR UPDATE ON model_configs
FOR EACH ROW EXECUTE FUNCTION assign_model_public_number();
