// Seed demo data on first boot — runs only if users table is empty.
const bcrypt = require('bcrypt');
const { db } = require('./db');

function seedIfEmpty() {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM users').get();
  if (n > 0) { console.log('[seed] users already exist, skipping seed'); return; }

  console.log('[seed] Seeding demo data…');

  const initialPw = process.env.DEFAULT_DEMO_PASSWORD || 'viba2026';
  const hash = bcrypt.hashSync(initialPw, 10);

  const insertUser = db.prepare(`
    INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, ?)
  `);
  insertUser.run('operator@viba.test', 'Maria Gonzalez', hash, 'operator');
  insertUser.run('owner@viba.test', 'Viba Owner', hash, 'owner');
  insertUser.run('driver1@viba.test', 'M. Ramirez', hash, 'driver');
  insertUser.run('driver2@viba.test', 'J. Soto', hash, 'driver');

  const insertDriver = db.prepare(`
    INSERT INTO drivers (name, van, zone, phone, available) VALUES (?, ?, ?, ?, 1)
  `);
  const dMR = insertDriver.run('M. Ramirez', 'Van 07', 'Central',        '915-555-0701').lastInsertRowid;
  const dJS = insertDriver.run('J. Soto',    'Van 03', 'Westside',       '915-555-0703').lastInsertRowid;
  const dLC = insertDriver.run('L. Chavez',  'Van 11', 'Northeast',      '915-555-0711').lastInsertRowid;
  const dRF = insertDriver.run('R. Fox',     'Van 09', 'East',           '915-555-0709').lastInsertRowid;
  const dDM = insertDriver.run('D. Mendez',  'Van 05', 'Mission Valley', '915-555-0705').lastInsertRowid;
  // set D. Mendez unavailable (off today)
  db.prepare('UPDATE drivers SET available = 0 WHERE id = ?').run(dDM);

  const today = new Date().toISOString().slice(0, 10);
  const t = (h, m) => `${today}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00`;

  const insertTrip = db.prepare(`
    INSERT INTO trips (customer_name, customer_phone, pickup, dropoff, start_time, duration_min, notes, driver_id, state)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // scheduled trips
  insertTrip.run('Mr. Delgado', '915-555-0201', 'Del Sol Medical', 'Home — Dyer St',   t(7, 30), 45, '', dJS, 'completed');
  insertTrip.run('Mr. Ortega',  '915-555-0248', 'Zaragoza',        'Providence Hosp.', t(8, 20), 50, '', dMR, 'en_route');
  insertTrip.run('Mrs. Reyes',  '915-555-0317', 'Sunrise Senior',  'Providence Clinic', t(8, 40), 40, '', dLC, 'dispatched');
  insertTrip.run('Mr. Herrera', '915-555-0203', 'Album Ave',       'UMC Dialysis',      t(9, 20), 55, '', dJS, 'dispatched');
  insertTrip.run('Mrs. Alvarez','915-555-0149', '4200 Mesa St',    'Las Palmas Medical',t(9, 50), 60, 'Wheelchair van', dMR, 'new');
  insertTrip.run('Mrs. Reyes',  '915-555-0317', 'Providence Clinic','Sunrise Senior',   t(10,45), 40, '', dLC, 'new');
  insertTrip.run('Mr. Ortega',  '915-555-0248', 'Providence Hosp.','Zaragoza',          t(13, 0), 50, '', dRF, 'new');
  insertTrip.run('Mrs. Garcia', '915-555-0411', 'Montana Ave',     'VA Clinic El Paso', t(16, 0), 60, '', dRF, 'new');

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
  console.log(`[seed] Login with operator@viba.test / ${initialPw}`);
}

module.exports = { seedIfEmpty };
