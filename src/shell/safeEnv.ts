/**
 * I2 (final review): spawn edilen süreçlere sırlar sızmaz. Orchestrator/gateway/API anahtarı gibi
 * env değişkenleri çocuk süreçlere (git, gh, eslint/tsc/vitest) aktarılmaz — yalnız araçların
 * çalışması için gereken ayak izi seçilir. GIT_/SSH_ önekleri git/ssh kimlik akışı içindir
 * (GIT_DIR, GIT_SSH_COMMAND, SSH_AUTH_SOCK vb.) — API anahtarı taşımazlar.
 */
const ALLOWED = new Set([
  'PATH', 'SYSTEMROOT', 'COMSPEC', 'TEMP', 'TMP', 'HOME', 'USERPROFILE',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES',
]);

export function safeEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (ALLOWED.has(upper) || upper.startsWith('GIT_') || upper.startsWith('SSH_')) out[key] = value;
  }
  return out;
}
