ALTER TABLE providers DROP CONSTRAINT IF EXISTS providers_protocol_check;
ALTER TABLE providers ADD CONSTRAINT providers_protocol_check
    CHECK (protocol IN ('openai','gemini','apimart','volcengine','runninghub','comfyui','custom'));
