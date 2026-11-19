import { describe, it, expect } from 'vitest';
import { safeEnv } from '../../src/shell/safeEnv.js';

// I2 (final review): spawn edilen süreçlere sırlar sızmaz — seçilmiş env ayak izi.
describe('safeEnv', () => {
  it('ANTHROPIC_API_KEY dışlanır, PATH dahil; GIT_/SSH_ önekleri geçer', () => {
    const prevKey = process.env.ANTHROPIC_API_KEY;
    const prevGit = process.env.GIT_DIR;
    const prevSsh = process.env.SSH_AUTH_SOCK;
    try {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-secret';
      process.env.GIT_DIR = 'C:/tmp/fake-git-dir';
      process.env.SSH_AUTH_SOCK = 'fake-sock';
      const env = safeEnv();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined(); // sırrın sızması yok
      expect(env.PATH).toBeDefined();
      expect(env.GIT_DIR).toBe('C:/tmp/fake-git-dir');
      expect(env.SSH_AUTH_SOCK).toBe('fake-sock');
    } finally {
      // ortam geri yazılır (diğer testler/koşum etkilenmesin)
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey;
      if (prevGit === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = prevGit;
      if (prevSsh === undefined) delete process.env.SSH_AUTH_SOCK; else process.env.SSH_AUTH_SOCK = prevSsh;
    }
  });
});
