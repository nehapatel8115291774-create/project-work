// ============================================================
//  FRONTEND  -  sab pages is ek file me.
//  Flow:  page render  ->  api('members')  ->  server.js  ->  data/gym.db
// ============================================================

// ---------- helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');
const pad = (n) => String(n).padStart(2, '0');
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const niceDate = (iso) => new Date(iso + 'T00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
const niceTime = (stamp) => { const [h, m] = stamp.slice(11).split(':').map(Number); return `${h % 12 || 12}:${pad(m)} ${h >= 12 ? 'PM' : 'AM'}`; };
const daysFrom = (iso) => Math.round((new Date(iso + 'T00:00') - new Date(todayIso() + 'T00:00')) / 864e5);
const monthName = (ym) => new Date(ym + '-01T00:00').toLocaleDateString('en-IN', { month: 'short' });
const waLink = (phone, text) => `https://wa.me/${phone.length === 10 ? '91' + phone : phone}?text=${encodeURIComponent(text)}`;

const token = localStorage.getItem('gym_token');
if (!token) location.replace('login.html');
let me = { settings: {} };
let charts = [];

async function api(url, method = 'GET', body) {
  const res = await fetch('http://localhost:3000/api/' + url, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { localStorage.removeItem('gym_token'); location.replace('login.html'); throw new Error(data.error); }
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

function toast(msg, type = 'ok') {
  const t = document.createElement('div');
  t.className = 'toast ' + type; t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), 3800);
}

// Ek hi popup form sab jagah (add member, renew, add staff...)
function openForm({ title, fields, submit = 'Save', onSubmit }) {
  const m = $('#modal');
  const input = (f) => f.options
    ? `<select name="${f.name}">${f.options.map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(f.value) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`
    : `<input name="${f.name}" type="${f.type || 'text'}" value="${esc(f.value ?? '')}" placeholder="${esc(f.placeholder || '')}" ${f.required ? 'required' : ''} ${f.type === 'number' ? 'step="any" min="0"' : ''}>`;
  m.innerHTML = `<h3>${esc(title)}</h3><form>
    ${fields.map((f) => `<div class="field"><label>${esc(f.label)}</label>${input(f)}</div>`).join('')}
    <div class="form-actions"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn lime">${esc(submit)}</button></div></form>`;
  const form = $('form', m);
  $('[data-close]', m).onclick = () => m.close();
  form.onsubmit = async (e) => {
    e.preventDefault();
    try { await onSubmit(Object.fromEntries(new FormData(form))); m.close(); }
    catch (err) { toast(err.message, 'err'); }
  };
  m.showModal();
  const first = $('input, select', form); if (first) first.focus();
  return form;
}

function drawChart(id, config) {
  const el = document.getElementById(id);
  if (!el) return;
  if (typeof Chart === 'undefined') { el.parentElement.innerHTML = '<div class="empty">Chart ke liye internet chahiye</div>'; return; }
  charts.push(new Chart(el, config));
}

function applyBrand() {
  const name = me.settings.gym_name || 'Pro Gym';
  const w = name.trim().split(/\s+/);
  $('#brand').innerHTML = w.length > 1 ? `${esc(w.slice(0, -1).join(' '))}<b>${esc(w.at(-1))}</b>` : `<b>${esc(name)}</b>`;
  document.title = name + ' – Management';
}

const emptyBox = (t) => `<div class="empty">${t}</div>`;
const badge = (s) => `<span class="badge ${s}">${s}</span>`;
const expiryText = (iso) => { const d = daysFrom(iso); return d < 0 ? `Expired ${-d} day${d === -1 ? '' : 's'} ago` : d === 0 ? 'Expires today' : `${d} day${d === 1 ? '' : 's'} left`; };

// ---------- shared: quick check-in + renew ----------
function checkinStrip(members) {
  return `<form class="checkin" id="ci"><h3>Quick check-in</h3>
    <input id="ciq" list="ciList" placeholder="Type name, phone or member ID..." autocomplete="off">
    <datalist id="ciList">${members.map((m) => `<option value="${esc(m.name)} · ${esc(m.code)}">`).join('')}</datalist>
    <button class="btn">Check in</button></form>`;
}
function bindCheckin(members, done) {
  $('#ci').onsubmit = async (e) => {
    e.preventDefault();
    const q = $('#ciq').value.trim().toLowerCase();
    if (!q) return;
    let hit = members.find((m) => `${m.name} · ${m.code}`.toLowerCase() === q);
    if (!hit) {
      const f = members.filter((m) => [m.name, m.code, m.phone].some((x) => x.toLowerCase().includes(q)));
      if (f.length !== 1) return toast(f.length ? 'Kai members mile — list me se ek chuno' : 'Member nahi mila', 'err');
      hit = f[0];
    }
    try { await api('attendance', 'POST', { member_id: hit.id }); toast(`${hit.name} checked in ✓`); done(); }
    catch (err) { toast(err.message, 'err'); }
  };
}

async function renewMember(m) {
  const plans = await api('plans');
  const form = openForm({
    title: `Renew · ${m.name}`, submit: 'Save payment',
    fields: [
      { name: 'plan_id', label: 'Plan', value: m.plan_id, options: plans.map((p) => ({ value: p.id, label: `${p.name} — ${money(p.price)}` })) },
      { name: 'amount', label: 'Amount received (₹)', type: 'number', required: true, value: (plans.find((p) => p.id === m.plan_id) || plans[0]).price },
      { name: 'mode', label: 'Payment mode', options: ['Cash', 'UPI', 'Card'].map((v) => ({ value: v, label: v })) },
    ],
    onSubmit: async (d) => { const r = await api(`members/${m.id}/renew`, 'POST', d); toast(`Renewed till ${niceDate(r.expiry_date)}`); route(); },
  });
  form.plan_id.onchange = () => { form.amount.value = plans.find((p) => String(p.id) === form.plan_id.value).price; };
}

const remindText = (m) => `Hi ${m.name}, aapki ${me.settings.gym_name} membership ${m.expiry_date < todayIso() ? 'khatam ho gayi hai' : niceDate(m.expiry_date) + ' ko khatam ho rahi hai'}. Renew karne ke liye gym me aa jaiye 💪`;

// ---------- PAGES ----------
async function dashboard() {
  const [d, members] = await Promise.all([api('dashboard'), api('members')]);
  const profit = d.revenue - d.spent;
  $('#view').innerHTML = `
    <div class="page-head"><div><h1>Dashboard</h1><p>${new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}</p></div>
      <button class="btn lime" data-act="add">+ New member</button></div>
    ${me.usingDefaultPassword ? `<div class="banner"><span>⚠️ Abhi default password (<b>admin123</b>) chal raha hai.</span><a href="#settings">Password badlo →</a></div>` : ''}
    ${checkinStrip(members)}
    <div class="grid g4" style="margin-bottom:16px">
      <div class="card stat"><div class="label">Active members</div><div class="num">${d.members.active}</div><div class="sub">${d.members.total} total · ${d.members.expired} expired</div></div>
      <div class="card stat"><div class="label">Check-ins today</div><div class="num">${d.checkins}</div><div class="sub">${d.members.expiring} plans expiring this week</div></div>
      <div class="card stat"><div class="label">Collected this month</div><div class="num">${money(d.revenue)}</div><div class="sub">Spent ${money(d.spent)}</div></div>
      <div class="card stat hot"><div class="label">Profit this month</div><div class="num">${profit < 0 ? '−' : ''}${money(Math.abs(profit))}</div><div class="sub">Collected − expenses</div></div>
    </div>
    <div class="grid g2" style="margin-bottom:16px">
      <div class="card"><h3>Last 6 months</h3><div class="chart-box"><canvas id="cMonths"></canvas></div></div>
      <div class="card"><h3>Needs renewal</h3>
        ${d.renewals.length ? `<div class="list">${d.renewals.map((m) => `
          <div class="row"><div><div class="who">${esc(m.name)}</div><div class="sub">${expiryText(m.expiry_date)}</div></div>
            <div><a class="btn sm wa" target="_blank" rel="noopener" href="${waLink(m.phone, remindText(m))}">WhatsApp</a>
            <button class="btn sm" data-act="renew" data-id="${m.id}">Renew</button></div></div>`).join('')}</div>`
          : emptyBox('Sab members ka plan chal raha hai 🎉')}
      </div>
    </div>
    <div class="grid g2e">
      <div class="card"><h3>Expenses this month</h3>${d.expenseBreakdown.length ? '<div class="chart-box"><canvas id="cExp"></canvas></div>' : emptyBox('Is mahine koi expense nahi')}</div>
      <div class="card"><h3>Today's check-ins</h3>
        ${d.recent.length ? `<div class="list">${d.recent.map((a) => `<div class="row"><span class="who">${esc(a.member_name)}</span><span class="sub">${niceTime(a.checkin_at)}</span></div>`).join('')}</div>` : emptyBox('Abhi tak koi nahi aaya')}
      </div>
    </div>`;

  bindCheckin(members, dashboard);
  $('#view').onclick = (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    if (b.dataset.act === 'add') addMember();
    if (b.dataset.act === 'renew') renewMember(members.find((m) => String(m.id) === b.dataset.id));
  };

  drawChart('cMonths', {
    type: 'bar',
    data: { labels: d.chart.labels.map(monthName), datasets: [
      { label: 'Collected', data: d.chart.revenue, backgroundColor: '#a3cc1c', borderRadius: 6 },
      { label: 'Expenses', data: d.chart.expenses, backgroundColor: '#16181d', borderRadius: 6 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } }, scales: { y: { beginAtZero: true, ticks: { callback: (v) => '₹' + v } } } },
  });
  if (d.expenseBreakdown.length) drawChart('cExp', {
    type: 'doughnut',
    data: { labels: d.expenseBreakdown.map((e) => e.title), datasets: [{ data: d.expenseBreakdown.map((e) => e.amount), backgroundColor: ['#16181d', '#a3cc1c', '#e0735a', '#5b8def', '#f5a524', '#9aa0ab'], borderWidth: 0 }] },
    options: { responsive: true, maintainAspectRatio: false, cutout: '62%', plugins: { legend: { position: 'right' } } },
  });
}

async function addMember() {
  const plans = await api('plans');
  if (!plans.length) return toast('Pehle Settings me koi plan banao', 'err');
  const form = openForm({
    title: 'New member', submit: 'Add & collect payment',
    fields: [
      { name: 'name', label: 'Full name', required: true },
      { name: 'phone', label: 'Phone (WhatsApp)', type: 'tel', required: true, placeholder: '10 digit number' },
      { name: 'plan_id', label: 'Plan', options: plans.map((p) => ({ value: p.id, label: `${p.name} — ${money(p.price)}` })) },
      { name: 'amount', label: 'Amount received (₹)', type: 'number', required: true, value: plans[0].price },
      { name: 'mode', label: 'Payment mode', options: ['Cash', 'UPI', 'Card'].map((v) => ({ value: v, label: v })) },
    ],
    onSubmit: async (d) => { const m = await api('members', 'POST', d); toast(`${m.name} added · ${m.code}`); route(); },
  });
  form.plan_id.onchange = () => { form.amount.value = plans.find((p) => String(p.id) === form.plan_id.value).price; };
}

async function members() {
  const all = await api('members');
  let filter = 'All', q = '';
  $('#view').innerHTML = `
    <div class="page-head"><div><h1>Members</h1><p>${all.length} total</p></div><button class="btn lime" data-act="add">+ New member</button></div>
    <div class="tools"><input class="search" id="q" placeholder="Search name, phone or ID...">
      <div class="chips">${['All', 'Active', 'Expiring', 'Expired'].map((f) => `<button class="chip ${f === 'All' ? 'on' : ''}" data-f="${f}">${f}</button>`).join('')}</div></div>
    <div class="table-wrap"><table><thead><tr><th>ID</th><th>Name</th><th>Phone</th><th>Plan</th><th>Valid till</th><th>Status</th><th></th></tr></thead><tbody id="rows"></tbody></table></div>`;

  const draw = () => {
    const rows = all.filter((m) => (filter === 'All' || m.status === filter) &&
      [m.name, m.phone, m.code].some((x) => x.toLowerCase().includes(q)));
    $('#rows').innerHTML = rows.length ? rows.map((m) => `<tr>
      <td>${esc(m.code)}</td><td><b>${esc(m.name)}</b></td><td>${esc(m.phone)}</td><td>${esc(m.plan_name || '—')}</td>
      <td>${niceDate(m.expiry_date)}<div class="sub">${expiryText(m.expiry_date)}</div></td><td>${badge(m.status)}</td>
      <td class="actions"><a class="btn sm wa" target="_blank" rel="noopener" href="${waLink(m.phone, remindText(m))}">WhatsApp</a>
        <button class="btn sm ghost" data-act="face" data-id="${m.id}" title="Face scan ke liye chehra register karo">${m.has_face ? '✓ Face' : '+ Face'}</button>
        <button class="btn sm" data-act="renew" data-id="${m.id}">Renew</button>
        <button class="btn sm danger" data-act="del" data-id="${m.id}" title="Delete">✕</button></td></tr>`).join('')
      : `<tr><td colspan="7">${emptyBox('Koi member nahi mila')}</td></tr>`;
  };
  draw();

  $('#q').oninput = (e) => { q = e.target.value.trim().toLowerCase(); draw(); };
  $('#view').onclick = async (e) => {
    const chip = e.target.closest('[data-f]');
    if (chip) { filter = chip.dataset.f; document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === chip)); return draw(); }
    const b = e.target.closest('[data-act]'); if (!b) return;
    const m = all.find((x) => String(x.id) === b.dataset.id);
    if (b.dataset.act === 'add') addMember();
    if (b.dataset.act === 'renew') renewMember(m);
    if (b.dataset.act === 'face') enrollFace(m);
    if (b.dataset.act === 'del' && confirm(`${m.name} ko delete karna hai?\n(Purane bills aur attendance me naam bacha rahega)`)) {
      try { await api('members/' + m.id, 'DELETE'); toast('Member deleted'); route(); } catch (err) { toast(err.message, 'err'); }
    }
  };
}

async function attendance() {
  const [list, mem] = await Promise.all([api('attendance?date=all'), api('members')]);
  const t = todayIso();
  const todayCount = list.filter((a) => a.checkin_at.startsWith(t)).length;
  $('#view').innerHTML = `
    <div class="page-head"><div><h1>Attendance</h1><p>Aaj ${todayCount} log aaye · pichhle 200 entries</p></div></div>
    ${checkinStrip(mem)}
    <div class="table-wrap"><table><thead><tr><th>Member</th><th>ID</th><th>Date</th><th>Time</th><th>How</th></tr></thead><tbody>
      ${list.length ? list.map((a) => `<tr><td><b>${esc(a.member_name)}</b></td><td>${esc(a.code || '—')}</td><td>${a.checkin_at.startsWith(t) ? 'Today' : niceDate(a.checkin_at.slice(0, 10))}</td><td>${niceTime(a.checkin_at)}</td><td>${esc(a.method)}</td></tr>`).join('')
        : `<tr><td colspan="5">${emptyBox('Abhi koi attendance nahi')}</td></tr>`}
    </tbody></table></div>`;
  bindCheckin(mem, attendance);
}

async function payments() {
  const list = await api('payments');
  const month = todayIso().slice(0, 7);
  const monthTotal = list.filter((p) => p.paid_on.startsWith(month)).reduce((s, p) => s + p.amount, 0);
  const upi = me.settings.upi_id || '';
  const qr = (amt) => `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(`upi://pay?pa=${upi}&pn=${me.settings.gym_name}${amt ? '&am=' + amt : ''}&cu=INR`)}`;
  $('#view').innerHTML = `
    <div class="page-head"><div><h1>Payments</h1><p>Is mahine collect hua: <b>${money(monthTotal)}</b></p></div></div>
    <div class="grid g2">
      <div class="table-wrap"><table><thead><tr><th>Invoice</th><th>Member</th><th>Plan</th><th>Amount</th><th>Mode</th><th>Date</th><th></th></tr></thead><tbody>
        ${list.length ? list.map((p) => `<tr><td>${esc(p.invoice)}</td><td><b>${esc(p.member_name)}</b></td><td>${esc(p.plan_name || '—')}</td><td>${money(p.amount)}</td><td>${esc(p.mode)}</td><td>${niceDate(p.paid_on)}</td>
          <td class="actions">${p.phone ? `<a class="btn sm wa" target="_blank" rel="noopener" href="${waLink(p.phone, `Hi ${p.member_name}, ${money(p.amount)} ka payment mil gaya (${p.invoice}). Thank you! – ${me.settings.gym_name}`)}">Receipt</a>` : ''}</td></tr>`).join('')
          : `<tr><td colspan="7">${emptyBox('Abhi koi payment nahi')}</td></tr>`}
      </tbody></table></div>
      <div class="card qr"><h3>Scan &amp; pay (UPI)</h3>
        <img id="qrImg" src="${qr('')}" alt="UPI QR">
        <div class="field" style="margin-top:14px;text-align:left"><label>Amount (optional)</label><input id="qrAmt" type="number" min="0" placeholder="₹"></div>
        <p class="sub" style="color:var(--muted);font-size:13px">UPI ID: <b>${esc(upi)}</b><br>Settings me apna asli UPI ID daalo.</p></div>
    </div>`;
  $('#qrAmt').oninput = (e) => { $('#qrImg').src = qr(e.target.value); };
}

// Staff / Equipment / Expenses ek hi generic page se
function listPage({ title, endpoint, addLabel, fields, cols, summary, emptyMsg }) {
  return async () => {
    const rows = await api(endpoint);
    $('#view').innerHTML = `
      <div class="page-head"><div><h1>${title}</h1><p>${summary(rows)}</p></div><button class="btn lime" data-act="add">+ ${addLabel}</button></div>
      <div class="table-wrap"><table><thead><tr>${cols.map((c) => `<th>${c.h}</th>`).join('')}<th></th></tr></thead><tbody>
        ${rows.length ? rows.map((r) => `<tr>${cols.map((c) => `<td>${c.f(r)}</td>`).join('')}<td class="actions"><button class="btn sm danger" data-act="del" data-id="${r.id}" title="Delete">✕</button></td></tr>`).join('')
          : `<tr><td colspan="${cols.length + 1}">${emptyBox(emptyMsg)}</td></tr>`}
      </tbody></table></div>`;
    $('#view').onclick = async (e) => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      if (b.dataset.act === 'add') openForm({ title: addLabel, fields, onSubmit: async (d) => { await api(endpoint, 'POST', d); toast('Saved ✓'); route(); } });
      if (b.dataset.act === 'del' && confirm('Delete karna hai?')) { await api(`${endpoint}/${b.dataset.id}`, 'DELETE'); toast('Deleted'); route(); }
    };
  };
}

const staff = listPage({
  title: 'Staff', endpoint: 'staff', addLabel: 'Add staff', emptyMsg: 'Koi staff add nahi hua',
  summary: (r) => `${r.length} log · monthly salary ${money(r.reduce((s, x) => s + x.salary, 0))}`,
  fields: [
    { name: 'name', label: 'Name', required: true }, { name: 'role', label: 'Role', placeholder: 'Head trainer' },
    { name: 'phone', label: 'Phone', type: 'tel', required: true }, { name: 'salary', label: 'Monthly salary (₹)', type: 'number', required: true },
  ],
  cols: [{ h: 'Name', f: (r) => `<b>${esc(r.name)}</b>` }, { h: 'Role', f: (r) => esc(r.role) }, { h: 'Phone', f: (r) => esc(r.phone) }, { h: 'Salary', f: (r) => money(r.salary) }],
});

const equipment = listPage({
  title: 'Equipment', endpoint: 'equipment', addLabel: 'Add equipment', emptyMsg: 'Koi equipment add nahi hua',
  summary: (r) => `${r.length} types · ${r.reduce((s, x) => s + x.qty, 0)} items`,
  fields: [
    { name: 'name', label: 'Equipment', required: true }, { name: 'qty', label: 'Quantity', type: 'number', required: true, value: 1 },
    { name: 'condition', label: 'Condition', options: ['Good', 'Needs repair', 'Out of order'].map((v) => ({ value: v, label: v })) },
  ],
  cols: [{ h: 'Equipment', f: (r) => `<b>${esc(r.name)}</b>` }, { h: 'Qty', f: (r) => r.qty },
    { h: 'Condition', f: (r) => `<span class="badge ${r.condition === 'Good' ? 'Active' : r.condition === 'Needs repair' ? 'Expiring' : 'Expired'}">${esc(r.condition)}</span>` }],
});

const expenses = listPage({
  title: 'Expenses', endpoint: 'expenses', addLabel: 'Add expense', emptyMsg: 'Koi expense add nahi hua',
  summary: (r) => `Is mahine: ${money(r.filter((x) => x.spent_on.startsWith(todayIso().slice(0, 7))).reduce((s, x) => s + x.amount, 0))}`,
  fields: [
    { name: 'title', label: 'Reason', required: true, placeholder: 'Rent, electricity, repair...' },
    { name: 'amount', label: 'Amount (₹)', type: 'number', required: true },
    { name: 'spent_on', label: 'Date', type: 'date', value: todayIso() },
  ],
  cols: [{ h: 'Reason', f: (r) => `<b>${esc(r.title)}</b>` }, { h: 'Amount', f: (r) => money(r.amount) }, { h: 'Date', f: (r) => niceDate(r.spent_on) }],
});


// ---------- FACE SCAN ----------
// face-api.js browser me chehre ke 128 numbers nikalta hai. Photo save nahi hoti, sirf numbers (DB: members.face_descriptor).
let faceReady = null;
function loadFace() {
  if (!faceReady) faceReady = new Promise((ok, no) => {
    const sc = document.createElement('script');
    sc.src = 'vendor/face-api.js';
    sc.onload = async () => {
      try {
        await Promise.all([faceapi.nets.tinyFaceDetector, faceapi.nets.faceLandmark68Net, faceapi.nets.faceRecognitionNet].map((n) => n.loadFromUri('vendor/models')));
        ok();
      } catch (e) { no(e); }
    };
    sc.onerror = () => no(new Error('Face library load nahi hui'));
    document.head.appendChild(sc);
  }).catch((e) => { faceReady = null; throw e; });
  return faceReady;
}
const detectFace = (video) => faceapi.detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 })).withFaceLandmarks().withFaceDescriptor();
const openCamera = async () => {
  if (!navigator.mediaDevices) throw new Error('Camera ke liye http://localhost ya https chahiye');
  return navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
};

async function enrollFace(m) {
  const modal = $('#modal');
  modal.innerHTML = `<h3>Face · ${esc(m.name)}</h3>
    <video id="fv" class="vid" autoplay playsinline muted></video>
    <p id="fs" class="vid-status">Camera aur model load ho raha hai...</p>
    <div class="form-actions"><button type="button" class="btn ghost" data-close>Cancel</button>
      ${m.has_face ? '<button type="button" class="btn danger" id="frm">Face hatao</button>' : ''}
      <button type="button" class="btn lime" id="fgo" disabled>Capture face</button></div>`;
  let stream;
  const stop = () => stream && stream.getTracks().forEach((t) => t.stop());
  modal.addEventListener('close', stop, { once: true });
  $('[data-close]', modal).onclick = () => modal.close();
  if ($('#frm')) $('#frm').onclick = async () => { await api(`members/${m.id}/face`, 'DELETE'); toast('Face hata diya'); modal.close(); route(); };
  modal.showModal();
  const st = $('#fs');
  try {
    [stream] = await Promise.all([openCamera(), loadFace()]);
    $('#fv').srcObject = stream;
    st.textContent = 'Seedha camera me dekho, phir "Capture face" dabao.';
    $('#fgo').disabled = false;
  } catch (e) { st.textContent = e.message || 'Camera allow nahi hua'; return; }

  $('#fgo').onclick = async () => {
    $('#fgo').disabled = true;
    const samples = [];
    for (let i = 0; i < 3; i++) {                       // 3 photo ka average = zyada accurate
      st.textContent = `Capturing ${i + 1}/3 ... hilna mat`;
      const det = await detectFace($('#fv'));
      if (!det) { st.textContent = 'Chehra nahi dikha. Roshni me, seedha dekho aur dobara try karo.'; $('#fgo').disabled = false; return; }
      samples.push(det.descriptor);
      await new Promise((r) => setTimeout(r, 350));
    }
    const avg = Array.from(samples[0], (_, k) => samples.reduce((s, d) => s + d[k], 0) / samples.length);
    try { await api(`members/${m.id}/face`, 'POST', { descriptor: avg }); toast(`${m.name} ka face save ho gaya ✓`); modal.close(); route(); }
    catch (e) { st.textContent = e.message; $('#fgo').disabled = false; }
  };
}

async function facescan() {
  $('#view').innerHTML = `
    <div class="page-head"><div><h1>Face Scan</h1><p>Camera ke saamne aao, attendance apne aap lag jayegi</p></div></div>
    <div class="grid g2">
      <div class="card" style="text-align:center">
        <video id="fv" class="vid" autoplay playsinline muted style="display:none"></video>
        <div id="fbig" class="face-big">Start dabao</div>
        <button class="btn lime" id="ftoggle">Start face scan</button>
      </div>
      <div class="card"><h3>Abhi pehchane gaye</h3><div id="flog" class="list">${emptyBox('Abhi koi nahi')}</div>
        <p class="sub" id="fcount" style="color:var(--muted);font-size:13px;margin-top:12px"></p></div>
    </div>`;
  const big = $('#fbig'), log = [];
  const say = (t, cls = '') => { big.textContent = t; big.className = 'face-big ' + cls; };
  $('#ftoggle').onclick = async () => {
    if (cam) { stopCounter(); $('#fv').style.display = 'none'; say('Start dabao'); $('#ftoggle').textContent = 'Start face scan'; return; }
    say('Loading...');
    try {
      const [stream, faces] = await Promise.all([openCamera(), api('faces'), loadFace()]);
      $('#fcount').textContent = `${faces.length} member ka face registered hai`;
      if (!faces.length) { stream.getTracks().forEach((t) => t.stop()); return say('Pehle Members page se kisi ka "+ Face" register karo', 'bad'); }
      const matcher = new faceapi.FaceMatcher(faces.map((f) => new faceapi.LabeledFaceDescriptors(String(f.id), [new Float32Array(f.descriptor)])), 0.5);
      const vid = $('#fv'); vid.srcObject = stream; vid.style.display = 'block';
      const cooldown = {}; let busy = false;
      cam = { stream, timer: setInterval(async () => {
        if (busy) return; busy = true;
        try {
          const det = await detectFace(vid);
          if (!det) return say('Chehra dikhao...');
          const best = matcher.findBestMatch(det.descriptor);
          if (best.label === 'unknown') return say('Pehchaan nahi hui', 'bad');
          const f = faces.find((x) => String(x.id) === best.label);
          if (cooldown[f.id] > Date.now()) return;
          cooldown[f.id] = Date.now() + 8000;
          try {
            await api('attendance', 'POST', { member_id: f.id, method: 'Face Scan' });
            say(`✓ ${f.name}`, 'good'); toast(`${f.name} checked in ✓`);
            log.unshift(`<div class="row"><span class="who">${esc(f.name)}</span><span class="sub">${niceTime(todayIso() + ' ' + new Date().toTimeString().slice(0, 5))}</span></div>`);
            $('#flog').innerHTML = log.join('');
          } catch (err) { say(err.message, 'bad'); }
        } finally { busy = false; }
      }, 700) };
      say('Chehra dikhao...');
      $('#ftoggle').textContent = 'Stop';
    } catch (e) { say(e.message || 'Camera allow nahi hua', 'bad'); }
  };
}

// Rep counter: camera frame me hilchal (motion) gin-ta hai. Demo feature.
let cam = null;
function stopCounter() { if (cam) { clearInterval(cam.timer); cam.stream.getTracks().forEach((t) => t.stop()); cam = null; } }

async function counter() {
  $('#view').innerHTML = `
    <div class="page-head"><div><h1>Rep Counter</h1><p>Camera ke saamne push-up / squat karo — har rep ginta hai (motion based demo)</p></div></div>
    <div class="card rep"><div class="big" id="reps">0</div>
      <video id="vid" autoplay playsinline muted></video><br>
      <div class="tools" style="justify-content:center">
        <select class="search" id="sens" style="flex:0 0 auto;min-width:0"><option value="16">Low sensitivity</option><option value="10" selected>Medium sensitivity</option><option value="6">High sensitivity</option></select>
        <button class="btn lime" id="toggle">Start camera</button><button class="btn ghost" id="reset">Reset</button></div></div>`;
  let reps = 0;
  const show = () => { $('#reps').textContent = reps; };
  $('#reset').onclick = () => { reps = 0; show(); };
  $('#toggle').onclick = async () => {
    if (cam) { stopCounter(); $('#vid').style.display = 'none'; $('#toggle').textContent = 'Start camera'; return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      const vid = $('#vid'); vid.srcObject = stream; vid.style.display = 'block';
      const cv = document.createElement('canvas'); cv.width = 64; cv.height = 48;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      let prev = null, moving = false, last = 0;
      cam = { stream, timer: setInterval(() => {
        ctx.drawImage(vid, 0, 0, 64, 48);
        const px = ctx.getImageData(0, 0, 64, 48).data;
        if (prev) {
          let diff = 0; for (let i = 0; i < px.length; i += 4) diff += Math.abs(px[i] - prev[i]);
          diff /= px.length / 4;
          const hi = Number($('#sens').value);
          if (!moving && diff > hi) moving = true;
          else if (moving && diff < hi / 2) { moving = false; if (Date.now() - last > 600) { last = Date.now(); reps++; show(); } }
        }
        prev = px.slice();
      }, 100) };
      $('#toggle').textContent = 'Stop camera';
    } catch { toast('Camera allow nahi hua', 'err'); }
  };
}

async function settings() {
  const plans = await api('plans');
  $('#view').innerHTML = `
    <div class="page-head"><div><h1>Settings</h1></div></div>
    <div class="grid g2e" style="margin-bottom:16px">
      <div class="card"><h3>Gym details</h3><form id="fGym">
        <div class="field"><label>Gym name</label><input name="gym_name" value="${esc(me.settings.gym_name)}" required></div>
        <div class="field"><label>UPI ID (QR code ke liye)</label><input name="upi_id" value="${esc(me.settings.upi_id)}" placeholder="name@bank"></div>
        <button class="btn">Save</button></form></div>
      <div class="card"><h3>Change password</h3><form id="fPw">
        <div class="field"><label>Current password</label><input name="old_password" type="password" required></div>
        <div class="field"><label>New password (min 6)</label><input name="new_password" type="password" minlength="6" required></div>
        <button class="btn">Update password</button></form></div>
    </div>
    <div class="card"><h3>Membership plans</h3>
      <div class="list">${plans.map((p) => `<div class="row"><div><span class="who">${esc(p.name)}</span> <span class="sub">· ${p.months} month${p.months > 1 ? 's' : ''}</span></div>
        <div>${money(p.price)} <button class="btn sm danger" data-del="${p.id}">✕</button></div></div>`).join('')}</div>
      <form id="fPlan" class="inline-form" style="margin-top:16px">
        <div class="field"><label>Plan name</label><input name="name" placeholder="2 Months" required></div>
        <div class="field"><label>Months</label><input name="months" type="number" min="1" required></div>
        <div class="field"><label>Price (₹)</label><input name="price" type="number" min="0" required></div>
        <button class="btn lime">Add plan</button></form></div>`;

  const send = (id, fn) => { $(id).onsubmit = async (e) => { e.preventDefault(); try { await fn(Object.fromEntries(new FormData(e.target))); } catch (err) { toast(err.message, 'err'); } }; };
  send('#fGym', async (d) => { await api('settings', 'PUT', d); me.settings = { ...me.settings, ...d }; applyBrand(); toast('Saved ✓'); });
  send('#fPw', async (d) => { await api('change-password', 'POST', d); me.usingDefaultPassword = false; toast('Password badal gaya ✓'); e_reset('#fPw'); });
  send('#fPlan', async (d) => { await api('plans', 'POST', d); toast('Plan added'); route(); });
  $('#view').onclick = async (e) => {
    const b = e.target.closest('[data-del]'); if (!b) return;
    await api('plans/' + b.dataset.del, 'DELETE'); toast('Plan hata diya'); route();
  };
}
const e_reset = (sel) => $(sel).reset();

// ---------- router ----------
const pages = { dashboard, members, attendance, facescan, payments, expenses, staff, equipment, counter, settings };
async function route() {
  const name = (location.hash || '#dashboard').slice(1);
  const page = pages[name] || dashboard;
  stopCounter();
  charts.forEach((c) => c.destroy()); charts = [];
  $('#view').onclick = null;
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.p === name));
  try { await page(); }
  catch (err) { $('#view').innerHTML = `<div class="card empty">${esc(err.message)}</div>`; }
}

$('#logout').onclick = async () => { try { await api('logout', 'POST'); } catch {} localStorage.removeItem('gym_token'); location.replace('login.html'); };
window.addEventListener('hashchange', route);
(async () => { me = await api('me'); applyBrand(); route(); })();
