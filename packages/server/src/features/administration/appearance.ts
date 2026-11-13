import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { isMainThread } from 'node:worker_threads';
import {
  defaultSiteAppearance,
  siteAppearanceSchema,
  updateSiteAppearanceSchema,
  type SiteAppearance,
} from '../../../../../shared/site-appearance.js';

export class AppearanceError extends Error {
  constructor(
    readonly code: 'SITE_APPEARANCE_INVALID' | 'SITE_APPEARANCE_CONFLICT' | 'SITE_APPEARANCE_UNAVAILABLE',
  ) {
    super(code);
  }
}
function unavailable(): never {
  throw new AppearanceError('SITE_APPEARANCE_UNAVAILABLE');
}
/** Control-plane global file, independent of tenant business storage. Single application data lock required. */
export class SiteAppearanceStore {
  private document: SiteAppearance = defaultSiteAppearance();
  private loaded = false;
  private existed = false;
  private unhealthy = false;
  private readonly file: string;
  constructor(readonly dir: string) {
    this.file = path.join(path.resolve(dir), 'site-appearance.json');
  }

  private load(): void {
    if (this.unhealthy) unavailable();
    try {
      // Never follow a configured file or ancestor symlink/junction.
      let ancestor = path.resolve(this.dir);
      for (;;) {
        try {
          const stat = fs.lstatSync(ancestor);
          if (!stat.isDirectory() || stat.isSymbolicLink()) unavailable();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        const parent = path.dirname(ancestor);
        if (parent === ancestor) break;
        ancestor = parent;
      }
      try {
        const stat = fs.lstatSync(this.file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) unavailable();
        this.document = siteAppearanceSchema.parse(JSON.parse(fs.readFileSync(this.file, 'utf8')));
        this.existed = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || this.existed) throw error;
        if (!this.loaded) this.document = defaultSiteAppearance();
      }
      this.loaded = true;
    } catch {
      this.unhealthy = true;
      unavailable();
    }
  }
  read(): SiteAppearance {
    this.load();
    return structuredClone(this.document);
  }
  update(input: unknown): SiteAppearance {
    if (!isMainThread) unavailable();
    const parsed = updateSiteAppearanceSchema.safeParse(input);
    if (!parsed.success) throw new AppearanceError('SITE_APPEARANCE_INVALID');
    this.load();
    const { expectedRevision, ...appearance } = parsed.data;
    if (expectedRevision !== this.document.revision) throw new AppearanceError('SITE_APPEARANCE_CONFLICT');
    if (expectedRevision === Number.MAX_SAFE_INTEGER) unavailable();
    const next: SiteAppearance = { version: 1, revision: expectedRevision + 1, ...appearance };
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(next));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, this.file);
    } catch {
      unavailable();
    } finally {
      // Cleanup is best effort: a cleanup error must not hide the committed rename.
      try {
        fs.unlinkSync(temporary);
      } catch {
        /* absent or failed temporary file */
      }
    }
    this.document = next;
    this.existed = true;
    return structuredClone(next);
  }
}
export function appearanceHandler(store: SiteAppearanceStore, write = false): RequestHandler {
  return (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      return res.json(write ? store.update(req.body) : store.read());
    } catch (error) {
      const code = error instanceof AppearanceError ? error.code : 'SITE_APPEARANCE_UNAVAILABLE';
      const status =
        code === 'SITE_APPEARANCE_INVALID' ? 400 : code === 'SITE_APPEARANCE_CONFLICT' ? 409 : 503;
      return res
        .status(status)
        .json({
          code,
          error:
            status === 400
              ? 'Invalid site appearance.'
              : status === 409
                ? 'Site appearance revision conflict.'
                : 'Site appearance storage unavailable.',
        });
    }
  };
}
