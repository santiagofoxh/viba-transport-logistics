// Seed demo data on first boot — runs only if users table is empty.
const bcrypt = require('bcrypt');
const { db } = require('./db');

function seedIfEmpty() {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM users').get();
  if (n > 0) {
    console.log('[seed] users already exist, skipping seed');
    // Ensure Daniel exists even on existing DBs
    ensureDaniel();
    // Ensure drivers are up to date
    ensureDriverNames();
    return;
  }

  console.log('[seed] Seeding demo data…');

  // Demo fallback password for driver accounts (kept simple for seeding).
  const fallbackPw = process.env.DEFAULT_DEMO_PASSWORD || 'viba2026';
  const fallbackHash = bcrypt.hashSync(fallbackPw, 10);

  // Real accounts — passwords pulled from env vars if present, else inline.
  const ownerPw = process.env.OWNER_PASSWORD || '1234567890';
  const dispatchPw = process.env.DISPATCH_PASSWORD || 'MaribelDispatch';
  const danielPw = process.env.DANIEL_PASSWORD || 'Daniel5550';
  const ownerHash = bcrypt.hashSync(ownerPw, 10);
  const dispatchHash = bcrypt.hashSync(dispatchPw, 10);
  const danielHash = bcrypt.hashSync(danielPw, 10);

  const insertUser = db.prepare(`
    INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, ?)
  `);
  // Owner — full access
  insertUser.run('rwallace', 'R. Wallace', ownerHash, 'owner');
  // Dispatch operator — limited to dispatch operations
  insertUser.run('maribel', 'Maribel', dispatchHash, 'operator');
  // Scheduler — sees schedule + map only
  insertUser.run('daniel', 'Daniel', danielHash, 'scheduler');
  // Drivers (demo)
  insertUser.run('driver1@viba.test', 'Jesus', fallbackHash, 'driver');
  insertUser.run('driver2@viba.test', 'Lencho', fallbackHash, 'driver');
  insertUser.run('driver3@viba.test', 'Perla', fallbackHash, 'driver');

  const insertDriver = db.prepare(`
    INSERT INTO drivers (name, van, zone, phone, available) VALUES (?, ?, ?, ?, 1)
  `);
  // Viba Transport's 3 drivers.
  const dJesus  = insertDriver.run('Jesus',  'Van 07', 'Central',   '915-555-0701').lastInsertRowid;
  const dLencho = insertDriver.run('Lencho', 'Van 03', 'Westside',  '915-555-0703').lastInsertRowid;
  const dPerla  = insertDriver.run('Perla',  'Van 11', 'Northeast', '915-555-0711').lastInsertRowid;

  const today = new Date().toISOString().slice(0, 10);
  const t = (h, m) => `${today}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00`;

  const insertTrip = db.prepare(`
    INSERT INTO trips (customer_name, customer_phone, pickup, dropoff, start_time, duration_min, notes, driver_id, state)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // scheduled trips
  insertTrip.run('Mr. Delgado', '915-555-0201', 'Del Sol Medical', 'Home — Dyer St',   t(7, 30), 45, '', dLencho, 'completed');
  insertTrip.run('Mr. Ortega',  '915-555-0248', 'Zaragoza',        'Providence Hosp.', t(8, 20), 50, '', dJesus, 'en_route');
  insertTrip.run('Mrs. Reyes',  '915-555-0317', 'Sunrise Senior',  'Providence Clinic', t(8, 40), 40, '', dPerla, 'dispatched');
  insertTrip.run('Mr. Herrera', '915-555-0203', 'Album Ave',       'UMC Dialysis',      t(9, 20), 55, '', dLencho, 'dispatched');
  insertTrip.run('Mrs. Alvarez','915-555-0149', '4200 Mesa St',    'Las Palmas Medical',t(9, 50), 60, 'Wheelchair van', dJesus, 'new');
  insertTrip.run('Mrs. Reyes',  '915-555-0317', 'Providence Clinic','Sunrise Senior',   t(10,45), 40, '', dPerla, 'new');
  insertTrip.run('Mr. Ortega',  '915-555-0248', 'Providence Hosp.','Zaragoza',          t(13, 0), 50, '', dPerla, 'new');
  insertTrip.run('Mrs. Garcia', '915-555-0411', 'Montana Ave',     'VA Clinic El Paso', t(16, 0), 60, '', dJesus, 'new');

  // unassigned (driver_id NULL) — candidates for AI optimize
  insertTrip.run('Mrs. Jimenez','915-555-0501', 'Cotton St',       'El Paso Cardiology', t(10,30), 45, '', null, 'new');
  insertTrip.run('Mr. Castro',  '915-555-0602', 'Yarbrough',       'Sierra Medical',     t(12, 0), 55, '', null, 'new');
  insertTrip.run('Mrs. Vargas', '915-555-0182', 'Stanton St',      'Las Palmas Imaging', t(14,30), 55, 'Wheelchair van', null, 'new');
  insertTrip.run('Mr. Soto',    '915-555-0703', 'Lee Trevino',     'Del Sol Dialysis',   t(15,30), 40, '', null, 'new');

  // tasks for operator queue (one per active trip)
  const insertTask = db.prepare(`
    INSERT INTO tasks (trip_id, driver_id, ai_task, state)
    VALUES (?, ?, ?, ?)
  `);
  const activeTrips = db.prepare(`SELECT * FROM trips WHERE state != 'completed' AND state != 'cancelled' ORDER BY start_time`).all();
  for (const tr of activeTrips) {
    const human = `Dispatch ${tr.customer_name} trip — pickup ${tr.pickup} at ${new Date(tr.start_time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} to ${tr.dropoff}${tr.notes ? '. Note: ' + tr.notes : ''}`;
    insertTask.run(tr.id, tr.driver_id, human, tr.state === 'new' ? 'new' : tr.state);
  }

  console.log('[seed] Done.');
  console.log(`[seed] Owner: rwallace   Dispatch: maribel   Scheduler: daniel`);
}

// Ensure Daniel user exists on DBs that were seeded before this update.
function ensureDaniel() {
  const exists = db.prepare("SELECT id FROM users WHERE email = 'daniel'").get();
  if (!exists) {
    const danielPw = process.env.DANIEL_PASSWORD || 'Daniel5550';
    const hash = bcrypt.hashSync(danielPw, 10);
    try {
      db.prepare("INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, ?)").run('daniel', 'Daniel', hash, 'scheduler');
      console.log('[seed] Created Daniel (scheduler)');
    } catch (e) { console.warn('[seed] Could not create Daniel:', e.message); }
  }
}

// Rename old drivers to the real names (Jesus, Lencho, Perla).
function ensureDriverNames() {
  const renames = [
    { old: 'M. Ramirez', newName: 'Jesus',  van: 'Van 07' },
    { old: 'J. Soto',    newName: 'Lencho', van: 'Van 03' },
    { old: 'L. Chavez',  newName: 'Perla',  van: 'Van 11' },
  ];
  for (const r of renames) {
    const d = db.prepare("SELECT id FROM drivers WHERE name = ?").get(r.old);
    if (d) {
      db.prepare("UPDATE drivers SET name = ? WHERE id = ?").run(r.newName, d.id);
      console.log(`[seed] Renamed driver "${r.old}" → "${r.newName}"`);
    }
  }
  // Also rename matching user records
  const userRenames = [
    { old: 'M. Ramirez', newName: 'Jesus' },
    { old: 'J. Soto',    newName: 'Lencho' },
    { old: 'L. Chavez',  newName: 'Perla' },
  ];
  for (const r of userRenames) {
    db.prepare("UPDATE users SET name = ? WHERE name = ?").run(r.newName, r.old);
  }
}

module.exports = { seedIfEmpty };
