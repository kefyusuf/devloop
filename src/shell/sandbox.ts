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
 * R13: koşullu docker spawn sarmalayıcı.
 * - host modu: spawn DEĞİŞMEZ — { cmd: bin, args: toolArgs } (mevcut resolveBin + process.execPath
 *   davranışı korunur; çağıran host yolunu doldurur).
 * - docker modu: bin resolve ATLANIR — konteyner içi `npx <toolArgs>` hedef reponun KENDİ
 *   toolchain'ini çözer (worktree mount /workspace; repo node_modules mount'ta olduğundan
 *   --network none altında registry erişimi olmadan yerel çözümleme çalışır). toolArgs aracı adını
 *   içerir (ör. ['tsc', '--version']) — args zaten tool-only, bin parametresi docker modda kullanılmaz.
 *
 * safeEnv alt kümesi (PATH/SYSTEMROOT/TEMP/HOME vb. — I2 sır filtresi) `-e KEY=VALUE` flag'leriyle
 * kontrat hükmü (splice index 6) gereği `-w /workspace` ile `--network` ARASINA girer.
 */
export function dockerizeSpawn(args: { repoPath: string; policy: Policy; bin: string; toolArgs: string[] }): { cmd: string; args: string[] } {
  const { policy, bin, toolArgs, repoPath } = args;
  if (policy.sandbox.mode !== 'docker') return { cmd: bin, args: toolArgs };
  const dockerArgs = ['run', '--rm', '-v', `${repoPath.replaceAll('\\', '/')}:/workspace`, '-w', '/workspace', '--network', 'none', policy.sandbox.image, 'npx', ...toolArgs];
  // I2: konteynere yalnız safeEnv izinli ayak izi taşınır (API anahtarı sızmaz)
  const envFlags = Object.entries(safeEnv()).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
  dockerArgs.splice(6, 0, ...envFlags);
  return { cmd: 'docker', args: dockerArgs };
}
