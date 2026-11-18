import { mkdirSync, writeFileSync, realpathSync, lstatSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Artifact } from '../contracts/schemas.js';

/** A5: canonicalization + `..` reddi + symlink denetimi. Repo dışına yazma yok. */
export async function applyArtifact(repoPath: string, artifact: Artifact): Promise<void> {
  const root = realpathSync(resolve(repoPath));
  for (const file of artifact.files) {
    const rel = file.path.replaceAll('\\', '/');
    const target = resolve(root, rel);
    const relFromRoot = relative(root, target);
    if (relFromRoot.startsWith('..') || isAbsolute(relFromRoot)) {
      throw new Error(`Yol kaçışı reddedildi: ${file.path}`);
    }
    const parent = dirname(target);
    let probe = parent;
    while (probe !== root && !existsSync(probe)) probe = dirname(probe); // var olan en yakın ata
    if (existsSync(probe)) {
      const st = lstatSync(probe);
      if (st.isSymbolicLink()) throw new Error(`Sembolik bağ hedefi reddedildi: ${file.path}`);
    }
    mkdirSync(parent, { recursive: true });
    writeFileSync(target, file.content, 'utf8');
  }
}
