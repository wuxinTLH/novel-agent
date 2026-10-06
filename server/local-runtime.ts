import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
export const appRoot = path.resolve(here, path.basename(path.dirname(here)) === 'build' ? '../..' : '..');

function ownerExited(raw: string) {
  let owner: { pid?: unknown; token?: unknown };
  try {
    owner = JSON.parse(raw);
  } catch {
    return false;
  }
  if (
    !owner ||
    !Number.isSafeInteger(owner.pid) ||
    (owner.pid as number) <= 0 ||
    typeof owner.token !== 'string' ||
    !owner.token
  )
    return false;
  try {
    process.kill(owner.pid as number, 0);
    return false;
  } catch (error) {
    // Permission failures and reused/live PIDs are not evidence of a stale lock.
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

function openDataLock(file: string): number {
  try {
    return fs.openSync(file, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const locked = () =>
    new Error('数据目录已锁定或无法确认锁的持有者。请关闭另一实例；不要删除仍在使用的数据目录锁。');
  let previous: string;
  try {
    previous = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fs.openSync(file, 'wx', 0o600);
    throw error;
  }
  if (!ownerExited(previous)) throw locked();

  // Only one contender may remove the observed dead owner's lock. Others fail closed.
  const recoveryFile = `${file}.recovery`;
  let recovery: number;
  try {
    recovery = fs.openSync(recoveryFile, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error('数据目录锁正在恢复。请稍后重试；若恢复进程异常退出，请先确认无实例运行。');
    throw error;
  }
  try {
    fs.writeFileSync(recovery, JSON.stringify({ pid: process.pid }));
    if (fs.readFileSync(file, 'utf8') !== previous || !ownerExited(previous)) throw locked();
    fs.unlinkSync(file);
    // Exclusive creation still arbitrates against an ordinary concurrent startup.
    return fs.openSync(file, 'wx', 0o600);
  } finally {
    fs.closeSync(recovery);
    fs.unlinkSync(recoveryFile);
  }
}

/** One process owns a data directory; recover only a verifiably exited owner's lock. */
export function acquireDataLock(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '.instance.lock');
  const token = randomUUID();
  const fd = openDataLock(file);
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() }));
  } catch (error) {
    fs.closeSync(fd);
    fs.unlinkSync(file);
    throw error;
  }
  fs.closeSync(fd);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      const owner = JSON.parse(fs.readFileSync(file, 'utf8')) as { token?: string };
      if (owner.token === token) fs.unlinkSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        console.error('无法释放数据目录锁，请在进程结束后检查锁文件。');
    }
  };
}
