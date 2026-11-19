#!/usr/bin/env node
import { buildCli } from './shell/cli.js';
buildCli().parseAsync(process.argv).catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
