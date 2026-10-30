import express from 'express';
import fs from 'node:fs';
import path from 'node:path';

export interface WebHostingOptions {
  /** API-only mode deliberately serves no HTML, theme files or other Web assets. */
  serveWeb?: boolean;
  webRoot?: string;
}

export function readWebHostingOptions(env: NodeJS.ProcessEnv, root: string): WebHostingOptions {
  const mode = env.SERVE_WEB ?? 'true';
  if (mode !== 'true' && mode !== 'false') throw new Error('SERVE_WEB_INVALID');
  return { serveWeb: mode === 'true', webRoot: path.resolve(root, env.WEB_DIST_DIR || 'dist') };
}

/** Web delivery is optional and separate from business routes and API error handling. */
export function installWebHosting(app: express.Express, root: string, options: WebHostingOptions = {}) {
  if (options.serveWeb === false) return;
  const staticDir = options.webRoot || path.join(root, 'dist');
  if (!fs.existsSync(path.join(staticDir, 'index.html'))) return;
  app.use(express.static(staticDir, {
    dotfiles: 'deny',
    setHeaders(res, filePath) {
      const immutable = /-[a-z0-9_-]{8,}\.(?:css|js|woff2?|png|jpe?g|svg|webp)$/i.test(path.basename(filePath));
      res.setHeader('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  }));
  app.get('/{*path}', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(staticDir, 'index.html'));
  });
}
