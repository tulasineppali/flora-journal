// Flora Journal — local server
// Requires Node.js 22 or newer (uses built-in node:sqlite)

const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');

const [major] = process.versions.node.split('.').map(Number);
if (major < 22) {
  console.error('\n❌  Flora Journal needs Node.js 22 or newer.');
  console.error(`   You have Node ${process.versions.node}.`);
  console.error('   Download the latest LTS from https://nodejs.org\n');
  process.exit(1);
}

const { DatabaseSync } = require('node:sqlite');

const app  = express();
const PORT = process.env.PORT || 3000;

// On Railway the persistent volume is mounted at RAILWAY_VOLUME_MOUNT_PATH.
// Locally, data lives inside the project folder as before.
const DATA_DIR    = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const DB_PATH     = path.join(DATA_DIR, 'db', 'journal.db');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const PUBLIC_DIR  = path.join(__dirname, 'public');

// Create directories BEFORE opening the DB. On first deploy the volume
// exists but its subdirectories have not been created yet.
try {
  fs.mkdirSync(path.join(DATA_DIR, 'db'), { recursive: true });
  fs.mkdirSync(UPLOADS_DIR,               { recursive: true });
} catch (e) {
  console.error('Could not create data directories:', e.message);
  console.error('DATA_DIR =', DATA_DIR);
  process.exit(1);
}

// ── Database ─────────────────────────────────────────────────
const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS entries (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    date        TEXT,
    location    TEXT,
    outing_note TEXT,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sightings (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id   INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    position   INTEGER DEFAULT 0,
    name       TEXT,
    latin      TEXT,
    note       TEXT,
    tags       TEXT
  );

  -- photos can belong to an entry (entry_id set, sighting_id null)
  -- or to a sighting (sighting_id set, entry_id null)
  CREATE TABLE IF NOT EXISTS photos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id    INTEGER REFERENCES entries(id)  ON DELETE CASCADE,
    sighting_id INTEGER REFERENCES sightings(id) ON DELETE CASCADE,
    position    INTEGER DEFAULT 0,
    url         TEXT NOT NULL,
    caption     TEXT
  );
`);

// ── Migrate old single-photo column if upgrading from previous version ──
try {
  // If sightings still has a 'photo' column, migrate it to the photos table
  const cols = db.prepare("PRAGMA table_info(sightings)").all().map(c => c.name);
  if (cols.includes('photo')) {
    const rows = db.prepare('SELECT id, photo FROM sightings WHERE photo IS NOT NULL AND photo != ""').all();
    const ins  = db.prepare('INSERT OR IGNORE INTO photos (sighting_id, position, url) VALUES (?, 0, ?)');
    rows.forEach(r => ins.run(r.id, r.url || r.photo));
    db.exec('ALTER TABLE sightings DROP COLUMN photo');
    console.log(`Migrated ${rows.length} photo(s) from old schema.`);
  }
} catch (_) {}

// ── Multer ───────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename:    (_req, file,  cb) => {
    const uid = Date.now() + '-' + Math.floor(Math.random() * 1e6);
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, uid + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) =>
    file.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('Images only'))
});

// ── Middleware ───────────────────────────────────────────────
app.use(express.json());
app.use(express.static(PUBLIC_DIR));
app.use('/uploads', express.static(UPLOADS_DIR));

// ── Shape helpers ────────────────────────────────────────────
function photosFor(entryId, sightingId) {
  if (sightingId != null) {
    return db.prepare(
      'SELECT * FROM photos WHERE sighting_id = ? ORDER BY position'
    ).all(sightingId).map(shapePhoto);
  }
  return db.prepare(
    'SELECT * FROM photos WHERE entry_id = ? AND sighting_id IS NULL ORDER BY position'
  ).all(entryId).map(shapePhoto);
}

function shapePhoto(p) {
  return { id: p.id, url: p.url, caption: p.caption || null };
}

function getEntry(id) {
  const row = db.prepare('SELECT * FROM entries WHERE id = ?').get(id);
  if (!row) return null;
  const sightings = db.prepare(
    'SELECT * FROM sightings WHERE entry_id = ? ORDER BY position'
  ).all(id);
  return {
    id:         row.id,
    date:       row.date,
    location:   row.location,
    outingNote: row.outing_note,
    createdAt:  row.created_at,
    updatedAt:  row.updated_at,
    photos:     photosFor(id, null),
    specimens:  sightings.map(s => ({
      id:     s.id,
      name:   s.name,
      latin:  s.latin,
      note:   s.note,
      tags:   s.tags ? s.tags.split(',').filter(Boolean) : [],
      photos: photosFor(null, s.id)
    }))
  };
}

// ── Entries ──────────────────────────────────────────────────
app.get('/api/entries', (req, res) => {
  const { search, place, month } = req.query;
  let sql = `SELECT DISTINCT e.*
             FROM entries e
             LEFT JOIN sightings s ON s.entry_id = e.id
             WHERE 1=1`;
  const args = [];
  if (place)  { sql += ' AND e.location = ?';  args.push(place); }
  if (month)  { sql += ' AND e.date LIKE ?';   args.push(month + '%'); }
  if (search) {
    const q = '%' + search + '%';
    sql += ` AND (
      e.location LIKE ? OR e.outing_note LIKE ? OR e.date LIKE ?
      OR s.name  LIKE ? OR s.latin LIKE ? OR s.note LIKE ? OR s.tags LIKE ?
    )`;
    args.push(q, q, q, q, q, q, q);
  }
  sql += ' ORDER BY e.date DESC, e.id DESC';
  res.json(db.prepare(sql).all(...args).map(row => getEntry(row.id)));
});

app.get('/api/entries/:id', (req, res) => {
  const e = getEntry(Number(req.params.id));
  e ? res.json(e) : res.status(404).json({ error: 'Not found' });
});

app.post('/api/entries', (req, res) => {
  const { date, location, outingNote, photos = [], specimens = [] } = req.body;
  const { lastInsertRowid: entryId } = db.prepare(
    'INSERT INTO entries (date, location, outing_note) VALUES (?, ?, ?)'
  ).run(date || null, location || null, outingNote || null);
  insertEntryPhotos(entryId, photos);
  insertSightings(entryId, specimens);
  res.status(201).json(getEntry(entryId));
});

app.put('/api/entries/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM entries WHERE id = ?').get(id))
    return res.status(404).json({ error: 'Not found' });

  const { date, location, outingNote, photos = [], specimens = [] } = req.body;
  db.prepare(
    `UPDATE entries SET date=?, location=?, outing_note=?, updated_at=datetime('now') WHERE id=?`
  ).run(date || null, location || null, outingNote || null, id);

  // Replace entry-level photos (but keep files on disk — let client manage orphans)
  db.prepare('DELETE FROM photos WHERE entry_id = ? AND sighting_id IS NULL').run(id);
  insertEntryPhotos(id, photos);

  // Replace sightings + their photos
  const oldSightings = db.prepare('SELECT id FROM sightings WHERE entry_id = ?').all(id);
  oldSightings.forEach(s => db.prepare('DELETE FROM photos WHERE sighting_id = ?').run(s.id));
  db.prepare('DELETE FROM sightings WHERE entry_id = ?').run(id);
  insertSightings(id, specimens);

  res.json(getEntry(id));
});

app.delete('/api/entries/:id', (req, res) => {
  const id = Number(req.params.id);
  // Collect all photo URLs before deleting
  const entryPhotos   = db.prepare('SELECT url FROM photos WHERE entry_id = ?').all(id);
  const sightingIds   = db.prepare('SELECT id FROM sightings WHERE entry_id = ?').all(id).map(r => r.id);
  const sightingPhotos = sightingIds.flatMap(sid =>
    db.prepare('SELECT url FROM photos WHERE sighting_id = ?').all(sid)
  );
  [...entryPhotos, ...sightingPhotos].forEach(p => deleteFile(p.url));
  db.prepare('DELETE FROM entries WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ── Photo upload / delete ────────────────────────────────────
app.post('/api/upload', upload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json({ url: '/uploads/' + req.file.filename });
});

app.delete('/api/upload', (req, res) => {
  deleteFile(req.body?.url);
  res.json({ ok: true });
});

// ── Filters ──────────────────────────────────────────────────
app.get('/api/filters', (_req, res) => {
  const places = db.prepare(
    'SELECT DISTINCT location FROM entries WHERE location IS NOT NULL ORDER BY location'
  ).all().map(r => r.location);
  const months = db.prepare(
    "SELECT DISTINCT substr(date,1,7) m FROM entries WHERE date IS NOT NULL ORDER BY m DESC"
  ).all().map(r => r.m);
  res.json({ places, months });
});

// ── Insert helpers ───────────────────────────────────────────
function insertEntryPhotos(entryId, photos) {
  const stmt = db.prepare(
    'INSERT INTO photos (entry_id, position, url, caption) VALUES (?, ?, ?, ?)'
  );
  photos.forEach((p, i) => stmt.run(entryId, i, p.url, p.caption || null));
}

function insertSightings(entryId, specimens) {
  const insS = db.prepare(
    'INSERT INTO sightings (entry_id, position, name, latin, note, tags) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const insP = db.prepare(
    'INSERT INTO photos (sighting_id, position, url, caption) VALUES (?, ?, ?, ?)'
  );
  specimens.forEach((s, i) => {
    const { lastInsertRowid: sid } = insS.run(
      entryId, i,
      s.name || null, s.latin || null, s.note || null,
      Array.isArray(s.tags) ? s.tags.join(',') : (s.tags || null)
    );
    (s.photos || []).forEach((p, pi) => insP.run(sid, pi, p.url, p.caption || null));
  });
}

function deleteFile(url) {
  if (!url) return;
  const filename = url.replace('/uploads/', '');
  if (!filename || filename.includes('/') || filename.includes('..')) return;
  try { fs.unlinkSync(path.join(UPLOADS_DIR, filename)); } catch (_) {}
}

// ── All tags (for multiselect picker) ───────────────────────
app.get('/api/tags', (_req, res) => {
  const rows = db.prepare('SELECT tags FROM sightings WHERE tags IS NOT NULL AND tags != ""').all();
  const tagSet = new Set();
  rows.forEach(r => r.tags.split(',').forEach(t => { const s = t.trim(); if (s) tagSet.add(s); }));
  res.json([...tagSet].sort());
});

// ── iNaturalist live sync ─────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS inat_imports (
    inat_id     INTEGER PRIMARY KEY,
    entry_id    INTEGER REFERENCES entries(id) ON DELETE CASCADE,
    sighting_id INTEGER,
    imported_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS inat_config (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);

try {
  const cols = db.prepare("PRAGMA table_info(inat_imports)").all().map(c => c.name);
  if (!cols.includes('sighting_id')) db.exec('ALTER TABLE inat_imports ADD COLUMN sighting_id INTEGER');
} catch (_) {}

const https = require('https');

function getConfig(key) {
  const row = db.prepare('SELECT value FROM inat_config WHERE key = ?').get(key);
  return row ? row.value : null;
}
function setConfig(key, value) {
  db.prepare('INSERT OR REPLACE INTO inat_config (key, value) VALUES (?, ?)').run(key, value);
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'FloraJournal/1.0' } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString();
          if (res.statusCode === 429) return reject(new Error('iNaturalist rate limit — wait a minute and try again'));
          if (res.statusCode >= 400) return reject(new Error(`iNaturalist returned ${res.statusCode}`));
          resolve(JSON.parse(body));
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function downloadPhoto(url) {
  return new Promise((resolve) => {
    const photoUrl = url.replace('/square.', '/large.').replace('/medium.', '/large.');
    const ext = (photoUrl.match(/\.(jpe?g|png|gif|webp)/i) || ['', '.jpg'])[0];
    const filename = Date.now() + '-' + Math.floor(Math.random() * 1e6) + ext;
    const dest = path.join(UPLOADS_DIR, filename);
    const file = fs.createWriteStream(dest);
    https.get(photoUrl, { headers: { 'User-Agent': 'FloraJournal/1.0' } }, res => {
      if (res.statusCode !== 200) { file.close(); fs.unlink(dest, () => {}); return resolve(null); }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve('/uploads/' + filename); });
    }).on('error', () => { file.close(); fs.unlink(dest, () => {}); resolve(null); });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchObservationsSince(username, sinceDate, send) {
  let page = 1, perPage = 200, allObs = [], totalResults = null;
  while (true) {
    let url = `https://api.inaturalist.org/v1/observations?user_login=${encodeURIComponent(username)}&per_page=${perPage}&page=${page}&order=asc&order_by=id`;
    if (sinceDate) url += `&updated_since=${encodeURIComponent(sinceDate)}`;
    const data = await httpsGet(url);
    if (!data.results) break;
    if (totalResults === null) totalResults = data.total_results;
    allObs = allObs.concat(data.results);
    if (send) send({ status: 'fetching', message: `Fetched ${allObs.length} of ${totalResults} observations…`, total: totalResults, fetched: allObs.length });
    if (allObs.length >= totalResults || !data.results.length) break;
    page++;
    await sleep(1100);
  }
  return allObs;
}

async function processObservations(newObs, send) {
  if (!newObs.length) return { importedSightings: 0, importedEntries: 0 };
  const alreadyImported = new Set(db.prepare('SELECT inat_id FROM inat_imports').all().map(r => r.inat_id));
  const brandNew = newObs.filter(o => !alreadyImported.has(o.id));
  if (!brandNew.length) return { importedSightings: 0, importedEntries: 0 };
  if (send) send({ status: 'processing', message: `Processing ${brandNew.length} new observation${brandNew.length !== 1 ? 's' : ''}…`, newCount: brandNew.length });

  const byDate = {};
  for (const obs of brandNew) {
    const date = obs.observed_on || obs.time_observed_at?.split('T')[0] || obs.created_at?.split('T')[0] || 'unknown';
    if (!byDate[date]) byDate[date] = [];
    byDate[date].push(obs);
  }

  const insEntry    = db.prepare('INSERT INTO entries (date, location, outing_note) VALUES (?, ?, ?)');
  const insSighting = db.prepare('INSERT INTO sightings (entry_id, position, name, latin, note, tags) VALUES (?, ?, ?, ?, ?, ?)');
  const insPhoto    = db.prepare('INSERT INTO photos (sighting_id, position, url, caption) VALUES (?, ?, ?, ?)');
  const insInat     = db.prepare('INSERT OR REPLACE INTO inat_imports (inat_id, entry_id, sighting_id) VALUES (?, ?, ?)');

  let importedSightings = 0, importedEntries = 0;
  for (const date of Object.keys(byDate).sort()) {
    const group = byDate[date];
    const existingRow = db.prepare(`SELECT DISTINCT e.id FROM entries e JOIN inat_imports ii ON ii.entry_id = e.id WHERE e.date = ? LIMIT 1`).get(date);
    let entryId;
    if (existingRow) {
      entryId = existingRow.id;
    } else {
      const loc = (group.find(o => o.place_guess) || group[0])?.place_guess || null;
      entryId = insEntry.run(date, loc, `Synced from iNaturalist — ${group.length} observation${group.length !== 1 ? 's' : ''}.`).lastInsertRowid;
      importedEntries++;
    }
    const posOffset = db.prepare('SELECT COUNT(*) as n FROM sightings WHERE entry_id = ?').get(entryId).n;
    for (let i = 0; i < group.length; i++) {
      const obs   = group[i];
      const name  = obs.taxon?.preferred_common_name || obs.taxon?.name || obs.species_guess || 'Unknown';
      const latin = obs.taxon?.name || null;
      const tags  = [obs.taxon?.iconic_taxon_name?.toLowerCase(), obs.quality_grade === 'research' ? 'research grade' : obs.quality_grade, obs.captive_cultivated ? 'cultivated' : null].filter(Boolean).join(',');
      const { lastInsertRowid: sid } = insSighting.run(entryId, posOffset + i, name, latin, obs.description || null, tags || null);
      insInat.run(obs.id, entryId, sid);
      const photos = (obs.photos || []).slice(0, 3);
      for (let pi = 0; pi < photos.length; pi++) {
        const rawUrl = photos[pi]?.url; if (!rawUrl) continue;
        const localUrl = await downloadPhoto(rawUrl);
        if (localUrl) insPhoto.run(sid, pi, localUrl, null);
        await sleep(150);
      }
      importedSightings++;
      if (send && importedSightings % 5 === 0) send({ status: 'processing', message: `Importing… ${importedSightings}/${brandNew.length} sightings`, done: importedSightings, total: brandNew.length });
    }
  }
  return { importedSightings, importedEntries };
}

app.get('/api/inaturalist/config', (_req, res) => {
  const username      = getConfig('inat_username') || '';
  const lastSync      = getConfig('inat_last_sync') || null;
  const importedCount = db.prepare('SELECT COUNT(*) as n FROM inat_imports').get().n;
  res.json({ username, lastSync, importedCount });
});

app.post('/api/inaturalist/config', (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'username required' });
  setConfig('inat_username', username.trim());
  res.json({ ok: true });
});

app.post('/api/inaturalist/sync', async (req, res) => {
  const username = req.body?.username || getConfig('inat_username');
  if (!username) return res.status(400).json({ error: 'No iNaturalist username configured' });
  setConfig('inat_username', username.trim());

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('X-Accel-Buffering', 'no');
  const send = obj => { try { res.write(JSON.stringify(obj) + '\n'); } catch (_) {} };
  const syncStartedAt = new Date().toISOString();

  try {
    const lastSync = getConfig('inat_last_sync');
    send({
      status: 'fetching',
      message: lastSync
        ? `Checking for new observations since ${new Date(lastSync).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}…`
        : 'First sync — fetching all your observations from iNaturalist…'
    });
    const observations = await fetchObservationsSince(username, lastSync, send);
    if (!observations.length) {
      setConfig('inat_last_sync', syncStartedAt);
      send({ status: 'done', imported: 0, entries: 0, message: '✓ Already up to date — no new observations.', lastSync: syncStartedAt });
      return res.end();
    }
    const { importedSightings, importedEntries } = await processObservations(observations, send);
    setConfig('inat_last_sync', syncStartedAt);
    send({
      status: 'done',
      imported: importedSightings,
      entries: importedEntries,
      skipped: observations.length - importedSightings,
      lastSync: syncStartedAt,
      message: importedSightings > 0
        ? `✓ Synced ${importedSightings} new sighting${importedSightings !== 1 ? 's' : ''} across ${importedEntries} journal entr${importedEntries !== 1 ? 'ies' : 'y'}.`
        : '✓ Already up to date — no new observations.'
    });
    res.end();
  } catch (err) {
    send({ status: 'error', message: err.message });
    res.end();
  }
});

app.post('/api/inaturalist/reset', (_req, res) => {
  setConfig('inat_last_sync', null);
  db.prepare('DELETE FROM inat_imports').run();
  res.json({ ok: true });
});

// ── Summary stats ────────────────────────────────────────────
app.get('/api/summary', (_req, res) => {
  const entries   = db.prepare('SELECT * FROM entries ORDER BY date ASC').all();
  const sightings = db.prepare('SELECT * FROM sightings').all();
  const photos    = db.prepare('SELECT * FROM photos').all();

  if (!entries.length) return res.json({ empty: true });

  const totalEntries   = entries.length;
  const totalSightings = sightings.length;
  const totalPhotos    = photos.length;

  // Date range
  const dated = entries.filter(e => e.date).sort((a,b) => a.date.localeCompare(b.date));
  const firstEntry = dated[0];
  const lastEntry  = dated[dated.length - 1];
  const uniqueDays = new Set(dated.map(e => e.date)).size;
  const avgSightings = totalEntries ? (totalSightings / totalEntries).toFixed(1) : 0;

  // Best single outing
  const sightingsByEntry = {};
  sightings.forEach(s => { sightingsByEntry[s.entry_id] = (sightingsByEntry[s.entry_id]||0) + 1; });
  const bestEntryId = Object.entries(sightingsByEntry).sort((a,b) => b[1]-a[1])[0];
  const bestEntryRow = bestEntryId ? entries.find(e => e.id === parseInt(bestEntryId[0])) : null;
  const bestEntry = bestEntryRow ? { date: bestEntryRow.date, location: bestEntryRow.location, count: parseInt(bestEntryId[1]) } : null;

  // Top locations
  const locationCount = {};
  entries.forEach(e => { if (e.location) locationCount[e.location] = (locationCount[e.location]||0) + 1; });
  const topLocations = Object.entries(locationCount).sort((a,b) => b[1]-a[1]).slice(0,5).map(([name,count]) => ({name,count}));

  // Monthly activity
  const monthlyActivity = {};
  dated.forEach(e => { const m = e.date.slice(0,7); monthlyActivity[m] = (monthlyActivity[m]||0) + 1; });
  const monthlyArr = Object.entries(monthlyActivity).sort().map(([month,count]) => ({month,count}));

  // Top species
  const nameCount = {};
  sightings.forEach(s => { if (s.name) nameCount[s.name] = (nameCount[s.name]||0) + 1; });
  const topSpecies = Object.entries(nameCount).sort((a,b) => b[1]-a[1]).slice(0,10).map(([name,count]) => ({name,count}));
  const uniqueSpecies = Object.keys(nameCount).length;
  const rareSightings = Object.values(nameCount).filter(c => c === 1).length;

  // Tag cloud
  const tagCount = {};
  sightings.forEach(s => {
    if (s.tags) s.tags.split(',').forEach(t => { const k = t.trim(); if (k) tagCount[k] = (tagCount[k]||0) + 1; });
  });
  const tagCloud = Object.entries(tagCount).sort((a,b) => b[1]-a[1]).slice(0,30).map(([tag,count]) => ({tag,count}));

  // Seasonal breakdown (tuned for South India)
  const seasons = { Spring:0, Summer:0, Monsoon:0, Autumn:0, Winter:0 };
  dated.forEach(e => {
    const m = parseInt(e.date.slice(5,7));
    if      (m>=3&&m<=5)  seasons.Spring++;
    else if (m>=6&&m<=7)  seasons.Summer++;
    else if (m>=8&&m<=9)  seasons.Monsoon++;
    else if (m>=10&&m<=11)seasons.Autumn++;
    else                   seasons.Winter++;
  });

  // Day-of-week pattern
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const dowCount = {Sun:0,Mon:0,Tue:0,Wed:0,Thu:0,Fri:0,Sat:0};
  dated.forEach(e => { const d = new Date(e.date+'T12:00:00'); dowCount[days[d.getDay()]]++; });

  // Longest consecutive-day streak
  const daySet = [...new Set(dated.map(e => e.date))].sort();
  let maxStreak = daySet.length ? 1 : 0, curStreak = 1;
  for (let i = 1; i < daySet.length; i++) {
    const diff = (new Date(daySet[i]) - new Date(daySet[i-1])) / 86400000;
    if (diff === 1) { curStreak++; maxStreak = Math.max(maxStreak, curStreak); } else curStreak = 1;
  }

  // Recent momentum: last 30 vs prior 30 days
  const now  = new Date();
  const d30  = new Date(now - 30*86400000).toISOString().slice(0,10);
  const d60  = new Date(now - 60*86400000).toISOString().slice(0,10);
  const last30  = dated.filter(e => e.date >= d30).length;
  const prior30 = dated.filter(e => e.date >= d60 && e.date < d30).length;

  // Most photographed species
  const photosBySighting = {};
  photos.filter(p => p.sighting_id).forEach(p => { photosBySighting[p.sighting_id] = (photosBySighting[p.sighting_id]||0) + 1; });
  const sightingById = {};
  sightings.forEach(s => sightingById[s.id] = s);
  const mostPhotographed = Object.entries(photosBySighting)
    .sort((a,b) => b[1]-a[1]).slice(0,5)
    .map(([sid,count]) => ({ name: sightingById[sid]?.name || 'Unknown', count }));

  res.json({
    empty: false,
    totalEntries, totalSightings, totalPhotos, uniqueDays,
    avgSightings: parseFloat(avgSightings),
    uniqueSpecies, rareSightings,
    firstEntry: firstEntry ? { date: firstEntry.date, location: firstEntry.location } : null,
    lastEntry:  lastEntry  ? { date: lastEntry.date,  location: lastEntry.location  } : null,
    bestEntry, topLocations, monthlyArr, topSpecies, tagCloud,
    seasons, dowCount, maxStreak, last30, prior30, mostPhotographed,
  });
});

// ── Start ─────────────────────────────────────────────────────
// Pre-seed last sync date if user has already manually imported up to a point
{
  const existing = db.prepare("SELECT value FROM inat_config WHERE key = 'inat_last_sync'").get();
  if (!existing) {
    db.prepare("INSERT OR IGNORE INTO inat_config (key, value) VALUES ('inat_last_sync', '2026-04-25T23:59:59.000Z')").run();
    console.log('ℹ️  iNaturalist: last sync pre-seeded to April 10, 2025. Next sync will only fetch newer observations.');
  }
}
app.listen(PORT, () => {
  console.log(`\n🌿  Flora Journal → http://localhost:${PORT}\n   Press Ctrl+C to stop\n`);
});
