// Purani gym_database.db ka data naye data/gym.db me laata hai (ek baar chalao):
//   npm run migrate -- ./gym_database.db
const fs = require('fs');
const { db, openDb, today, addMonths, hashPassword } = require('./db');

const src = process.argv[2] || './gym_database.db';
if (!fs.existsSync(src)) { console.log(`Old DB nahi mili: ${src}`); process.exit(1); }
if (db.prepare('SELECT COUNT(*) c FROM members').get().c > 0 && !process.argv.includes('--force')) {
  console.log('Naye DB me pehle se members hain. Dobara import se duplicate banenge. (zabardasti: --force)');
  process.exit(1);
}

const old = openDb(src, { readonly: true });
const has = (t) => !!old.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
const all = (t) => (has(t) ? old.prepare(`SELECT * FROM ${t}`).all() : []);
const clean = (s) => String(s ?? '').trim();
const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

// '17/10/2026' (dd/mm/yyyy)  ->  2026-10-17
const dmy = (s) => { const m = clean(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m ? iso(m[3], m[2], m[1]) : today(); };
// '10/22/2026, 6:56:16 PM' (mm/dd/yyyy, 12-hour) -> 2026-10-22 18:56
const mdyTime = (s) => {
  const m = clean(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s*(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?/i);
  if (!m) return `${today()} 00:00`;
  let h = Number(m[4]) % 12; if ((m[6] || '').toUpperCase() === 'PM') h += 12;
  return `${iso(m[3], m[1], m[2])} ${String(h).padStart(2, '0')}:${m[5]}`;
};

const planByMonths = (n) => db.prepare('SELECT * FROM plans WHERE months = ? AND active = 1').get(n);
const count = {};

db.transaction(() => {
  // admin password (plain -> hashed)
  const adm = all('admin')[0];
  if (adm && adm.password) {
    db.prepare("UPDATE admin_users SET password_hash = ? WHERE username = 'admin'").run(hashPassword(adm.password));
  }

  // members  (join date purani DB me tha hi nahi -> aaj ki date se expiry set hoti hai)
  const insM = db.prepare('INSERT INTO members (code, name, phone, plan_id, join_date, expiry_date) VALUES (?,?,?,?,?,?)');
  const nameToId = new Map();
  count.members = 0;
  for (const m of all('members')) {
    const months = /year/i.test(m.plan) ? 12 : 1;
    const plan = planByMonths(months);
    let code = clean(m.member_id) || 'GYM-' + (1000 + m.id);
    if (db.prepare('SELECT 1 FROM members WHERE code = ?').get(code)) code += '-' + m.id;
    const id = insM.run(code, clean(m.fullname), clean(m.phone).replace(/\D/g, ''), plan?.id ?? null, today(), addMonths(today(), months)).lastInsertRowid;
    nameToId.set(clean(m.fullname).toLowerCase(), id);
    count.members++;
  }

  // payments (naam se member dhoondh ke jodta hai, na mile to bina link ke rakhta hai)
  const insP = db.prepare('INSERT INTO payments (invoice, member_id, member_name, plan_name, amount, mode, paid_on) VALUES (?,?,?,?,?,?,?)');
  count.payments = 0;
  for (const p of all('payments')) {
    const id = insP.run('tmp' + p.id, nameToId.get(clean(p.member_name).toLowerCase()) ?? null, clean(p.member_name),
      clean(p.plan), Number(p.amount) || 0, clean(p.payment_mode) || 'Cash', dmy(p.timestamp)).lastInsertRowid;
    db.prepare('UPDATE payments SET invoice = ? WHERE id = ?').run('INV-' + String(id).padStart(4, '0'), id);
    count.payments++;
  }

  // staff (bilkul same dobara-dobara wali rows ek hi baar)
  const seen = new Set();
  const insS = db.prepare('INSERT INTO staff (name, role, phone, salary) VALUES (?,?,?,?)');
  count.staff = 0;
  for (const s of all('staff')) {
    const key = [s.name, s.role, s.phone, s.salary].join('|').toLowerCase();
    if (seen.has(key)) continue; seen.add(key);
    insS.run(clean(s.name), clean(s.role), clean(s.phone).replace(/\D/g, ''), Number(s.salary) || 0);
    count.staff++;
  }

  const insE = db.prepare('INSERT INTO equipment (name, qty, condition) VALUES (?,?,?)');
  count.equipment = 0;
  for (const e of all('equipment')) { insE.run(clean(e.name), Number(e.qty) || 1, clean(e.condition_status) || 'Good'); count.equipment++; }

  const insX = db.prepare('INSERT INTO expenses (title, amount, spent_on) VALUES (?,?,?)');
  count.expenses = 0;
  for (const x of all('expenses')) { insX.run(clean(x.title), Number(x.amount) || 0, dmy(x.date)); count.expenses++; }

  const insA = db.prepare('INSERT INTO attendance (member_id, member_name, method, checkin_at) VALUES (?,?,?,?)');
  count.attendance = 0;
  for (const a of all('attendance')) {
    insA.run(nameToId.get(clean(a.member_name).toLowerCase()) ?? null, clean(a.member_name), clean(a.method) || 'Manual', mdyTime(a.timestamp));
    count.attendance++;
  }
})();

console.log('Import ho gaya:', count);
