import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  createReadStream,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export interface StoredBlob {
  hash: string;
  path: string;
  bytes: number;
}

const SHA256_HEX = /^[a-f0-9]{64}$/;
const EXTENSION = /^(\.[a-z0-9]+)?$/i;

const hashFile = async (filePath: string): Promise<string> => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
};

const publishAtomically = (candidate: string, destination: string): void => {
  try {
    linkSync(candidate, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  } finally {
    rmSync(candidate, { force: true });
  }
};

export class TelegramBlobStore {
  constructor(
    private readonly root: string,
    private readonly freeBytes: (dir: string) => number = (dir) => {
      const stat = statfsSync(dir);
      return Number(stat.bavail) * Number(stat.bsize);
    },
  ) {
    mkdirSync(this.root, { recursive: true });
    mkdirSync(this.tempDir(), { recursive: true });
  }

  tempDir(): string {
    return path.join(this.root, 'tmp');
  }

  hasFreeSpace(minimumBytes: number): boolean {
    return this.freeBytes(this.root) >= minimumBytes;
  }

  async putFile(tempPath: string): Promise<StoredBlob> {
    const hash = await hashFile(tempPath);
    const destination = path.join(this.root, 'blobs', 'sha256', hash.slice(0, 2), hash);
    mkdirSync(path.dirname(destination), { recursive: true });
    const bytes = statSync(tempPath).size;
    if (!existsSync(destination)) {
      const candidate = path.join(path.dirname(destination), `.${hash}.${randomUUID()}.tmp`);
      copyFileSync(tempPath, candidate);
      publishAtomically(candidate, destination);
    }
    rmSync(tempPath, { force: true });
    return { hash, path: destination, bytes };
  }

  async putBuffer(content: Buffer, extension = ''): Promise<StoredBlob> {
    if (!EXTENSION.test(extension)) throw new Error(`invalid blob extension: ${extension}`);
    const hash = createHash('sha256').update(content).digest('hex');
    const destination = path.join(
      this.root,
      'links',
      'sha256',
      hash.slice(0, 2),
      `${hash}${extension}`,
    );
    mkdirSync(path.dirname(destination), { recursive: true });
    if (!existsSync(destination)) {
      const candidate = path.join(path.dirname(destination), `.${hash}.${randomUUID()}.tmp`);
      writeFileSync(candidate, content);
      publishAtomically(candidate, destination);
    }
    return { hash, path: destination, bytes: content.length };
  }

  deleteBlob(hash: string): void {
    if (!SHA256_HEX.test(hash)) return;
    rmSync(path.join(this.root, 'blobs', 'sha256', hash.slice(0, 2), hash), { force: true });
    const linkDir = path.join(this.root, 'links', 'sha256', hash.slice(0, 2));
    if (!existsSync(linkDir)) return;
    for (const name of readdirSync(linkDir)) {
      if (name.startsWith(`${hash}.`)) rmSync(path.join(linkDir, name), { force: true });
    }
  }
}
