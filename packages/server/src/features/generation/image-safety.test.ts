import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { loadImages } from './engine.js';
import { createProject } from '../projects/defaults.js';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-model-images-'));
  fs.mkdirSync(path.join(dir, 'uploads'));
  const project = createProject('legacy images');
  const name = `${randomUUID()}.png`;
  project.assets = [{ id: 'image', name: 'legacy', category: 'world', mime: 'image/png', url: `/uploads/${name}`, content: '', size: 1, createdAt: '' }];
  return { dir, project, name };
}

test('model image loader rejects legacy disguised images and nonlocal paths', async () => {
  const { dir, project, name } = fixture();
  try {
    fs.writeFileSync(path.join(dir, 'uploads', name), '<svg onload="alert(1)"></svg>');
    await assert.rejects(loadImages(project, 'draft', dir), /图片内容与扩展名不符/);
    project.assets[0].url = `https://example.invalid/${name}`;
    await assert.rejects(loadImages(project, 'draft', dir), /文件不存在/);
    project.assets[0].url = `/uploads/../${name}`;
    await assert.rejects(loadImages(project, 'draft', dir), /文件不存在/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('model image loader disarms legacy bytes to fresh PNG and does not expose appended payload', async () => {
  const { dir, project, name } = fixture();
  try {
    const png = await sharp({ create: { width: 2, height: 3, channels: 3, background: '#369abc' } }).png().toBuffer();
    const original = Buffer.concat([png, Buffer.from('UNTRUSTED_LEGACY_TRAILER')]);
    fs.writeFileSync(path.join(dir, 'uploads', name), original);
    const images = await loadImages(project, 'draft', dir);
    assert.equal(images[0].mime, 'image/png');
    const clean = Buffer.from(images[0].data, 'base64');
    assert.ok(clean.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])));
    assert.equal(clean.includes(Buffer.from('UNTRUSTED_LEGACY_TRAILER')), false);
    assert.equal(clean.equals(original), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
