import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2];
if (!/^v[0-9]+\.[0-9]+\.[0-9]+-[a-z0-9.]+$/.test(version || '')) throw new Error('Expected prerelease version argument');
const output = path.join(root, '.tmp-build', 'release', version);
if (fs.existsSync(output)) throw new Error('Release directory already exists; inspect it before retrying');
fs.mkdirSync(output, { recursive: true });
const stage = path.join(output, 'novel-agent');
fs.mkdirSync(stage);
const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
if (execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).trim()) throw new Error('Tracked source must be clean before packaging');
for (const file of files) {
  if (file !== '.env' && !file.startsWith('data/')) {
    fs.mkdirSync(path.dirname(path.join(stage, file)), { recursive: true });
    fs.copyFileSync(path.join(root, file), path.join(stage, file));
  }
}
for (const dir of ['build', 'dist']) {
  if (!fs.existsSync(path.join(root, dir))) throw new Error('Build artifacts missing');
  fs.cpSync(path.join(root, dir), path.join(stage, dir), { recursive: true });
}
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
fs.writeFileSync(path.join(stage, 'RELEASE-MANIFEST.json'), JSON.stringify({ version, commit, runtime: 'Node.js >=22.16', dependenciesIncluded: false, dockerValidated: false, complianceCertified: false, sourceIncluded: true }, null, 2));
const archive = path.join(output, `novel-agent-${version}.tar.gz`);
execFileSync('tar', ['-czf', archive, '-C', output, 'novel-agent'], { stdio: 'inherit' });
fs.writeFileSync(path.join(output, 'SHA256SUMS.txt'), `${crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex')}  ${path.basename(archive)}\n`);
console.log(output);
