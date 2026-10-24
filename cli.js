'use strict';
/* Управление пользователями из командной строки (если забыли пароль администратора).
   node cli.js add-user <логин> <пароль> <admin|staff|viewer> ["Имя"]
   node cli.js set-password <логин> <новый пароль>
   node cli.js list-users */
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'sklad.db'));
db.exec(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, login TEXT UNIQUE NOT NULL, name TEXT NOT NULL DEFAULT '', role TEXT NOT NULL, hash TEXT NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires INTEGER NOT NULL);`);

const hashPassword = (pw) => { const salt = crypto.randomBytes(16).toString('hex'); return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex'); };
const [cmd, a, b, c, d] = process.argv.slice(2);

if (cmd === 'add-user') {
  if (!a || !b || !['admin', 'staff', 'viewer'].includes(c)) { console.log('Использование: node cli.js add-user <логин> <пароль> <admin|staff|viewer> ["Имя"]'); process.exit(1); }
  if (b.length < 8) { console.log('Пароль должен быть не короче 8 символов'); process.exit(1); }
  try {
    db.prepare('INSERT INTO users(login,name,role,hash,created) VALUES (?,?,?,?,?)').run(a.toLowerCase(), d || '', c, hashPassword(b), Date.now());
    console.log('Пользователь создан:', a);
  } catch (e) { console.log('Не удалось создать:', /UNIQUE/.test(e.message) ? 'такой логин уже есть' : e.message); process.exit(1); }
} else if (cmd === 'set-password') {
  if (!a || !b || b.length < 8) { console.log('Использование: node cli.js set-password <логин> <новый пароль не короче 8 символов>'); process.exit(1); }
  const u = db.prepare('SELECT id FROM users WHERE login=?').get(a.toLowerCase());
  if (!u) { console.log('Нет такого пользователя'); process.exit(1); }
  db.prepare('UPDATE users SET hash=? WHERE id=?').run(hashPassword(b), u.id);
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
  console.log('Пароль изменён');
} else if (cmd === 'list-users') {
  db.prepare('SELECT login,name,role FROM users ORDER BY login').all().forEach((u) => console.log(u.login, u.role, u.name));
} else {
  console.log('Команды: add-user, set-password, list-users');
}
