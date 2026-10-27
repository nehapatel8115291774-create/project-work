// Password bhool gaye? Server wale computer par chalao:
//   npm run reset-password -- naya_password
const { db, hashPassword } = require('./db');
const pw = process.argv[2];
if (!pw || pw.length < 6) {
  console.log('Use:  npm run reset-password -- <new password (min 6 chars)>');
  process.exit(1);
}
db.prepare("UPDATE admin_users SET password_hash = ? WHERE username = 'admin'").run(hashPassword(pw));
db.prepare('DELETE FROM sessions').run();
console.log('Done. Ab username "admin" aur naye password se login karo.');
