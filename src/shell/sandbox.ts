import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Policy } from '../config/config.js';
import { safeEnv } from './safeEnv.js';

const run = promisify(execFile);

/**
 * R13: Docker kullanılabilirlik probe'u — koşum BAŞINDA bir kez çağrılır (orchestrator aktivasyon
 * kapısı). Docker yoksa false döner; hata sızmaz (A6: sessiz host-fallback'e düşmek yerine açık
 * abort çağırıcının işidir — burada yalnız sinyal üretilir).
 * fetchlessProbe: test enjeksiyonu için (mock execFile). Kontratta `typeof execFile` tipiyle
 * geçilir; gerçek yal `run` (promisify) ile aynı çağrı şekliyle kullanılır.
 */
export async function dockerAvailable(fetchlessProbe?: typeof execFile): Promise<boolean> {
  try {
    const probe = (fetchlessProbe ?? run) as unknown as
      (file: string, args: string[], opts: { timeout: number }) => Promise<{ stdout: string; stderr: string }>;
    await probe('docker', ['info'], { timeout: 15_000 });
    return true;
  } catch { return false; }
}

/**
 * R13 (fix round 1 hükümleriyle): koşullu docker spawn sarmalayıcı.
 * - host modu: spawn DEĞİŞMEZ — { cmd: bin, args: toolArgs } (mevcut resolveBin + process.execPath
 *   davranışı korunur; çağıran host yolunu doldurur).
 * - docker modu: bin resolve ATLANIR — konteyner içi `npx <toolArgs>` hedef reponun KENDİ
 *   toolchain'ini çözer. toolArgs aracı adını içerir (ör. ['tsc', '--version']) — args zaten
 *   tool-only, bin parametresi docker modda kullanılmaz.
 *
 * I2 mount stratejisi (iki bind):
 * - worktree → /workspace (repoPath; orchestrator'da .devloop/worktrees/<runId>-<task> altında).
 * - originalRepoPath verilmişse ORİJİNAL reponun node_modules'u → /workspace/node_modules
 *   (konteyner içi parent-walk eşdeğeri — npx /workspace'ten yerel çözümleme yapar; --network
 *   none altında registry erişimi yok). originalRepoPath verilmediyse ikinci bind YOK — repo
 *   toolchain'i konteynerde yoksa npx fail-closed error üretir (dokümante davranış; sessiz
 *   host-fallback yok).
 *
 * I1 env hükmü: -e flag'leri YALNIZ 'GIT_' / 'SSH_' önekli değişkenleri taşır (case-insensitive;
 * safeEnv'in git/ssh kimlik akışı kuralı). PATH/SYSTEMROOT/COMSPEC/TEMP/HOME vb. TÜMÜ hariç
 * tutulur — image ENV PATH aynen kalır, konteyner tmp kendi. safeEnv DEĞİŞMEDİ (host modu
 * kullanıcıları etkilenmez); filtre dockerizeSpawn'da yaşar.
 */
export function dockerizeSpawn(args: { repoPath: string; originalRepoPath?: string; policy: Policy; bin: string; toolArgs: string[] }): { cmd: string; args: string[] } {
  const { policy, bin, toolArgs, repoPath, originalRepoPath } = args;
  if (policy.sandbox.mode !== 'docker') return { cmd: bin, args: toolArgs };
  const dockerArgs = ['run', '--rm', '-v', `${repoPath.replaceAll('\\', '/')}:/workspace`];
  if (originalRepoPath !== undefined) {
    dockerArgs.push('-v', `${originalRepoPath.replaceAll('\\', '/')}/node_modules:/workspace/node_modules`);
  }
  dockerArgs.push('-w', '/workspace', '--network', 'none', policy.sandbox.image, 'npx', ...toolArgs);
  // I1: -e bloğu '-w /workspace' ile '--network' ARASINA girer (ilk hükmün konum semantiği;
  // index opsiyonel node_modules bind'inden bağımsız hesaplanır)
  const envFlags = Object.entries(safeEnv())
    .filter(([key]) => /^(GIT_|SSH_)/i.test(key))
    .flatMap(([key, value]) => ['-e', `${key}=${value}`]);
  dockerArgs.splice(dockerArgs.indexOf('-w') + 2, 0, ...envFlags);
  return { cmd: 'docker', args: dockerArgs };
}
