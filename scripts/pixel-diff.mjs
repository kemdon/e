import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const distDir = path.join(root, 'dist');
const sitemapPath = path.join(root, 'clone', 'sitemap.json');

const artifactsRoot = path.join(root, '.artifacts', 'pixel-diff');
const localDir = path.join(artifactsRoot, 'local');
const remoteDir = path.join(artifactsRoot, 'remote');
const diffDir = path.join(artifactsRoot, 'diff');
const reportJson = path.join(artifactsRoot, 'report.json');
const reportMd = path.join(artifactsRoot, 'report.md');

const localOrigin = process.env.PIXEL_LOCAL_ORIGIN ?? 'http://127.0.0.1:4173';
const remoteOrigin = process.env.PIXEL_REMOTE_ORIGIN ?? 'https://liskfence.com';
const viewportWidth = Number(process.env.PIXEL_VIEWPORT_W ?? 1920);
const viewportHeight = Number(process.env.PIXEL_VIEWPORT_H ?? 1080);
const pixelThreshold = Number(process.env.PIXEL_THRESHOLD ?? 0.1);
const maxPages = Number(process.env.PIXEL_MAX_PAGES ?? 0);

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function clearDir(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  ensureDir(dir);
}

function normalizePathname(input) {
  const u = new URL(input);
  const pathname = u.pathname || '/';
  return pathname.endsWith('/') ? pathname : `${pathname}/`;
}

function pathToKey(pathname) {
  if (pathname === '/') {
    return '__home__';
  }
  return pathname.replace(/^\/+/, '').replace(/\/+$/, '').replace(/[\/\\?%*:|"<>]/g, '__');
}

function readRouteList() {
  const sitemap = JSON.parse(fs.readFileSync(sitemapPath, 'utf8'));
  const unique = new Map();
  for (const entry of sitemap) {
    const pathname = normalizePathname(entry.url);
    if (!unique.has(pathname)) {
      unique.set(pathname, entry.title ?? '');
    }
  }
  const routes = [...unique.entries()].map(([pathname, title]) => ({ pathname, title }));
  return maxPages > 0 ? routes.slice(0, maxPages) : routes;
}

function createStaticServer(baseDir, port = 4173) {
  const server = http.createServer((req, res) => {
    const reqPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const safePath = reqPath.replace(/\\/g, '/');
    const rel = safePath === '/' ? '/index.html' : safePath;
    const filePath = path.join(baseDir, rel);
    let target = filePath;

    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
      target = path.join(target, 'index.html');
    } else if (!fs.existsSync(target)) {
      const fallback = path.join(baseDir, safePath, 'index.html');
      if (fs.existsSync(fallback)) {
        target = fallback;
      }
    }

    if (!target.startsWith(baseDir) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }

    const ext = path.extname(target).toLowerCase();
    const contentType = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.ico': 'image/x-icon'
    }[ext] ?? 'application/octet-stream';

    res.setHeader('Content-Type', contentType);
    fs.createReadStream(target).pipe(res);
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

async function capturePage(page, url, outputPngPath) {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 120000 });
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation: none !important;
        transition: none !important;
        caret-color: transparent !important;
      }
      html { scroll-behavior: auto !important; }
    `
  });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(700);
  await page.screenshot({ path: outputPngPath, fullPage: true });
}

function comparePng(localPath, remotePath, diffPath) {
  const localPng = PNG.sync.read(fs.readFileSync(localPath));
  const remotePng = PNG.sync.read(fs.readFileSync(remotePath));

  const width = Math.min(localPng.width, remotePng.width);
  const height = Math.min(localPng.height, remotePng.height);

  const localCrop = new PNG({ width, height });
  const remoteCrop = new PNG({ width, height });
  PNG.bitblt(localPng, localCrop, 0, 0, width, height, 0, 0);
  PNG.bitblt(remotePng, remoteCrop, 0, 0, width, height, 0, 0);

  const diff = new PNG({ width, height });
  const diffPixels = pixelmatch(
    localCrop.data,
    remoteCrop.data,
    diff.data,
    width,
    height,
    {
      threshold: pixelThreshold,
      includeAA: true
    }
  );

  fs.writeFileSync(diffPath, PNG.sync.write(diff));
  const total = width * height;
  const ratio = total === 0 ? 0 : diffPixels / total;

  return {
    localWidth: localPng.width,
    localHeight: localPng.height,
    remoteWidth: remotePng.width,
    remoteHeight: remotePng.height,
    compareWidth: width,
    compareHeight: height,
    diffPixels,
    diffRatio: ratio
  };
}

function writeReport(results) {
  const totals = {
    pages: results.length,
    avgDiffRatio: results.reduce((acc, x) => acc + x.diffRatio, 0) / Math.max(1, results.length),
    maxDiffRatio: Math.max(0, ...results.map((x) => x.diffRatio))
  };

  const payload = {
    generatedAt: new Date().toISOString(),
    options: {
      localOrigin,
      remoteOrigin,
      viewportWidth,
      viewportHeight,
      pixelThreshold
    },
    totals,
    results: results.sort((a, b) => b.diffRatio - a.diffRatio)
  };

  fs.writeFileSync(reportJson, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  const lines = [];
  lines.push('# Pixel Diff Report');
  lines.push('');
  lines.push(`- Generated: ${payload.generatedAt}`);
  lines.push(`- Pages: ${totals.pages}`);
  lines.push(`- Avg diff ratio: ${(totals.avgDiffRatio * 100).toFixed(2)}%`);
  lines.push(`- Max diff ratio: ${(totals.maxDiffRatio * 100).toFixed(2)}%`);
  lines.push('');
  lines.push('| Path | Diff Ratio | Diff Pixels | Local Size | Remote Size |');
  lines.push('|---|---:|---:|---|---|');
  for (const row of payload.results) {
    lines.push(
      `| ${row.pathname} | ${(row.diffRatio * 100).toFixed(2)}% | ${row.diffPixels} | ${row.localWidth}x${row.localHeight} | ${row.remoteWidth}x${row.remoteHeight} |`
    );
  }
  fs.writeFileSync(reportMd, `${lines.join('\n')}\n`, 'utf8');
}

async function main() {
  if (!fs.existsSync(distDir)) {
    throw new Error('Missing dist directory. Run npm run build first.');
  }

  clearDir(localDir);
  clearDir(remoteDir);
  clearDir(diffDir);
  ensureDir(artifactsRoot);

  const routes = readRouteList();
  const server = await createStaticServer(distDir, 4173);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: viewportWidth, height: viewportHeight },
    deviceScaleFactor: 1
  });
  const page = await context.newPage();

  const results = [];
  try {
    for (const route of routes) {
      const key = pathToKey(route.pathname);
      const localUrl = `${localOrigin}${route.pathname}`;
      const remoteUrl = `${remoteOrigin}${route.pathname}`;
      const localPng = path.join(localDir, `${key}.png`);
      const remotePng = path.join(remoteDir, `${key}.png`);
      const diffPng = path.join(diffDir, `${key}.png`);

      console.log(`capture ${route.pathname}`);
      await capturePage(page, localUrl, localPng);
      await capturePage(page, remoteUrl, remotePng);

      const stat = comparePng(localPng, remotePng, diffPng);
      results.push({
        pathname: route.pathname,
        title: route.title,
        ...stat
      });
    }
  } finally {
    await context.close();
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }

  writeReport(results);
  console.log(`report: ${reportJson}`);
  console.log(`table:  ${reportMd}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
