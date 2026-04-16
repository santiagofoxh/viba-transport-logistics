// SQLite database + schema migrations.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'viba.sqlite');
const db = new Database(DB_PATH);
// WAL is preferred in production; some filesystems (e.g. mounted shares) reject it.
try {
  db.pragma('journal_mode = WAL');
} catch (_e) {
  console.warn('[db] WAL mode unavailable on this filesystem, using default journal');
}
db.pragma('foreign_keys = ON');

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      email         TEXT UNIQUE NOT NULL,
      name          TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL CHECK(role IN ('operator','owner','driver','scheduler')),
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS drivers (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      van        TEXT,
      zone       TEXT,
      phone      TEXT,
      available  INTEGER DEFAULT 1,
      user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS trips (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_name    TEXT NOT NULL,
      customer_phone   TEXT,
      pickup           TEXT NOT NULL,
      dropoff          TEXT NOT NULL,
      start_time       DATETIME NOT NULL,
      duration_min     INTEGER DEFAULT 45,
      notes            TEXT,
      driver_id        INTEGER REFERENCES drivers(id) ON DELETE SET NULL,
      state            TEXT NOT NULL DEFAULT 'new'
                         CHECK(state IN ('new','dispatched','arrived_pickup','en_route','completed','cancelled')),
      created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_trips_start ON trips(start_time);
    CREATE INDEX IF NOT EXISTS idx_trips_driver ON trips(driver_id);
    CREATE INDEX IF NOT EXISTS idx_trips_state ON trips(state);

    CREATE TABLE IF NOT EXISTS tasks (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      trip_id    INTEGER REFERENCES trips(id) ON DELETE CASCADE,
      driver_id  INTEGER REFERENCES drivers(id) ON DELETE SET NULL,
      ai_task    TEXT NOT NULL,
      state      TEXT NOT NULL DEFAULT 'new'
                   CHECK(state IN ('new','dispatched','arrived_pickup','en_route','completed')),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS calls (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      twilio_sid          TEXT,
      caller_number       TEXT,
      destination_number  TEXT,
      transcript          TEXT,
      status              TEXT,
      duration_sec        INTEGER,
      started_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
      ended_at            DATETIME,
      resulting_trip_id   INTEGER REFERENCES trips(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS activity (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      kind       TEXT NOT NULL,
      text       TEXT NOT NULL,
      entity_id  INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  // Migration: add 'scheduler' to users role CHECK if table predates it.
  // SQLite doesn't allow ALTER CHECK, so we recreate if needed.
  try {
    const tableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
    if (tableInfo && tableInfo.sql && !tableInfo.sql.includes('scheduler')) {
      console.log('[db] Migrating users table to support scheduler role…');
      db.exec(`
        CREATE TABLE IF NOT EXISTS users_new (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          email         TEXT UNIQUE NOT NULL,
          name          TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          role          TEXT NOT NULL CHECK(role IN ('operator','owner','driver','scheduler')),
          created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO users_new SELECT * FROM users;
        DROP TABLE users;
        ALTER TABLE users_new RENAME TO users;
      `);
      console.log('[db] Migration complete.');
    }
  } catch (e) { console.warn('[db] Role migration skipped:', e.message); }

  console.log('[db] Schema ready at', DB_PATH);
}

module.exports = { db, initDb };
