#!/usr/bin/env node
// migrate-to-railway.js
// Run this once from your Mac to push your local data to Railway.
//
// Usage:
//   node migrate-to-railway.js https://flora-journal-production.up.railway.app
//
// Requires Node 22+ (same as the server). No extra packages needed.

const { DatabaseSync } = require('node:sqlite');
const fs   = require('fs');
const path = require('path');
const http  = require('https'); // used for multipart upload

// ── Config ────────────────────────────────────────────────────
const RAILWAY_URL = process.argv[2]?.replace(/\/$/, '');
const LOCAL_DB    = path.join(__dirname, 'db', 'journal.db');
const LOCAL_UPLOADS = path.join(__dirname, 'uploads');

if (!RAILWAY_URL) {
  console.error('\nUsage: node migrate-to-railway.js https://flora-journal-production.up.railway.app\n');
  process.exit(1);
}
if (!fs.existsSync(LOCAL_DB)) {
  console.error(`\nCannot find local database at: ${LOCAL_DB}\n`);
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────
async function post(urlPath, body) {
  const url = new URL(urlPath, RAILWAY_URL);
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? require('https') : require('http');
    const req = mod.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch(e) { reject(new Error('Bad response: ' + body)); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function uploadFile(localPath, filename) {
  const url = new URL('/api/upload', RAILWAY_URL);
  const fileData = fs.readFileSync(localPath);
  const boundary = '----FormBoundary' + Date.now();
  const ext = path.extname(filename).toLowerCase();
  const mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' }[ext] || 'image/jpeg';

  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([head, fileData, tail]);

  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? require('https') : require('http');
    const req = mod.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length
      }
    }, res => {
      let resp = '';
      res.on('data', d => resp += d);
      res.on('end', () => {
        try { resolve(JSON.parse(resp)); }
        catch(e) { reject(new Error('Bad upload response: ' + resp)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Main ──────────────────────────────────────────────────────
async function migrate() {
  console.log(`\n🌿  Flora Journal Migration`);
  console.log(`   Local DB : ${LOCAL_DB}`);
  console.log(`   Target   : ${RAILWAY_URL}\n`);

  const db = new DatabaseSync(LOCAL_DB);

  // Build a map of old local photo URL → new Railway URL
  const photoMap = new Map();

  // Collect all unique photo URLs from the database
  const allPhotos = db.prepare('SELECT DISTINCT url FROM photos WHERE url IS NOT NULL').all();
  console.log(`📸  Uploading ${allPhotos.length} photo(s)…`);

  for (const { url } of allPhotos) {
    const filename = url.replace('/uploads/', '');
    const localFile = path.join(LOCAL_UPLOADS, filename);

    if (!fs.existsSync(localFile)) {
      console.log(`   ⚠️  File not found locally, skipping: ${filename}`);
      photoMap.set(url, null);
      continue;
    }

    try {
      const result = await uploadFile(localFile, filename);
      if (result.url) {
        photoMap.set(url, result.url);
        process.stdout.write('.');
      } else {
        console.log(`\n   ⚠️  Upload failed for ${filename}:`, result);
        photoMap.set(url, null);
      }
    } catch(e) {
      console.log(`\n   ⚠️  Error uploading ${filename}:`, e.message);
      photoMap.set(url, null);
    }

    await sleep(100); // be gentle with the server
  }
  console.log('\n');

  // Load all entries with their sightings and photos
  const entries = db.prepare(
    'SELECT * FROM entries ORDER BY date ASC, id ASC'
  ).all();

  console.log(`📓  Migrating ${entries.length} journal entr${entries.length === 1 ? 'y' : 'ies'}…\n`);

  let ok = 0, fail = 0;

  for (const entry of entries) {
    // Entry-level photos
    const entryPhotos = db.prepare(
      'SELECT * FROM photos WHERE entry_id = ? AND sighting_id IS NULL ORDER BY position'
    ).all(entry.id);

    // Sightings + their photos
    const sightings = db.prepare(
      'SELECT * FROM sightings WHERE entry_id = ? ORDER BY position'
    ).all(entry.id);

    const specimens = sightings.map(s => {
      const sightingPhotos = db.prepare(
        'SELECT * FROM photos WHERE sighting_id = ? ORDER BY position'
      ).all(s.id);

      return {
        name:   s.name,
        latin:  s.latin,
        note:   s.note,
        tags:   s.tags ? s.tags.split(',').filter(Boolean) : [],
        photos: sightingPhotos
          .map(p => ({ url: photoMap.get(p.url) || p.url, caption: p.caption }))
          .filter(p => p.url)
      };
    });

    const payload = {
      date:       entry.date,
      location:   entry.location,
      outingNote: entry.outing_note,
      photos: entryPhotos
        .map(p => ({ url: photoMap.get(p.url) || p.url, caption: p.caption }))
        .filter(p => p.url),
      specimens
    };

    try {
      const result = await post('/api/entries', payload);
      if (result.id) {
        console.log(`   ✅  ${entry.date || 'no date'} — ${entry.location || 'no location'} (${specimens.length} sighting${specimens.length !== 1 ? 's' : ''})`);
        ok++;
      } else {
        console.log(`   ❌  Failed: ${entry.date} ${entry.location}`, result);
        fail++;
      }
    } catch(e) {
      console.log(`   ❌  Error: ${entry.date} ${entry.location} —`, e.message);
      fail++;
    }

    await sleep(150);
  }

  console.log(`\n─────────────────────────────────────`);
  console.log(`   ✅  ${ok} entries migrated`);
  if (fail > 0) console.log(`   ❌  ${fail} failed`);
  console.log(`\n   Open ${RAILWAY_URL} to check your journal.\n`);
}

migrate().catch(e => { console.error('\nFatal:', e.message); process.exit(1); });
