import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const result = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' });
if (result.status !== 0) throw new Error('git file listing failed');
const listed = result.stdout.split('\0').filter(Boolean);
// Local memory, telemetry and personal screenshots are never release sources.
const privateLocal = name => name === 'test.jpg' || name === 'token-usage.json' || name === '.mnemon' || name.startsWith('.mnemon/');
const tracked = spawnSync('git', ['ls-files', '-z'], { encoding: 'utf8' });
if (tracked.status !== 0) throw new Error('git tracked file listing failed');
if (tracked.stdout.split('\0').filter(Boolean).some(privateLocal)) throw new Error('Private local artifacts must not be tracked');
const files = listed.filter(name => !privateLocal(name));
const findings = [];
for (const name of files) {
  if (/(?:^|\/)(?:\.env(?!\.example$)|id_rsa|id_ed25519|credentials\.json|storage-state\.json)/.test(name)) findings.push(`${name}: forbidden private filename`);
  if (/\.(?:png|jpe?g|gif|ico|woff2?|zip|pdf)$/i.test(name)) continue;
  const data = fs.readFileSync(path.resolve(name), 'utf8');
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(data)) findings.push(`${name}: private key marker`);
  if (/(?:ghp_|github_pat_)[A-Za-z0-9_]{30,}|sk-(?:proj-)?[A-Za-z0-9_-]{35,}/.test(data)) findings.push(`${name}: probable access token`);
}
if (findings.length) { console.error(findings.join('\n')); process.exitCode = 1; }
else console.log(`Release filename and credential-marker checks passed (${files.length} files; private local memory, telemetry and personal screenshot excluded).`);
