import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const run = promisify(execFile);

export class PrReporter {
  constructor(private readonly repoPath: string) {}
  async openPr(branch: string, title: string, body: string, taskId: string): Promise<{ url: string | null }> {
    try {
      await run('git', ['push', '-u', 'origin', branch], { cwd: this.repoPath, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
      const { stdout } = await run('gh', ['pr', 'create', '--title', title, '--body', body, '--head', branch], { cwd: this.repoPath, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
      return { url: stdout.trim().split('\n').pop() ?? null };
    } catch {
      const dir = join(this.repoPath, '.devloop', 'reports');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${taskId}.md`), `# ${title}\n\nBranch: ${branch}\n\n${body}\n`, 'utf8');
      return { url: null }; // gh yok / remote yok → yerel rapor (insan gate yine insanda)
    }
  }
}
