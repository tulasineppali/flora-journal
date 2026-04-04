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

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🌿  Flora Journal → http://localhost:${PORT}\n   Press Ctrl+C to stop\n`);
});
