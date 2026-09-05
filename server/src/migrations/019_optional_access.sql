ALTER TABLE users ADD COLUMN is_guest boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD CONSTRAINT guest_is_unprivileged
    CHECK (NOT is_guest OR (role = 'designer' AND password_hash IS NULL AND NOT must_change_password));
