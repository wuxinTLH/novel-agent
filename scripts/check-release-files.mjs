import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const result = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' });
if (result.status !== 0) throw new Error('git file listing failed');
const files = result.stdout.split('\0').filter(Boolean).filter(name => name !== 'test.jpg');
const findings = [];
for (const name of files) {
  if (/(?:^|\/)(?:\.env(?!\.example$)|id_rsa|id_ed25519|credentials\.json|storage-state\.json)/.test(name)) findings.push(`${name}: forbidden private filename`);
  if (/\.(?:png|jpe?g|gif|ico|woff2?|zip|pdf)$/i.test(name)) continue;
  const data = fs.readFileSync(path.resolve(name), 'utf8');
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(data)) findings.push(`${name}: private key marker`);
  if (/(?:ghp_|github_pat_)[A-Za-z0-9_]{30,}|sk-(?:proj-)?[A-Za-z0-9_-]{35,}/.test(data)) findings.push(`${name}: probable access token`);
}
if (findings.length) { console.error(findings.join('\n')); process.exitCode = 1; }
else console.log(`Release filename and credential-marker checks passed (${files.length} files; user test.jpg excluded).`);
