-- Additive only. The caller runs v1 initialization and this script in ONE transaction
-- under the fixed migration advisory lock after rejecting unsupported versions.
CREATE TABLE IF NOT EXISTS public.novel_agent_schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS public.novel_agent_owner_state (
  owner_id VARCHAR(64) PRIMARY KEY REFERENCES public.novel_agent_users(user_id),
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0)
);
CREATE TABLE IF NOT EXISTS public.novel_agent_documents (
  owner_id VARCHAR(64) NOT NULL REFERENCES public.novel_agent_users(user_id),
  document_key VARCHAR(255) NOT NULL,
  revision BIGINT NOT NULL CHECK (revision > 0),
  content TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (owner_id, document_key)
);
CREATE TABLE IF NOT EXISTS public.novel_agent_document_imports (
  owner_id VARCHAR(64) NOT NULL REFERENCES public.novel_agent_users(user_id),
  source_hash VARCHAR(128) NOT NULL,
  document_count INTEGER NOT NULL CHECK (document_count > 0),
  imported_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (owner_id, source_hash)
);
INSERT INTO public.novel_agent_schema_migrations (version) VALUES (1), (2)
ON CONFLICT (version) DO NOTHING;
INSERT INTO public.novel_agent_metadata (metadata_key, metadata_value) VALUES ('schema_version', '2')
ON CONFLICT (metadata_key) DO UPDATE SET metadata_value = EXCLUDED.metadata_value;
