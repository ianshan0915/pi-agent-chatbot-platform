-- Phase 3.1: Support zip skill bundles

ALTER TABLE skills ADD COLUMN format TEXT NOT NULL DEFAULT 'md';
ALTER TABLE skills ADD CONSTRAINT skills_format_check CHECK (format IN ('md', 'zip'));
