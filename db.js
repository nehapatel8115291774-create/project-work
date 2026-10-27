// ============================================================
//  DATABASE  -  yahin pura data store hota hai
//  File:  data/gym.db   (SQLite = ek single file, install karne ki zaroorat nahi)
//  Backup lena ho to bas is ek file ki copy bana lo.
// ============================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'gym.db');

// SQLite engine: Node ka built-in (node:sqlite, Node 22.13+) -> koi install nahi chahiye.
// Purana Node ho to better-sqlite3 (npm i better-sqlite3) par fallback.
function openDb(file, { readonly = false } = {}) {
  let sqlite;
  try { sqlite = require('node:sqlite'); } catch { sqlite = null; }
  if (sqlite && sqlite.DatabaseSync) {
    const raw = new sqlite.DatabaseSync(file, { readOnly: readonly });
    const norm = (a) => (a.length === 1 && Array.isArray(a[0]) ? a[0] : a);
    return {
      exec: (sql) => raw.exec(sql),
      pragma: (sql) => raw.exec('PRAGMA ' + sql),
      prepare: (sql) => { const st = raw.prepare(sql); return {
        run: (...a) => st.run(...norm(a)), get: (...a) => st.get(...norm(a)), all: (...a) => st.all(...norm(a)) }; },
      transaction: (fn) => (...args) => {
        raw.exec('BEGIN');
        try { const r = fn(...args); raw.exec('COMMIT'); return r; } catch (e) { raw.exec('ROLLBACK'); throw e; }
      },
    };
  }
  try { const Database = require('better-sqlite3'); return new Database(file, { readonly }); }
  catch {
    console.error('\nNode version purana hai (v22.13+ chahiye).\nYa to Node LTS update karo (nodejs.org), ya chalao:  npm i better-sqlite3\n');
    process.exit(1);
  }
}

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = openDb(DB_FILE);
db.pragma('journal_mode = WAL');   // fast + safe writes
db.pragma('foreign_keys = ON');    // tables ke beech link toot na jaye

db.exec(`
CREATE TABLE IF NOT EXISTS admin_users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL            -- password kabhi plain text me save nahi hota
);

CREATE TABLE IF NOT EXISTS sessions (      -- login ke baad ka token
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS plans (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  name   TEXT NOT NULL,
  months INTEGER NOT NULL,
  price  REAL NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS members (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,       -- GYM-1001
  name        TEXT NOT NULL,
  phone       TEXT NOT NULL,
  email       TEXT,
  plan_id     INTEGER REFERENCES plans(id) ON DELETE SET NULL,
  join_date   TEXT NOT NULL,              -- YYYY-MM-DD
  expiry_date TEXT NOT NULL               -- YYYY-MM-DD  (status isi se nikalta hai)
);

CREATE TABLE IF NOT EXISTS payments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice     TEXT NOT NULL UNIQUE,       -- INV-0001
  member_id   INTEGER REFERENCES members(id) ON DELETE SET NULL,
  member_name TEXT NOT NULL,              -- member delete ho jaye tab bhi bill me naam rahe
  plan_name   TEXT,
  amount      REAL NOT NULL,
  mode        TEXT NOT NULL DEFAULT 'Cash',
  paid_on     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attendance (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id   INTEGER REFERENCES members(id) ON DELETE SET NULL,
  member_name TEXT NOT NULL,
  method      TEXT NOT NULL DEFAULT 'Manual',
  checkin_at  TEXT NOT NULL               -- YYYY-MM-DD HH:MM
);

CREATE TABLE IF NOT EXISTS staff (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  name   TEXT NOT NULL,
  role   TEXT,
  phone  TEXT,
  salary REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS equipment (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name      TEXT NOT NULL,
  qty       INTEGER NOT NULL DEFAULT 1,
  condition TEXT DEFAULT 'Good'
);

CREATE TABLE IF NOT EXISTS expenses (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  title    TEXT NOT NULL,
  amount   REAL NOT NULL,
  spent_on TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_members_expiry  ON members(expiry_date);
CREATE INDEX IF NOT EXISTS idx_payments_date   ON payments(paid_on);
CREATE INDEX IF NOT EXISTS idx_attendance_time ON attendance(checkin_at);
`);

// face scan ke liye: member ke chehre ka 128-number ka "fingerprint" (photo save nahi hoti)
if (!db.prepare("PRAGMA table_info(members)").all().some((c) => c.name === 'face_descriptor')) {
  db.exec('ALTER TABLE members ADD COLUMN face_descriptor TEXT');
}

// ---------- helpers ----------
const pad = (n) => String(n).padStart(2, '0');
const fmtDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => fmtDate(new Date());
const nowStamp = () => { const d = new Date(); return `${fmtDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };

function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return fmtDate(new Date(y, m - 1, d + n));
}
function addMonths(iso, n) {            // 31 Jan + 1 month = 28/29 Feb (month-end safe)
  const [y, m, d] = iso.split('-').map(Number);
  const first = new Date(y, m - 1 + n, 1);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  first.setDate(Math.min(d, last));
  return fmtDate(first);
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(pw, salt, 64);
  const real = Buffer.from(hash, 'hex');
  return real.length === test.length && crypto.timingSafeEqual(real, test);
}

// ---------- first-run seed ----------
if (!db.prepare('SELECT 1 FROM admin_users LIMIT 1').get()) {
  db.prepare('INSERT INTO admin_users (username, password_hash) VALUES (?, ?)').run('admin', hashPassword('admin123'));
}
if (!db.prepare('SELECT 1 FROM plans LIMIT 1').get()) {
  const ins = db.prepare('INSERT INTO plans (name, months, price) VALUES (?, ?, ?)');
  [['1 Month', 1, 1000], ['3 Months', 3, 2500], ['6 Months', 6, 4500], ['12 Months', 12, 8000]].forEach((p) => ins.run(...p));
}
const setDefault = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
setDefault.run('gym_name', 'Pro Gym');
setDefault.run('upi_id', 'yourgym@upi');

module.exports = { db, openDb, DB_FILE, today, addDays, addMonths, nowStamp, hashPassword, verifyPassword };
