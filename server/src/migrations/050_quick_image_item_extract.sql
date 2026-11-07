-- Add the administrator-managed product extraction action without changing
-- existing quick-image configuration rows or ordinary image-edit bindings.
ALTER TABLE quick_image_configurations
  DROP CONSTRAINT quick_image_configurations_action_check,
  ADD CONSTRAINT quick_image_configurations_action_check
    CHECK (action IN ('remove-background', 'hd-upscale', 'item-extract'));
