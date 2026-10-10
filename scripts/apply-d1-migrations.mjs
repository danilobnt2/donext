// Applies pending D1 migrations for every D1 database the given environment declares in
// apps/worker/wrangler.jsonc. With none declared it does nothing, so the release pipeline
// can always run it before a deploy.
//
// Usage: node scripts/apply-d1-migrations.mjs <staging|production>
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parse } from 'jsonc-parser';

const environment = process.argv[2];
if (!environment) {
  console.error('Usage: node scripts/apply-d1-migrations.mjs <environment>');
  process.exit(1);
}

const configPath = new URL('../apps/worker/wrangler.jsonc', import.meta.url);
const config = parse(readFileSync(configPath, 'utf8'));
const envConfig = config.env?.[environment];
if (!envConfig) {
  console.error(`No environment "${environment}" in wrangler.jsonc`);
  process.exit(1);
}

const databases = envConfig.d1_databases ?? [];
if (databases.length === 0) {
  console.log(`No D1 databases declared for ${environment}; nothing to migrate.`);
}
for (const { binding } of databases) {
  console.log(`Applying D1 migrations for ${binding} (${environment})`);
  execFileSync(
    'pnpm',
    ['exec', 'wrangler', 'd1', 'migrations', 'apply', binding, '--env', environment, '--remote'],
    { cwd: new URL('../apps/worker/', import.meta.url), stdio: 'inherit' },
  );
}
