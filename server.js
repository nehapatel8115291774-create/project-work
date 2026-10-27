// ============================================================
//  BACKEND  -  Express server
//  Browser (frontend)  --/api/...-->  server.js  --SQL-->  data/gym.db
// ============================================================
const path = require('path');
const cors = require('cors');
const crypto = require('crypto');
const express = require('express');
const { db, DB_FILE, today, addDays, addMonths, nowStamp, hashPassword, verifyPassword } = require('./db');

const PORT = process.env.PORT || 3000;
const app = express();
app.use(cors({
  origin: 'http://127.0.0.1:5500'
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- tiny validation helpers ----------
const fail = (msg, status = 400) => { const e = new Error(msg); e.status = status; throw e; };
const str = (v, label, { required = false, max = 100 } = {}) => {
  v = String(v ?? '').trim();
  if (required && !v) fail(`${label} is required`);
  return v.slice(0, max);
};
const num = (v, label, { min = 0, required = true } = {}) => {
  if (v === '' || v == null) { if (required) fail(`${label} is required`); return null; }
  const n = Number(v);
  if (!Number.isFinite(n) || n < min) fail(`${label} must be a number (min ${min})`);
  return n;
};
const phoneOf = (v) => {
  v = String(v ?? '').replace(/\D/g, '');
  if (v.length < 10 || v.length > 13) fail('Phone number must be at least 10 digits');
  return v;
};
const oneOf = (v, list, label) => { if (!list.includes(v)) fail(`${label} is invalid`); return v; };
const MODES = ['Cash', 'UPI', 'Card'];

// ---------- AUTH ----------
const attempts = new Map(); // brute-force protection: 5 wrong tries = 1 min lock

app.post('/api/login', (req, res) => {
  const a = attempts.get(req.ip) || { n: 0, until: 0 };
  if (a.until > Date.now()) fail('Too many wrong attempts. Wait 1 minute.', 429);

  const user = db.prepare('SELECT * FROM admin_users WHERE username = ?').get(str(req.body.username, 'Username'));
  if (!user || !verifyPassword(String(req.body.password || ''), user.password_hash)) {
    if (++a.n >= 5) { a.until = Date.now() + 60000; a.n = 0; }
    attempts.set(req.ip, a);
    fail('Wrong username or password', 401);
  }
  attempts.delete(req.ip);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .run(token, user.id, Date.now() + 7 * 24 * 3600 * 1000);
  res.json({ token });
});

// Har /api route (login ko chhod ke) ke liye token zaroori
app.use('/api', (req, res, next) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const s = db.prepare(`SELECT s.token, u.id, u.username, u.password_hash FROM sessions s
                        JOIN admin_users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?`).get(token, Date.now());
  if (!s) fail('Please login again', 401);
  req.user = s; req.token = token;
  next();
});

app.get('/api/me', (req, res) => {
  const settings = Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value]));
  res.json({
    username: req.user.username,
    usingDefaultPassword: verifyPassword('admin123', req.user.password_hash),
    settings,
  });
});

app.post('/api/logout', (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(req.token);
  res.json({ ok: true });
});

app.post('/api/change-password', (req, res) => {
  if (!verifyPassword(String(req.body.old_password || ''), req.user.password_hash)) fail('Current password is wrong');
  const pw = String(req.body.new_password || '');
  if (pw.length < 6) fail('New password must be at least 6 characters');
  db.prepare('UPDATE admin_users SET password_hash = ? WHERE id = ?').run(hashPassword(pw), req.user.id);
  res.json({ ok: true });
});

// ---------- SETTINGS & PLANS ----------
app.put('/api/settings', (req, res) => {
  const up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  up.run('gym_name', str(req.body.gym_name, 'Gym name', { required: true, max: 40 }));
  up.run('upi_id', str(req.body.upi_id, 'UPI ID', { max: 60 }));
  res.json({ ok: true });
});

app.get('/api/plans', (req, res) => res.json(db.prepare('SELECT * FROM plans WHERE active = 1 ORDER BY months').all()));
app.post('/api/plans', (req, res) => {
  const r = db.prepare('INSERT INTO plans (name, months, price) VALUES (?, ?, ?)').run(
    str(req.body.name, 'Plan name', { required: true, max: 40 }),
    Math.round(num(req.body.months, 'Months', { min: 1 })),
    num(req.body.price, 'Price'));
  res.json({ id: r.lastInsertRowid });
});
app.delete('/api/plans/:id', (req, res) => {           // soft delete: purane members/bills me naam bacha rahe
  db.prepare('UPDATE plans SET active = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- MEMBERS ----------
const STATUS_SQL = `CASE WHEN m.expiry_date < @today THEN 'Expired'
                         WHEN m.expiry_date <= @soon  THEN 'Expiring' ELSE 'Active' END`;
const MEMBER_SELECT = `SELECT m.id, m.code, m.name, m.phone, m.email, m.plan_id, m.join_date, m.expiry_date,
                              (m.face_descriptor IS NOT NULL) AS has_face, p.name AS plan_name, ${STATUS_SQL} AS status
                       FROM members m LEFT JOIN plans p ON p.id = m.plan_id`;
const dates = () => ({ today: today(), soon: addDays(today(), 7) });

function getPlan(id) {
  const p = db.prepare('SELECT * FROM plans WHERE id = ? AND active = 1').get(id);
  if (!p) fail('Please choose a valid plan');
  return p;
}
function recordPayment(memberId, memberName, plan, amount, mode, date) {
  const id = db.prepare('INSERT INTO payments (invoice, member_id, member_name, plan_name, amount, mode, paid_on) VALUES (?,?,?,?,?,?,?)')
    .run('tmp' + crypto.randomBytes(4).toString('hex'), memberId, memberName, plan.name, amount, mode, date).lastInsertRowid;
  db.prepare('UPDATE payments SET invoice = ? WHERE id = ?').run('INV-' + String(id).padStart(4, '0'), id);
}

app.get('/api/members', (req, res) => {
  res.json(db.prepare(`${MEMBER_SELECT} ORDER BY m.id DESC`).all(dates()));
});

app.post('/api/members', (req, res) => {
  const name = str(req.body.name, 'Name', { required: true });
  const phone = phoneOf(req.body.phone);
  const email = str(req.body.email, 'Email');
  const plan = getPlan(req.body.plan_id);
  const amount = num(req.body.amount ?? plan.price, 'Amount');
  const mode = oneOf(req.body.mode || 'Cash', MODES, 'Payment mode');
  const t = today();

  const id = db.transaction(() => {                    // member + pehla payment ek saath, ya dono nahi
    const mid = db.prepare('INSERT INTO members (code, name, phone, email, plan_id, join_date, expiry_date) VALUES (?,?,?,?,?,?,?)')
      .run('tmp' + crypto.randomBytes(4).toString('hex'), name, phone, email, plan.id, t, addMonths(t, plan.months)).lastInsertRowid;
    db.prepare('UPDATE members SET code = ? WHERE id = ?').run('GYM-' + (1000 + Number(mid)), mid);
    recordPayment(mid, name, plan, amount, mode, t);
    return mid;
  })();
  res.json(db.prepare(`${MEMBER_SELECT} WHERE m.id = @id`).get({ ...dates(), id }));
});

app.post('/api/members/:id/renew', (req, res) => {
  const m = db.prepare('SELECT * FROM members WHERE id = ?').get(req.params.id);
  if (!m) fail('Member not found', 404);
  const plan = getPlan(req.body.plan_id || m.plan_id);
  const amount = num(req.body.amount ?? plan.price, 'Amount');
  const mode = oneOf(req.body.mode || 'Cash', MODES, 'Payment mode');
  const t = today();
  const start = m.expiry_date > t ? m.expiry_date : t;   // abhi active hai to expiry se aage badhao
  const expiry = addMonths(start, plan.months);
  db.transaction(() => {
    db.prepare('UPDATE members SET plan_id = ?, expiry_date = ? WHERE id = ?').run(plan.id, expiry, m.id);
    recordPayment(m.id, m.name, plan, amount, mode, t);
  })();
  res.json({ expiry_date: expiry });
});

app.delete('/api/members/:id', (req, res) => {
  db.prepare('DELETE FROM members WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- FACE SCAN ----------
// Browser chehre se 128 numbers nikalta hai (face-api.js). Server sirf woh numbers save/return karta hai.
app.get('/api/faces', (req, res) => {
  res.json(db.prepare('SELECT id, name, code, face_descriptor FROM members WHERE face_descriptor IS NOT NULL').all()
    .map((r) => ({ id: r.id, name: r.name, code: r.code, descriptor: JSON.parse(r.face_descriptor) })));
});
app.post('/api/members/:id/face', (req, res) => {
  const d = req.body.descriptor;
  if (!Array.isArray(d) || d.length !== 128 || d.some((x) => typeof x !== 'number')) fail('Face data sahi nahi hai, dobara try karo');
  const r = db.prepare('UPDATE members SET face_descriptor = ? WHERE id = ?').run(JSON.stringify(d), req.params.id);
  if (!r.changes) fail('Member not found', 404);
  res.json({ ok: true });
});
app.delete('/api/members/:id/face', (req, res) => {
  db.prepare('UPDATE members SET face_descriptor = NULL WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- PAYMENTS ----------
app.get('/api/payments', (req, res) => {
  res.json(db.prepare(`SELECT p.*, m.phone FROM payments p LEFT JOIN members m ON m.id = p.member_id
                       ORDER BY p.id DESC LIMIT 300`).all());
});

// ---------- ATTENDANCE ----------
app.get('/api/attendance', (req, res) => {
  const date = req.query.date === 'all' ? null : (req.query.date || today());
  const rows = date
    ? db.prepare(`SELECT a.*, m.code FROM attendance a LEFT JOIN members m ON m.id = a.member_id
                  WHERE substr(a.checkin_at,1,10) = ? ORDER BY a.id DESC`).all(date)
    : db.prepare(`SELECT a.*, m.code FROM attendance a LEFT JOIN members m ON m.id = a.member_id
                  ORDER BY a.id DESC LIMIT 200`).all();
  res.json(rows);
});

app.post('/api/attendance', (req, res) => {
  const m = db.prepare('SELECT * FROM members WHERE id = ?').get(req.body.member_id);
  if (!m) fail('Member not found', 404);
  if (m.expiry_date < today()) fail(`${m.name}'s membership expired on ${m.expiry_date}. Please renew first.`);
  const dup = db.prepare('SELECT 1 FROM attendance WHERE member_id = ? AND substr(checkin_at,1,10) = ?').get(m.id, today());
  if (dup) fail(`${m.name} is already checked in today`);
  db.prepare('INSERT INTO attendance (member_id, member_name, method, checkin_at) VALUES (?,?,?,?)')
    .run(m.id, m.name, req.body.method === 'Face Scan' ? 'Face Scan' : 'Manual', nowStamp());
  res.json({ ok: true, name: m.name });
});

// ---------- STAFF / EQUIPMENT / EXPENSES  (same simple pattern) ----------
function crud(route, table, order, build) {
  app.get(`/api/${route}`, (req, res) => res.json(db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all()));
  app.post(`/api/${route}`, (req, res) => {
    const row = build(req.body);                       // validate + clean
    const cols = Object.keys(row);
    const r = db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...Object.values(row));
    res.json({ id: r.lastInsertRowid });
  });
  app.delete(`/api/${route}/:id`, (req, res) => {
    db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(req.params.id);
    res.json({ ok: true });
  });
}
crud('staff', 'staff', 'id DESC', (b) => ({
  name: str(b.name, 'Name', { required: true }), role: str(b.role, 'Role'),
  phone: phoneOf(b.phone), salary: num(b.salary, 'Salary'),
}));
crud('equipment', 'equipment', 'id DESC', (b) => ({
  name: str(b.name, 'Equipment name', { required: true }),
  qty: Math.round(num(b.qty, 'Quantity', { min: 1 })), condition: str(b.condition, 'Condition') || 'Good',
}));
crud('expenses', 'expenses', 'spent_on DESC, id DESC', (b) => ({
  title: str(b.title, 'Reason', { required: true }), amount: num(b.amount, 'Amount', { min: 1 }),
  spent_on: /^\d{4}-\d{2}-\d{2}$/.test(b.spent_on || '') ? b.spent_on : today(),
}));

// ---------- DASHBOARD (ek hi call me sab kuch) ----------
app.get('/api/dashboard', (req, res) => {
  const d = dates();
  const month = d.today.slice(0, 7);
  const one = (sql, p = {}) => db.prepare(sql).get(p);

  const members = one(`SELECT COUNT(*) total,
      SUM(expiry_date >= @today) active,
      SUM(expiry_date BETWEEN @today AND @soon) expiring,
      SUM(expiry_date < @today) expired FROM members`, d);
  const revenue = one(`SELECT COALESCE(SUM(amount),0) v FROM payments WHERE substr(paid_on,1,7) = ?`, [month]).v;
  const spent = one(`SELECT COALESCE(SUM(amount),0) v FROM expenses WHERE substr(spent_on,1,7) = ?`, [month]).v;
  const checkins = one(`SELECT COUNT(*) v FROM attendance WHERE substr(checkin_at,1,10) = ?`, [d.today]).v;

  // last 6 months revenue vs expense
  const months = [];
  const [y, m] = d.today.split('-').map(Number);
  for (let i = 5; i >= 0; i--) {
    const dt = new Date(y, m - 1 - i, 1);
    months.push(`${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`);
  }
  const revBy = Object.fromEntries(db.prepare(`SELECT substr(paid_on,1,7) k, SUM(amount) v FROM payments GROUP BY k`).all().map((r) => [r.k, r.v]));
  const expBy = Object.fromEntries(db.prepare(`SELECT substr(spent_on,1,7) k, SUM(amount) v FROM expenses GROUP BY k`).all().map((r) => [r.k, r.v]));

  res.json({
    members: { total: members.total || 0, active: members.active || 0, expiring: members.expiring || 0, expired: members.expired || 0 },
    revenue, spent, checkins,
    staff: one('SELECT COUNT(*) v FROM staff').v,
    equipment: one('SELECT COALESCE(SUM(qty),0) v FROM equipment').v,
    renewals: db.prepare(`${MEMBER_SELECT} WHERE m.expiry_date <= @soon AND m.expiry_date >= date(@today, '-30 day')
                          ORDER BY m.expiry_date LIMIT 8`).all(d),
    recent: db.prepare(`SELECT member_name, checkin_at FROM attendance WHERE substr(checkin_at,1,10) = ? ORDER BY id DESC LIMIT 6`).all(d.today),
    chart: { labels: months, revenue: months.map((k) => revBy[k] || 0), expenses: months.map((k) => expBy[k] || 0) },
    expenseBreakdown: db.prepare(`SELECT title, SUM(amount) amount FROM expenses WHERE substr(spent_on,1,7) = ?
                                  GROUP BY title ORDER BY amount DESC LIMIT 6`).all(month),
  });
});

// ---------- errors ----------
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Something went wrong on the server' });
});

app.listen(PORT, () => {
  console.log(`\n  Gym app chal gaya:  http://localhost:${PORT}`);
  console.log(`  Database file:      ${DB_FILE}\n`);
});
