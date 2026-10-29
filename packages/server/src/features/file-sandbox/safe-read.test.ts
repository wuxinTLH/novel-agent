import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { readSafeImage } from './safe-read.js';

const id = '10000000-0000-4000-8000-000000000001';
test('legacy image read removes appended payload and metadata without replacing the original', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'safe-read-'));
  try {
    const image = await sharp({ create: { width: 2, height: 3, channels: 3, background: '#123456' } }).withMetadata().jpeg().toBuffer();
    const original = Buffer.concat([image, Buffer.from('<script>legacy-payload</script>')]);
    const name = id + '.jpg';
    await fs.writeFile(path.join(dir, name), original);
    const clean = await readSafeImage(dir, name);
    const meta = await sharp(clean).metadata();
    assert.equal(meta.format, 'png'); assert.equal(meta.width, 2); assert.equal(meta.height, 3);
    assert.equal(meta.exif, undefined);
    assert.equal(clean.includes(Buffer.from('legacy-payload')), false);
    assert.deepEqual(await fs.readFile(path.join(dir, name)), original);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('safe reads reject traversal, other static formats, disguised images and oversized storage', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'safe-read-'));
  try {
    for (const name of ['../' + id + '.png', id + '.svg', id + '.html', 'arbitrary.png'])
      await assert.rejects(readSafeImage(dir, name), { code: 'UPLOAD_NOT_FOUND' });
    await fs.writeFile(path.join(dir, id + '.png'), '<script>unsafe</script>');
    await assert.rejects(readSafeImage(dir, id + '.png'), { code: 'UPLOAD_UNSAFE' });
    const handle = await fs.open(path.join(dir, id + '.png'), 'w');
    await handle.truncate(16 * 1024 * 1024 + 1); await handle.close();
    await assert.rejects(readSafeImage(dir, id + '.png'), { code: 'UPLOAD_UNSAFE' });
    await assert.rejects(readSafeImage(dir, id + '.jpg'), { code: 'UPLOAD_NOT_FOUND' });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
