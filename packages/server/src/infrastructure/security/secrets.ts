import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

type SecretEntry = { iv: string; tag: string; data: string };

export class ModelSecretStore {
  private file: string;
  private keyFile: string;
  private key: Buffer;
  private entries: Record<string, SecretEntry> = {};

  constructor(dir: string) {
    this.file = path.join(dir, 'model-secrets.enc');
    this.keyFile = path.join(dir, 'model-secrets.key');
    const configured = process.env.MODEL_SECRETS_KEY;
    if (configured) this.key = crypto.createHash('sha256').update(configured).digest();
    else if (fs.existsSync(this.keyFile)) {
      this.key = Buffer.from(fs.readFileSync(this.keyFile, 'utf8').trim(), 'base64');
      if (this.key.length !== 32) throw new Error('模型密钥文件无效。');
    } else {
      this.key = crypto.randomBytes(32);
      fs.writeFileSync(this.keyFile, this.key.toString('base64'), { mode: 0o600 });
    }
    if (!fs.existsSync(this.file)) return;
    const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as {
      version: number;
      entries: Record<string, SecretEntry>;
    };
    if (parsed.version !== 1 || !parsed.entries) throw new Error('模型密钥文件版本不受支持。');
    this.entries = parsed.entries;
    for (const id of Object.keys(this.entries))
      if (this.get(id) === undefined) throw new Error('模型密钥无法解密，请检查密钥；原文件未修改。');
  }

  get(id: string) {
    const entry = this.entries[id];
    if (!entry) return undefined;
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(entry.iv, 'base64'));
      decipher.setAAD(Buffer.from(`model:${id}`));
      decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(entry.data, 'base64')), decipher.final()]).toString(
        'utf8',
      );
    } catch {
      return undefined;
    }
  }

  set(id: string, value: string) {
    if (!value) return this.delete(id);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(`model:${id}`));
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    this.entries[id] = {
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: encrypted.toString('base64'),
    };
    this.save();
  }

  delete(id: string) {
    const existed = !!this.entries[id];
    delete this.entries[id];
    if (existed) this.save();
    return existed;
  }

  private save() {
    fs.writeFileSync(this.file + '.tmp', JSON.stringify({ version: 1, entries: this.entries }));
    fs.renameSync(this.file + '.tmp', this.file);
  }
}

export class SecretStore {
  private values = new Map<string, string>();
  private file: string;
  private key?: Buffer;
  private entries: Record<string, SecretEntry> = {};

  constructor(dir: string) {
    this.file = path.join(dir, 'platform-secrets.enc');
    const secret = process.env.PLATFORM_SECRETS_KEY;
    if (secret) this.key = crypto.createHash('sha256').update(secret).digest();
    if (this.key && fs.existsSync(this.file)) {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as {
        version: number;
        entries: Record<string, SecretEntry>;
      };
      if (parsed.version !== 1 || !parsed.entries) throw new Error('平台凭据文件版本不受支持。');
      this.entries = parsed.entries;
      for (const id of Object.keys(this.entries))
        if (this.get(id) === undefined) throw new Error('平台凭据无法解密，请检查密钥；原文件未修改。');
    }
  }

  get persistent() {
    return !!this.key;
  }
  has(id: string) {
    return this.persistent ? !!this.entries[id] : this.values.has(id);
  }
  get(id: string) {
    if (!this.persistent) return this.values.get(id);
    const entry = this.entries[id];
    if (!entry || !this.key) return undefined;
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(entry.iv, 'base64'));
      decipher.setAAD(Buffer.from(id));
      decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(entry.data, 'base64')), decipher.final()]).toString(
        'utf8',
      );
    } catch {
      return undefined;
    }
  }
  set(id: string, value: string) {
    if (!this.persistent) {
      this.values.set(id, value);
      return;
    }
    if (!this.key) throw new Error('平台凭据密钥未配置。');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(id));
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const next = {
      ...this.entries,
      [id]: {
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        data: encrypted.toString('base64'),
      },
    };
    this.save(next);
    this.entries = next;
  }
  delete(id: string) {
    if (!this.persistent) return this.values.delete(id);
    const existed = !!this.entries[id];
    if (existed) {
      const next = { ...this.entries };
      delete next[id];
      this.save(next);
      this.entries = next;
    }
    return existed;
  }
  clearMemory() {
    this.values.clear();
    this.entries = {};
    this.key?.fill(0);
    this.key = undefined;
  }
  private save(entries: Record<string, SecretEntry>) {
    fs.writeFileSync(this.file + '.tmp', JSON.stringify({ version: 1, entries }), { mode: 0o600 });
    fs.renameSync(this.file + '.tmp', this.file);
  }
}
