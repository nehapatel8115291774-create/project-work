# Pro Gym – Management System (v2)

## Chalane ka tareeka
```
node server.js        # http://localhost:3000   (npm install ki zaroorat nahi)
```
Zaroorat: Node.js **v22.13 ya naya** (nodejs.org LTS). `node -v` se check karo.
Purana Node ho to: `npm i better-sqlite3` chala do, wo apne aap use hoga.
Login: `admin` / `admin123`  (Settings me badal lo)
Password bhool gaye:  `npm run reset-password -- naya123`

## Data kahan store hota hai?
Sab kuch **ek file** me:  `data/gym.db`  (SQLite). Alag database server install nahi karna.
Backup = is file ki copy. Naya setup = file ko naye computer ke `data/` folder me rakh do.

| Table      | Kya rakhta hai |
|------------|----------------|
| admin_users| login (password hashed, plain nahi) |
| sessions   | login ke baad ka token (7 din) |
| settings   | gym ka naam, UPI ID |
| plans      | 1/3/6/12 month plans + price |
| members    | naam, phone, plan, join date, **expiry date** |
| payments   | har payment (invoice, amount, mode) — member se linked |
| attendance | kaun, kab aaya |
| staff / equipment / expenses | seedhi tables |

Member ka status (Active / Expiring / Expired) store nahi hota — **expiry date se apne aap nikalta hai**.

## Kaam kaise hota hai
```
Browser (public/*.html, app.js)
   │  fetch('/api/members') + login token
   ▼
server.js (Express) → token check → data check → SQL
   ▼
db.js → data/gym.db
```
- `db.js`     : tables banata hai, pehli baar admin + plans daalta hai
- `server.js` : saari API (login, members, renew, attendance, payments, dashboard)
- `public/`   : login.html, index.html, style.css, app.js
- `migrate.js`: purani `old/gym_database.db` ka data naye DB me laata hai (ho chuka hai)

## Flow
Member add → plan chuno → payment usi time save → expiry automatic.
Renew → expiry aage badhti hai + naya payment. Check-in → expired member block.
