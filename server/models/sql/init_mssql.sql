-- Only the configured preexisting database is used. GO is split by the service, never sent to the driver.
IF OBJECT_ID(N'dbo.novel_agent_metadata', N'U') IS NULL
CREATE TABLE dbo.novel_agent_metadata (
  metadata_key NVARCHAR(64) PRIMARY KEY,
  metadata_value NVARCHAR(255) NOT NULL
)
GO
IF OBJECT_ID(N'dbo.novel_agent_users', N'U') IS NULL
CREATE TABLE dbo.novel_agent_users (
  user_id NVARCHAR(64) PRIMARY KEY,
  display_name NVARCHAR(255) NOT NULL,
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
)
GO
IF OBJECT_ID(N'dbo.novel_agent_projects', N'U') IS NULL
CREATE TABLE dbo.novel_agent_projects (
  project_id NVARCHAR(64) PRIMARY KEY,
  owner_id NVARCHAR(64) NOT NULL REFERENCES dbo.novel_agent_users(user_id),
  title NVARCHAR(255) NOT NULL,
  payload NVARCHAR(MAX) NOT NULL,
  updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  CONSTRAINT novel_agent_projects_owner_project_unique UNIQUE (owner_id, project_id)
)
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'novel_agent_projects_owner_idx' AND object_id = OBJECT_ID(N'dbo.novel_agent_projects'))
CREATE INDEX novel_agent_projects_owner_idx ON dbo.novel_agent_projects(owner_id)
GO
IF OBJECT_ID(N'dbo.novel_agent_chapters', N'U') IS NULL
CREATE TABLE dbo.novel_agent_chapters (
  chapter_id NVARCHAR(64) PRIMARY KEY,
  project_id NVARCHAR(64) NOT NULL,
  owner_id NVARCHAR(64) NOT NULL REFERENCES dbo.novel_agent_users(user_id),
  chapter_number INT NOT NULL,
  content NVARCHAR(MAX) NOT NULL,
  CONSTRAINT novel_agent_chapters_number_unique UNIQUE (project_id, chapter_number),
  FOREIGN KEY (owner_id, project_id) REFERENCES dbo.novel_agent_projects(owner_id, project_id)
)
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'novel_agent_chapters_owner_idx' AND object_id = OBJECT_ID(N'dbo.novel_agent_chapters'))
CREATE INDEX novel_agent_chapters_owner_idx ON dbo.novel_agent_chapters(owner_id)
GO
IF OBJECT_ID(N'dbo.novel_agent_assets', N'U') IS NULL
CREATE TABLE dbo.novel_agent_assets (
  asset_id NVARCHAR(64) PRIMARY KEY,
  owner_id NVARCHAR(64) NOT NULL,
  project_id NVARCHAR(64) NOT NULL,
  asset_type NVARCHAR(64) NOT NULL,
  payload NVARCHAR(MAX) NOT NULL,
  FOREIGN KEY (owner_id, project_id) REFERENCES dbo.novel_agent_projects(owner_id, project_id)
)
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'novel_agent_assets_owner_idx' AND object_id = OBJECT_ID(N'dbo.novel_agent_assets'))
CREATE INDEX novel_agent_assets_owner_idx ON dbo.novel_agent_assets(owner_id, project_id)
GO
IF OBJECT_ID(N'dbo.novel_agent_settings', N'U') IS NULL
CREATE TABLE dbo.novel_agent_settings (
  owner_id NVARCHAR(64) NOT NULL REFERENCES dbo.novel_agent_users(user_id),
  setting_key NVARCHAR(128) NOT NULL,
  payload NVARCHAR(MAX) NOT NULL,
  PRIMARY KEY (owner_id, setting_key)
)
GO
IF OBJECT_ID(N'dbo.novel_agent_platform_bindings', N'U') IS NULL
CREATE TABLE dbo.novel_agent_platform_bindings (
  binding_id NVARCHAR(64) PRIMARY KEY,
  owner_id NVARCHAR(64) NOT NULL,
  project_id NVARCHAR(64) NOT NULL,
  platform NVARCHAR(64) NOT NULL,
  external_work_id NVARCHAR(255) NOT NULL,
  FOREIGN KEY (owner_id, project_id) REFERENCES dbo.novel_agent_projects(owner_id, project_id)
)
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'novel_agent_platform_bindings_owner_idx' AND object_id = OBJECT_ID(N'dbo.novel_agent_platform_bindings'))
CREATE INDEX novel_agent_platform_bindings_owner_idx ON dbo.novel_agent_platform_bindings(owner_id, project_id)
GO
IF NOT EXISTS (SELECT 1 FROM dbo.novel_agent_metadata WHERE metadata_key = N'schema_version')
INSERT INTO dbo.novel_agent_metadata (metadata_key, metadata_value) VALUES (N'schema_version', N'1')
GO
