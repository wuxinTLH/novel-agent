-- Only the configured preexisting database is used. No CREATE DATABASE or USE.
CREATE TABLE IF NOT EXISTS novel_agent_metadata (
  metadata_key VARCHAR(64) PRIMARY KEY,
  metadata_value VARCHAR(255) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS novel_agent_users (
  user_id VARCHAR(64) PRIMARY KEY,
  display_name VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS novel_agent_projects (
  project_id VARCHAR(64) PRIMARY KEY,
  owner_id VARCHAR(64) NOT NULL,
  title VARCHAR(255) NOT NULL,
  payload LONGTEXT NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY novel_agent_projects_owner_project_unique (owner_id, project_id),
  INDEX novel_agent_projects_owner_idx (owner_id),
  FOREIGN KEY (owner_id) REFERENCES novel_agent_users(user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS novel_agent_chapters (
  chapter_id VARCHAR(64) PRIMARY KEY,
  project_id VARCHAR(64) NOT NULL,
  owner_id VARCHAR(64) NOT NULL,
  chapter_number INT NOT NULL,
  content LONGTEXT NOT NULL,
  UNIQUE KEY novel_agent_chapters_number_idx (project_id, chapter_number),
  INDEX novel_agent_chapters_owner_idx (owner_id),
  FOREIGN KEY (owner_id, project_id) REFERENCES novel_agent_projects(owner_id, project_id),
  FOREIGN KEY (owner_id) REFERENCES novel_agent_users(user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS novel_agent_assets (
  asset_id VARCHAR(64) PRIMARY KEY,
  owner_id VARCHAR(64) NOT NULL,
  project_id VARCHAR(64) NOT NULL,
  asset_type VARCHAR(64) NOT NULL,
  payload LONGTEXT NOT NULL,
  INDEX novel_agent_assets_owner_idx (owner_id, project_id),
  FOREIGN KEY (owner_id, project_id) REFERENCES novel_agent_projects(owner_id, project_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS novel_agent_settings (
  owner_id VARCHAR(64) NOT NULL,
  setting_key VARCHAR(128) NOT NULL,
  payload LONGTEXT NOT NULL,
  PRIMARY KEY (owner_id, setting_key),
  FOREIGN KEY (owner_id) REFERENCES novel_agent_users(user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS novel_agent_platform_bindings (
  binding_id VARCHAR(64) PRIMARY KEY,
  owner_id VARCHAR(64) NOT NULL,
  project_id VARCHAR(64) NOT NULL,
  platform VARCHAR(64) NOT NULL,
  external_work_id VARCHAR(255) NOT NULL,
  INDEX novel_agent_platform_bindings_owner_idx (owner_id, project_id),
  FOREIGN KEY (owner_id, project_id) REFERENCES novel_agent_projects(owner_id, project_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT INTO novel_agent_metadata (metadata_key, metadata_value) VALUES ('schema_version', '1')
ON DUPLICATE KEY UPDATE metadata_key = 'schema_version';
