import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const cloneDir = path.join(root, 'clone');
const resourcesSrc = path.join(cloneDir, 'resources');
const resourcesDest = path.join(root, 'public', 'resources');
const commonResponsiveDest = path.join(resourcesDest, 'common', 'responsive.css');
const livePagesDir = path.join(cloneDir, 'live_pages');
const livePagesManifest = path.join(livePagesDir, 'manifest.json');
const xmlPath = path.join(root, 'liskfence.WordPress.2026-03-02.xml');
const summaryDest = path.join(root, 'src', 'data', 'wp-export-summary.json');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyDirRecursive(src, dest) {
  if (!fs.existsSync(src)) {
    throw new Error(`Missing source directory: ${src}`);
  }
  ensureDir(dest);

  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function extractCdata(line, tag) {
  const re = new RegExp(`<${tag}><!\\[CDATA\\[(.*)\\]\\]></${tag}>`);
  const match = line.match(re);
  return match ? match[1] : '';
}

function extractTag(line, tag) {
  const re = new RegExp(`<${tag}>(.*)</${tag}>`);
  const match = line.match(re);
  return match ? match[1] : '';
}

async function fetchLiveOverrides() {
  const targetPaths = ['/', '/prisons/', '/event-security/', '/airports/', '/government-complex/'];
  ensureDir(livePagesDir);

  const entries = {};
  for (const pathname of targetPaths) {
    const url = `https://liskfence.com${pathname}`;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 25000);
      const response = await fetch(url, {
        headers: {
          'user-agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
        },
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`status ${response.status}`);
      }

      const html = await response.text();
      const key = pathname === '/' ? '__home__' : pathname.replace(/^\/|\/$/g, '').replace(/\//g, '__');
      const file = `${key}.html`;
      const outputFile = path.join(livePagesDir, file);
      fs.writeFileSync(outputFile, html, 'utf8');
      entries[pathname] = { file, source: url };
    } catch (error) {
      console.warn(`Live override fetch failed for ${url}: ${error.message}`);
    }
  }

  fs.writeFileSync(
    livePagesManifest,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), entries }, null, 2)}\n`,
    'utf8'
  );
}

function parseWpExportSummary(xmlFilePath) {
  const lines = fs.readFileSync(xmlFilePath, 'utf8').split(/\r?\n/);

  let inItem = false;
  let item = {};
  const items = [];

  for (const line of lines) {
    if (line.includes('<item>')) {
      inItem = true;
      item = { title: '', link: '', slug: '', postType: '', status: '' };
      continue;
    }

    if (!inItem) {
      continue;
    }

    if (line.includes('<title><![CDATA[')) {
      item.title = extractCdata(line, 'title');
      continue;
    }

    if (line.includes('<link>') && line.includes('</link>')) {
      item.link = extractTag(line, 'link');
      continue;
    }

    if (line.includes('<wp:post_name><![CDATA[')) {
      item.slug = extractCdata(line, 'wp:post_name');
      continue;
    }

    if (line.includes('<wp:post_type><![CDATA[')) {
      item.postType = extractCdata(line, 'wp:post_type');
      continue;
    }

    if (line.includes('<wp:status><![CDATA[')) {
      item.status = extractCdata(line, 'wp:status');
      continue;
    }

    if (line.includes('</item>')) {
      inItem = false;
      items.push(item);
    }
  }

  const byType = {};
  for (const entry of items) {
    byType[entry.postType] = (byType[entry.postType] ?? 0) + 1;
  }

  const publishedPages = items
    .filter((entry) => entry.postType === 'page' && entry.status === 'publish')
    .map((entry) => ({ title: entry.title, link: entry.link, slug: entry.slug }));

  const publishedPosts = items
    .filter((entry) => entry.postType === 'post' && entry.status === 'publish')
    .map((entry) => ({ title: entry.title, link: entry.link, slug: entry.slug }));

  return {
    generatedAt: new Date().toISOString(),
    counts: {
      totalItems: items.length,
      byPostType: byType,
      publishedPages: publishedPages.length,
      publishedPosts: publishedPosts.length
    },
    publishedPages,
    publishedPosts
  };
}

ensureDir(path.join(root, 'public'));
copyDirRecursive(resourcesSrc, resourcesDest);
ensureDir(path.dirname(commonResponsiveDest));
fs.copyFileSync(path.join(cloneDir, 'pages', '001_home_359ccde9', 'responsive.css'), commonResponsiveDest);
await fetchLiveOverrides();

const summary = parseWpExportSummary(xmlPath);
ensureDir(path.dirname(summaryDest));
fs.writeFileSync(summaryDest, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

console.log(`Copied resources to: ${resourcesDest}`);
console.log(`Copied responsive css to: ${commonResponsiveDest}`);
console.log(`Wrote live overrides: ${livePagesManifest}`);
console.log(`Wrote summary: ${summaryDest}`);
console.log(`Published pages: ${summary.counts.publishedPages}`);
console.log(`Published posts: ${summary.counts.publishedPosts}`);
