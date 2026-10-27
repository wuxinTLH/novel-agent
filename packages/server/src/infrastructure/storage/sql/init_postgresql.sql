-- Only the configured preexisting database is used. No CREATE DATABASE or schema switching.
CREATE TABLE IF NOT EXISTS public.novel_agent_metadata (
  metadata_key VARCHAR(64) PRIMARY KEY,
  metadata_value VARCHAR(255) NOT NULL
);
CREATE TABLE IF NOT EXISTS public.novel_agent_users (
  user_id VARCHAR(64) PRIMARY KEY,
  display_name VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS public.novel_agent_projects (
  project_id VARCHAR(64) PRIMARY KEY,
  owner_id VARCHAR(64) NOT NULL REFERENCES public.novel_agent_users(user_id),
  title VARCHAR(255) NOT NULL,
  payload TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (owner_id, project_id)
);
CREATE INDEX IF NOT EXISTS novel_agent_projects_owner_idx ON public.novel_agent_projects(owner_id);
CREATE TABLE IF NOT EXISTS public.novel_agent_chapters (
  chapter_id VARCHAR(64) PRIMARY KEY,
  project_id VARCHAR(64) NOT NULL,
  owner_id VARCHAR(64) NOT NULL REFERENCES public.novel_agent_users(user_id),
  chapter_number INTEGER NOT NULL,
  content TEXT NOT NULL,
  UNIQUE (project_id, chapter_number),
  FOREIGN KEY (owner_id, project_id) REFERENCES public.novel_agent_projects(owner_id, project_id)
);
CREATE INDEX IF NOT EXISTS novel_agent_chapters_owner_idx ON public.novel_agent_chapters(owner_id);
CREATE TABLE IF NOT EXISTS public.novel_agent_assets (
  asset_id VARCHAR(64) PRIMARY KEY,
  owner_id VARCHAR(64) NOT NULL,
  project_id VARCHAR(64) NOT NULL,
  asset_type VARCHAR(64) NOT NULL,
  payload TEXT NOT NULL,
  FOREIGN KEY (owner_id, project_id) REFERENCES public.novel_agent_projects(owner_id, project_id)
);
CREATE INDEX IF NOT EXISTS novel_agent_assets_owner_idx ON public.novel_agent_assets(owner_id, project_id);
CREATE TABLE IF NOT EXISTS public.novel_agent_settings (
  owner_id VARCHAR(64) NOT NULL REFERENCES public.novel_agent_users(user_id),
  setting_key VARCHAR(128) NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (owner_id, setting_key)
);
CREATE TABLE IF NOT EXISTS public.novel_agent_platform_bindings (
  binding_id VARCHAR(64) PRIMARY KEY,
  owner_id VARCHAR(64) NOT NULL,
  project_id VARCHAR(64) NOT NULL,
  platform VARCHAR(64) NOT NULL,
  external_work_id VARCHAR(255) NOT NULL,
  FOREIGN KEY (owner_id, project_id) REFERENCES public.novel_agent_projects(owner_id, project_id)
);
CREATE INDEX IF NOT EXISTS novel_agent_platform_bindings_owner_idx ON public.novel_agent_platform_bindings(owner_id, project_id);
INSERT INTO public.novel_agent_metadata (metadata_key, metadata_value) VALUES ('schema_version', '1')
ON CONFLICT (metadata_key) DO NOTHING;
