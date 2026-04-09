// Self-healing stream URL finder
// Run with: node fix-streams.js
// Scrapes source sites to find current stream URLs and patches index.html

const fs = require('fs');
const https = require('https');
const http = require('http');

function fetch(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function findYamitStream() {
  console.log('Scraping Yamit stream...');

  // Step 1: Get the alias from beachcam.co.il
  const page = await fetch('https://beachcam.co.il/yamit.html');
  let alias = page.match(/alias[=:\s'"]+([a-f0-9]{13})/i)?.[1];

  if (!alias) {
    // Fallback: load the sub-page
    const subpage = await fetch('https://beachcam.co.il/ad13a7a2020.html');
    alias = subpage.match(/alias[=:\s'"]+([a-f0-9]{13})/i)?.[1];
  }

  if (!alias) {
    // Last resort: use known alias
    alias = '63454584c4c3c';
    console.log('  Using known alias as fallback:', alias);
  } else {
    console.log('  Found alias:', alias);
  }

  // Step 2: Get stream ID and server from ipcamlive player API
  const player = await fetch(`https://ipcamlive.com/player/player.php?alias=${alias}&websocketenabled=1&autoplay=1`);

  const address = player.match(/var address\s*=\s*['"]([^'"]+)['"]/)?.[1];
  const streamid = player.match(/var streamid\s*=\s*['"]([^'"]+)['"]/)?.[1];

  if (!address || !streamid) {
    throw new Error('Could not extract stream ID from ipcamlive player page');
  }

  // Ensure HTTPS
  const baseUrl = address.replace('http://', 'https://');
  const streamUrl = `${baseUrl}streams/${streamid}/stream.m3u8`;
  console.log('  New Yamit URL:', streamUrl);
  return streamUrl;
}

async function findHiltonStream() {
  console.log('Scraping Hilton stream...');

  const page = await fetch('https://www.wavehub.co.il/stream/hilton-a-rights');
  const candidates = new Set();

  // Collect any stream URLs embedded directly in the page source.
  for (const match of page.matchAll(/https:\/\/vod\.wavehub\.co\.il\/[^\s"'\\]+\.m3u8/g)) {
    candidates.add(match[0]);
  }

  // Look in __NEXT_DATA__ for stream config and collect every declared variant.
  const nextData = page.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)?.[1];
  if (nextData) {
    const parsed = JSON.parse(nextData);
    const json = JSON.stringify(parsed);

    for (const match of json.matchAll(/https:\/\/vod\.wavehub\.co\.il\/[^"'\\]+(?:\.m3u8|\.stream\/playlist\.m3u8)/g)) {
      candidates.add(match[0]);
    }

    const streamName = json.match(/HiltonA[A-Za-z0-9_]+(?:HD|SD)/)?.[0];
    if (streamName) {
      candidates.add(`https://vod.wavehub.co.il/live/_definst_/${streamName}.stream/playlist.m3u8`);
    }
  }

  // Fallback: known URL patterns seen on WaveHub.
  for (const url of [
    'https://vod.wavehub.co.il/live/_definst_/HiltonA_Lefts_HD.stream/playlist.m3u8',
    'https://vod.wavehub.co.il/live/_definst_/HiltonA_Lefts_SD.stream/playlist.m3u8',
    'https://vod.wavehub.co.il/wavehub-live-4k/_definst_/HiltonA_Lefts.stream/playlist.m3u8'
  ]) {
    candidates.add(url);
  }

  console.log(`  Testing ${candidates.size} candidate URLs...`);
  for (const url of candidates) {
    const ok = await checkUrl(url);
    if (ok) {
      console.log('  Working Hilton stream found:', url);
      return url;
    }

    console.log('  Candidate failed:', url);
  }

  throw new Error('WaveHub page only exposes dead Hilton playlist URLs');
}

function checkUrl(url) {
  return new Promise(resolve => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      resolve(res.statusCode === 200);
      res.resume();
    });
    req.on('error', () => resolve(false));
    req.setTimeout(10000, () => { req.destroy(); resolve(false); });
  });
}

async function main() {
  const indexPath = './index.html';
  let html = fs.readFileSync(indexPath, 'utf8');
  let changed = false;

  // Check and fix Yamit
  const yamitOk = await checkUrl(html.match(/name: 'Yamit Beach'.*?url: '([^']+)'/s)?.[1] || '');
  if (!yamitOk) {
    console.log('Yamit stream is down - finding new URL...');
    try {
      const newUrl = await findYamitStream();
      html = html.replace(
        /(\{ name: 'Yamit Beach', url: ')[^']+(')/,
        `$1${newUrl}$2`
      );
      changed = true;
      console.log('Yamit stream updated');
    } catch (e) {
      console.error('Failed to find Yamit stream:', e.message);
      process.exitCode = 1;
    }
  } else {
    console.log('Yamit stream is healthy');
  }

  // Check and fix Hilton
  const hiltonOk = await checkUrl(html.match(/name: 'Hilton A - Lefts'.*?url: '([^']+)'/s)?.[1] || '');
  if (!hiltonOk) {
    console.log('Hilton stream is down - finding new URL...');
    try {
      const newUrl = await findHiltonStream();
      html = html.replace(
        /(\{ name: 'Hilton A - Lefts', url: ')[^']+(')/,
        `$1${newUrl}$2`
      );
      changed = true;
      console.log('Hilton stream updated');
    } catch (e) {
      console.error('Failed to find Hilton stream:', e.message);
      process.exitCode = 1;
    }
  } else {
    console.log('Hilton stream is healthy');
  }

  if (changed) {
    fs.writeFileSync(indexPath, html);
    console.log('\nindex.html updated with new stream URLs');
  } else {
    console.log('\nNo changes needed');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
