import { mkdirSync, writeFileSync, realpathSync, lstatSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Artifact } from '../contracts/schemas.js';

/**
 * I3 (final review): agent'ın dokunamayacağı politika/kanıt/bağımlılık yüzeyleri — fail-closed.
 * policy.yaml: gate politikası; .devloop/: devloop kanıt günlüğü + worktree'ler; .gitignore:
 * repo sahibinin izin yüzeyi; package.json: bağımlılık yüzeyi (araç zinciri güvenliği).
 * R14 (faz 3 T8): gate-config yüzeyleri de kapalı — tsconfig.json (derleyici politikası),
 * eslint.config.js / .eslintrc.json (lint gate politikası). Aksi halde artifact, gate sonuçlarını
 * değiştirerek kendi çıktısını onaylatabilir (gate-manipülasyonu).
 */
const DENIED_EXACT = new Set(['policy.yaml', '.gitignore', 'package.json', 'tsconfig.json', 'eslint.config.js', '.eslintrc.json']);

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
    // R4b: denylist eşleşmesi case-insensitive — 'Policy.YAML' gibi uzantı varyantları da düşer.
    // Yalnızca bu karşılaştırma lowercase; yol canonicalization/'..'/symlink denetimleri orijinal rel ile.
    const relLower = rel.toLowerCase();
    if (DENIED_EXACT.has(relLower) || relLower.startsWith('.devloop/')) {
      throw new Error(`Yasaklı yol reddedildi: ${file.path} (politika/kanıt yüzeyleri agent'a kapalıdır)`);
    }
    // A5: yazma öncesi — var olan her ata segmenti kök içinde kalmalı (symlink kaçışı yok)
    let probe = root;
    const segments = relFromRoot.split(/[\\/]/).filter(Boolean).slice(0, -1); // parent segmentleri
    for (const seg of segments) {
      probe = join(probe, seg);
      if (!existsSync(probe)) continue;
      if (lstatSync(probe).isSymbolicLink()) throw new Error(`Sembolik bağ hedefi reddedildi: ${file.path}`);
    }
    try {
      if (lstatSync(target).isSymbolicLink()) throw new Error(`Sembolik bağ hedefi reddedildi: ${file.path}`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; // ENOENT = hedef yok, normal yol
    }
    const parent = dirname(target);
    mkdirSync(parent, { recursive: true });
    writeFileSync(target, file.content, 'utf8');
  }
}
