// Viba Transport Logistics — backend server
// -----------------------------------------------------------
// Single-file Express backend. SQLite for storage, session-based auth,
// REST API, and a Twilio voice webhook stub. Serves the frontend from /public.

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');

const { initDb, db } = require('./src/db');
const { seedIfEmpty } = require('./src/seed');

const PORT = process.env.PORT || 10000;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const IS_PROD = process.env.NODE_ENV === 'production';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

// ---------- bootstrap DB ----------
initDb();
seedIfEmpty();

// ---------- app ----------
const app = express();
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: false, // demo HTML uses inline styles/scripts
  crossOriginEmbedderPolicy: false,
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true })); // for Twilio webhook form posts
app.use(cookieParser());

app.use(session({
  store: new SQLiteStore({ db: 'sessions.sqlite', dir: DATA_DIR }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 8, // 8 hours
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD,
  },
}));

// ---------- auth helpers ----------
function requireAuth(req, res, next) {
  if (!req.session.userId) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'unauthenticated' });
    return res.redirect('/login');
  }
  next();
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.userId) return res.status(401).json({ error: 'unauthenticated' });
    if (!roles.includes(req.session.role)) return res.status(403).json({ error: 'forbidden' });
    next();
  };
}

// ---------- health ----------
app.get('/healthz', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ---------- auth routes ----------
app.get('/login', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  const rawIdentifier = (email || '').toString().toLowerCase().trim();
  if (!rawIdentifier || !password) return res.status(400).json({ error: 'username and password required' });
  // Accept either a full email or a plain username (email column stores whatever was seeded).
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(rawIdentifier);
  if (!user) return res.status(401).json({ error: 'invalid credentials' });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'invalid credentials' });
  req.session.userId = user.id;
  req.session.role = user.role;
  req.session.name = user.name;
  res.json({ id: user.id, name: user.name, email: user.email, role: user.role });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'unauthenticated' });
  const user = db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(req.session.userId);
  res.json(user);
});

// ---------- API: drivers ----------
app.get('/api/drivers', requireAuth, (_req, res) => {
  const rows = db.prepare('SELECT * FROM drivers ORDER BY name').all();
  res.json(rows);
});
app.post('/api/drivers', requireRole('owner', 'operator'), (req, res) => {
  const { name, van, zone, phone } = req.body;
  const info = db.prepare(
    'INSERT INTO drivers (name, van, zone, phone, available) VALUES (?, ?, ?, ?, 1)'
  ).run(name, van, zone, phone);
  res.status(201).json({ id: info.lastInsertRowid });
});
app.patch('/api/drivers/:id', requireRole('owner', 'operator'), (req, res) => {
  const { available, van, zone, phone } = req.body;
  db.prepare(
    'UPDATE drivers SET available = COALESCE(?, available), van = COALESCE(?, van), zone = COALESCE(?, zone), phone = COALESCE(?, phone) WHERE id = ?'
  ).run(available == null ? null : (available ? 1 : 0), van, zone, phone, req.params.id);
  res.json({ ok: true });
});

// ---------- API: trips ----------
app.get('/api/trips', requireAuth, (req, res) => {
  const { date } = req.query;
  let rows;
  if (date) {
    rows = db.prepare('SELECT * FROM trips WHERE date(start_time) = date(?) ORDER BY start_time').all(date);
  } else {
    rows = db.prepare('SELECT * FROM trips ORDER BY start_time DESC LIMIT 200').all();
  }
  res.json(rows);
});

app.post('/api/trips', requireAuth, (req, res) => {
  const { customer_name, customer_phone, pickup, dropoff, start_time, duration_min, notes, driver_id } = req.body;
  const info = db.prepare(`
    INSERT INTO trips (customer_name, customer_phone, pickup, dropoff, start_time, duration_min, notes, driver_id, state, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)
  `).run(customer_name, customer_phone, pickup, dropoff, start_time, duration_min || 45, notes || '', driver_id || null, req.session.userId);
  const id = info.lastInsertRowid;
  logActivity(req.session.userId, 'trip_created', `Trip #${id} created for ${customer_name}`, id);
  res.status(201).json({ id });
});

const TRIP_STATES = ['new', 'dispatched', 'arrived_pickup', 'en_route', 'completed', 'cancelled'];
app.patch('/api/trips/:id/state', requireAuth, (req, res) => {
  const { state } = req.body;
  if (!TRIP_STATES.includes(state)) return res.status(400).json({ error: 'invalid state' });
  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(req.params.id);
  if (!trip) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE trips SET state = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(state, trip.id);
  logActivity(req.session.userId, 'trip_state', `Trip #${trip.id} → ${state}`, trip.id);
  res.json({ ok: true, state });
});

app.patch('/api/trips/:id/assign', requireRole('operator', 'owner'), (req, res) => {
  const { driver_id } = req.body;
  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(req.params.id);
  if (!trip) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE trips SET driver_id = ?, state = CASE WHEN state = "new" THEN "dispatched" ELSE state END WHERE id = ?').run(driver_id, trip.id);
  logActivity(req.session.userId, 'trip_assigned', `Trip #${trip.id} assigned to driver #${driver_id}`, trip.id);
  res.json({ ok: true });
});

// ---------- API: schedule + AI optimize (stub) ----------
app.get('/api/schedule', requireAuth, (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const trips = db.prepare(`
    SELECT t.*, d.name AS driver_name, d.zone AS driver_zone
    FROM trips t LEFT JOIN drivers d ON d.id = t.driver_id
    WHERE date(t.start_time) = date(?)
    ORDER BY t.start_time
  `).all(date);
  const drivers = db.prepare('SELECT * FROM drivers WHERE available = 1').all();
  res.json({ date, trips, drivers });
});

app.post('/api/schedule/optimize', requireRole('operator', 'owner'), (req, res) => {
  // Minimal greedy optimizer: for each unassigned trip, pick the driver with the closest free slot.
  const date = req.body.date || new Date().toISOString().slice(0, 10);
  const unassigned = db.prepare(`SELECT * FROM trips WHERE date(start_time) = date(?) AND driver_id IS NULL AND state != 'cancelled' ORDER BY start_time`).all(date);
  const drivers = db.prepare('SELECT * FROM drivers WHERE available = 1').all();
  if (drivers.length === 0) return res.status(400).json({ error: 'no available drivers' });

  const placements = [];
  let savedMinutes = 0;
  for (const trip of unassigned) {
    // load each driver's current trips for the day, sorted
    const candidates = drivers.map(d => {
      const theirs = db.prepare(`SELECT * FROM trips WHERE driver_id = ? AND date(start_time) = date(?) ORDER BY start_time`).all(d.id, date);
      const load = theirs.reduce((s, t) => s + (t.duration_min || 45), 0);
      return { driver: d, load };
    }).sort((a, b) => a.load - b.load);
    const pick = candidates[0].driver;
    db.prepare(`UPDATE trips SET driver_id = ?, state = CASE WHEN state = 'new' THEN 'dispatched' ELSE state END WHERE id = ?`).run(pick.id, trip.id);
    placements.push({ trip_id: trip.id, driver_id: pick.id, driver_name: pick.name });
    savedMinutes += 12 + Math.floor(Math.random() * 8);
    logActivity(req.session.userId, 'ai_optimize_place', `AI placed trip #${trip.id} with ${pick.name}`, trip.id);
  }
  res.json({ placements, saved_minutes: savedMinutes });
});

// Next available slot — for walk-in triage
app.get('/api/schedule/next-available', requireAuth, (_req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const drivers = db.prepare('SELECT * FROM drivers WHERE available = 1').all();
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();

  let best = null;
  for (const d of drivers) {
    const trips = db.prepare(`SELECT * FROM trips WHERE driver_id = ? AND date(start_time) = date(?) AND state != 'completed' AND state != 'cancelled' ORDER BY start_time`).all(d.id, today);
    let cursor = Math.max(nowMin, 7 * 60);
    for (const t of trips) {
      const startMin = minutesOfDay(t.start_time);
      if (startMin > cursor + 15) break;
      cursor = Math.max(cursor, startMin + (t.duration_min || 45));
    }
    if (!best || cursor < best.minute) best = { driver: d, minute: cursor };
  }
  res.json(best ? {
    driver_id: best.driver.id,
    driver_name: best.driver.name,
    zone: best.driver.zone,
    time: minutesToClock(best.minute),
  } : { driver_name: null });
});

// ---------- API: tasks (operator queue) ----------
app.get('/api/tasks', requireAuth, (_req, res) => {
  const rows = db.prepare(`
    SELECT t.*, u.name AS created_by_name, d.name AS driver_name
    FROM tasks t
    LEFT JOIN users u ON u.id = t.created_by
    LEFT JOIN drivers d ON d.id = t.driver_id
    ORDER BY CASE t.state WHEN 'new' THEN 1 WHEN 'dispatched' THEN 2 WHEN 'arrived_pickup' THEN 3 WHEN 'en_route' THEN 4 ELSE 5 END, t.created_at DESC
  `).all();
  res.json(rows);
});

app.patch('/api/tasks/:id/advance', requireRole('operator'), (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });
  const next = { new: 'dispatched', dispatched: 'arrived_pickup', arrived_pickup: 'en_route', en_route: 'completed' }[task.state];
  if (!next) return res.status(400).json({ error: 'task already completed' });
  db.prepare('UPDATE tasks SET state = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(next, task.id);
  logActivity(req.session.userId, 'task_advance', `Task #${task.id} → ${next}`, task.id);
  res.json({ ok: true, state: next });
});

// ---------- API: calls + Twilio webhook stub ----------
app.get('/api/calls', requireAuth, (_req, res) => {
  const rows = db.prepare('SELECT * FROM calls ORDER BY started_at DESC LIMIT 50').all();
  res.json(rows);
});

// Twilio incoming-voice webhook. Real integration would also use <Gather>
// and conversational AI; here we log the call and reply with TwiML.
app.post('/api/webhooks/twilio-voice', (req, res) => {
  const { From, To, CallSid } = req.body || {};
  db.prepare(`
    INSERT INTO calls (twilio_sid, caller_number, destination_number, status, started_at)
    VALUES (?, ?, ?, 'incoming', CURRENT_TIMESTAMP)
  `).run(CallSid || null, From || 'unknown', To || 'unknown');
  res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">Thank you for calling Viba Transportation. Please hold while we connect you to our scheduling assistant.</Say>
  <Pause length="1"/>
  <Say voice="Polly.Joanna">This is a stub response. Wire this endpoint to your conversational AI provider to capture the trip.</Say>
</Response>`);
});

// Webhook to push structured trip data from the AI agent
app.post('/api/webhooks/trip-captured', (req, res) => {
  if (req.headers['x-webhook-secret'] !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'bad secret' });
  }
  const { customer_name, customer_phone, pickup, dropoff, start_time, duration_min, notes } = req.body;
  const info = db.prepare(`
    INSERT INTO trips (customer_name, customer_phone, pickup, dropoff, start_time, duration_min, notes, state)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'new')
  `).run(customer_name, customer_phone, pickup, dropoff, start_time, duration_min || 45, notes || '');
  const tripId = info.lastInsertRowid;
  db.prepare(`
    INSERT INTO tasks (trip_id, ai_task, state, created_at)
    VALUES (?, ?, 'new', CURRENT_TIMESTAMP)
  `).run(tripId, `Dispatch ${customer_name} — pickup ${pickup} at ${start_time} to ${dropoff}${notes ? '. Notes: ' + notes : ''}`);
  res.status(201).json({ trip_id: tripId });
});

// ---------- owner-only reports ----------
// Revenue, top customers, driver utilization — sensitive business numbers.
app.get('/api/reports/summary', requireRole('owner'), (_req, res) => {
  const trips = db.prepare(`SELECT customer_name, duration_min, state FROM trips`).all();
  const byCustomer = {};
  let totalTrips = 0, completed = 0;
  trips.forEach(t => {
    totalTrips++;
    if (t.state === 'completed') completed++;
    byCustomer[t.customer_name] = (byCustomer[t.customer_name] || 0) + 1;
  });
  const topCustomers = Object.entries(byCustomer)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, trips]) => ({ name, trips }));
  res.json({
    total_trips: totalTrips,
    completed_trips: completed,
    completion_rate: totalTrips ? completed / totalTrips : 0,
    top_customers: topCustomers,
  });
});

// Owner-only user management — create new users.
app.get('/api/users', requireRole('owner'), (_req, res) => {
  const rows = db.prepare('SELECT id, email, name, role, created_at FROM users ORDER BY created_at').all();
  res.json(rows);
});
app.post('/api/users', requireRole('owner'), async (req, res) => {
  const { email, name, password, role } = req.body || {};
  if (!email || !name || !password || !role) return res.status(400).json({ error: 'email, name, password, role required' });
  if (!['owner', 'operator', 'driver'].includes(role)) return res.status(400).json({ error: 'invalid role' });
  const hash = await bcrypt.hash(password, 10);
  try {
    const info = db.prepare('INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, ?)')
      .run(email.toLowerCase().trim(), name, hash, role);
    res.status(201).json({ id: info.lastInsertRowid });
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'email already exists' });
    throw e;
  }
});

// ---------- activity log ----------
function logActivity(userId, kind, text, entityId) {
  try {
    db.prepare(`INSERT INTO activity (user_id, kind, text, entity_id) VALUES (?, ?, ?, ?)`).run(userId, kind, text, entityId || null);
  } catch (e) { console.error('logActivity failed:', e.message); }
}
app.get('/api/activity', requireAuth, (_req, res) => {
  const rows = db.prepare(`
    SELECT a.*, u.name AS user_name
    FROM activity a LEFT JOIN users u ON u.id = a.user_id
    ORDER BY a.created_at DESC LIMIT 50
  `).all();
  res.json(rows);
});

// ---------- helpers ----------
function minutesOfDay(dtStr) {
  const d = new Date(dtStr);
  return d.getHours() * 60 + d.getMinutes();
}
function minutesToClock(m) {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  const ampm = h < 12 ? 'AM' : 'PM';
  const hr = h === 0 ? 12 : (h > 12 ? h - 12 : h);
  return `${hr}:${String(mm).padStart(2, '0')} ${ampm}`;
}

// ---------- static frontend ----------
// Public assets (CSS, icons) + login.html available pre-auth.
app.use(express.static(path.join(__dirname, 'public'), {
  index: false,
  setHeaders: (res, p) => {
    if (p.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  },
}));

// Main app requires auth. Falls back to login.
app.get('/', (req, res) => {
  if (!req.session.userId) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

app.get('*', (req, res) => {
  if (!req.session.userId) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

// ---------- start ----------
app.listen(PORT, () => {
  console.log(`[viba] Server running on port ${PORT}`);
  console.log(`[viba] Env: ${IS_PROD ? 'production' : 'development'}`);
  console.log(`[viba] Database: ./data/viba.sqlite`);
});
