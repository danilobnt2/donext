// Waits until a deployed environment serves the expected build, then checks the page loads.
// The first deploy to a new custom domain can take a few minutes to get its certificate.
//
// Usage: node scripts/smoke-test.mjs <base-url> <git-sha>
const [baseUrl, expectedVersion] = process.argv.slice(2);
if (!baseUrl || !expectedVersion) {
  console.error('Usage: node scripts/smoke-test.mjs <base-url> <git-sha>');
  process.exit(1);
}

const deadline = Date.now() + 10 * 60 * 1000;
let lastProblem = '';

while (Date.now() < deadline) {
  try {
    const res = await fetch(new URL('/api/health', baseUrl), { cache: 'no-store' });
    const body = res.ok ? await res.json() : null;
    if (body?.version === expectedVersion) {
      const page = await fetch(baseUrl);
      const html = await page.text();
      if (!page.ok || !html.includes('<div id="app">')) {
        throw new Error(`Page check failed: HTTP ${page.status}`);
      }
      console.log(`${baseUrl} serves ${expectedVersion} (${body.environment}).`);
      process.exit(0);
    }
    lastProblem = body ? `serving ${body.version}` : `HTTP ${res.status}`;
  } catch (error) {
    lastProblem = error.message;
  }
  console.log(`Waiting for ${baseUrl}: ${lastProblem}`);
  await new Promise((resolve) => setTimeout(resolve, 15_000));
}

console.error(`Timed out waiting for ${baseUrl} to serve ${expectedVersion}: ${lastProblem}`);
process.exit(1);
