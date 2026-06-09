const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');

const USERS_FILE = path.join(__dirname, 'users.json');
const SESSIONS_FILE = path.join(__dirname, '.sessions.json');

const PORT = process.env.PORT || 9090;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

let users = {};
try { users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')) } catch (_) {}

let sessions = {};
try { sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')) } catch (_) {}

function saveSessions() {
  try { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions)) } catch (_) {}
}

function saveUsers() {
  try { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)) } catch (_) {}
}

function parseCookies(req) {
  const c = {};
  (req.headers.cookie || '').split(';').forEach(s => {
    const m = s.trim().match(/^([^=]+)=(.*)$/);
    if (m) c[m[1]] = m[2];
  });
  return c;
}

function getSession(req) {
  const fromCookie = parseCookies(req).session;
  if (fromCookie && sessions[fromCookie]) return sessions[fromCookie];
  const auth = req.headers.authorization || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m && sessions[m[1]]) return sessions[m[1]];
  return null;
}

function dataFileForUser(username) {
  return path.join(__dirname, `data_${username}.json`);
}

function send(res, code, mime, data) {
  res.writeHead(code, { 'Content-Type': mime });
  res.end(data);
}

function serveFile(res, filePath, alt) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (alt) return serveFile(res, alt, null);
      send(res, 404, 'text/plain', 'Not found');
      return;
    }
    const ext = path.extname(filePath);
    send(res, 200, MIME[ext] || 'application/octet-stream', data);
  });
}

function isPublic(pathname) {
  const ext = path.extname(pathname)
  return pathname === '/login.html' || pathname === '/api/login' || pathname === '/api/register' || pathname === '/api/proxy'
    || (ext && ext !== '.html')
}

function hashPassword(pw) {
  return crypto.createHash('sha256').update(pw).digest('hex');
}

function readJSON(path) {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')) } catch (_) { return null }
}

function isAdminSession(session) {
  if (!session) return false;
  const u = users[session.username];
  return u && u.role === 'admin' && u.active !== false;
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Credentials': 'true' });
    res.end();
    return;
  }

  // ---- AUTH ----

  if (pathname === '/api/login' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { username, password } = JSON.parse(body);
        const user = users[username];
        if (user && user.active !== false && hashPassword(password) === user.password) {
          const token = crypto.randomBytes(32).toString('hex');
          sessions[token] = { username, createdAt: Date.now() };
          saveSessions();
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Set-Cookie': `session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`,
          });
          res.end(JSON.stringify({ ok: true, token, username, name: user.name, role: user.role || 'user' }));
        } else {
          send(res, 401, 'application/json', JSON.stringify({ error: 'Credenciales incorrectas' }));
        }
      } catch (_) {
        send(res, 400, 'application/json', JSON.stringify({ error: 'Invalid request' }));
      }
    });
    return;
  }

  if (pathname === '/api/logout') {
    const c = parseCookies(req).session;
    const auth = req.headers.authorization || '';
    const m = auth.match(/^Bearer\s+(.+)$/i);
    const t = c || (m && m[1]);
    if (t) delete sessions[t];
    saveSessions();
    res.writeHead(302, { 'Set-Cookie': 'session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0', Location: '/login.html' });
    res.end();
    return;
  }

  if (!isPublic(pathname)) {
    const session = getSession(req);
    if (!session) {
      if (pathname.startsWith('/api/')) {
        send(res, 401, 'application/json', JSON.stringify({ error: 'No autorizado' }));
      } else {
        serveFile(res, path.join(__dirname, 'login.html'));
      }
      return;
    }
    // Admin role required for admin panel
    if (pathname === '/admin.html' || pathname === '/admin') {
      if (!isAdminSession(session)) {
        send(res, 403, 'text/plain', 'Acceso denegado');
        return;
      }
    }
  }

  const session = getSession(req);
  const currentUser = session ? session.username : null;

  // ---- API: Admin ----

  if (pathname === '/api/admin/users') {
    if (!isAdminSession(session)) {
      send(res, 403, 'application/json', JSON.stringify({ error: 'Acceso denegado' }));
      return;
    }
    if (req.method === 'GET') {
      const list = Object.entries(users).map(([username, u]) => {
        const data = readJSON(dataFileForUser(username))
        return {
          username,
          name: u.name,
          role: u.role || 'user',
          active: u.active !== false,
          icalUrl: data && data.icalUrl ? data.icalUrl : '',
        }
      })
      send(res, 200, 'application/json', JSON.stringify(list))
      return
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const { username, password, name } = JSON.parse(body);
          if (!username || !password || !name) {
            send(res, 400, 'application/json', JSON.stringify({ error: 'Faltan campos' }));
            return;
          }
          if (users[username]) {
            send(res, 409, 'application/json', JSON.stringify({ error: 'El usuario ya existe' }));
            return;
          }
          users[username] = { password: hashPassword(password), name, role: 'user', active: true };
          saveUsers();
          send(res, 200, 'application/json', JSON.stringify({ ok: true }));
        } catch (_) {
          send(res, 400, 'application/json', JSON.stringify({ error: 'Invalid request' }));
        }
      });
      return;
    }
  }

  if (pathname.startsWith('/api/admin/users/') && req.method === 'PATCH') {
    if (!isAdminSession(session)) {
      send(res, 403, 'application/json', JSON.stringify({ error: 'Acceso denegado' }));
      return;
    }
    const targetUser = pathname.slice('/api/admin/users/'.length);
    if (!users[targetUser]) {
      send(res, 404, 'application/json', JSON.stringify({ error: 'Usuario no encontrado' }));
      return;
    }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const updates = JSON.parse(body);
        if (updates.password) {
          users[targetUser].password = hashPassword(updates.password);
        }
        if (updates.active !== undefined) {
          users[targetUser].active = updates.active;
        }
        saveUsers();
        send(res, 200, 'application/json', JSON.stringify({ ok: true }));
      } catch (_) {
        send(res, 400, 'application/json', JSON.stringify({ error: 'Invalid request' }));
      }
    });
    return;
  }

  // ---- API: User data ----

  if (pathname === '/api/data' && req.method === 'GET') {
    if (!currentUser) { send(res, 401, 'application/json', JSON.stringify({ error: 'No autorizado' })); return }
    const f = dataFileForUser(currentUser);
    fs.readFile(f, 'utf8', (err, data) => {
      if (err) {
        send(res, 200, 'application/json', JSON.stringify({ manualEvents: [], eventOverrides: {}, icalUrl: '' }));
        return;
      }
      send(res, 200, 'application/json', data);
    });
    return;
  }

  if (pathname === '/api/data' && req.method === 'POST') {
    if (!currentUser) { send(res, 401, 'application/json', JSON.stringify({ error: 'No autorizado' })); return }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        JSON.parse(body);
        fs.writeFile(dataFileForUser(currentUser), body, 'utf8', err => {
          if (err) {
            send(res, 500, 'application/json', JSON.stringify({ error: err.message }));
            return;
          }
          send(res, 200, 'application/json', JSON.stringify({ ok: true }));
        });
      } catch (_) {
        send(res, 400, 'application/json', JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  if (pathname === '/api/register' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { username, password, name } = JSON.parse(body);
        if (!username || !password || !name) {
          send(res, 400, 'application/json', JSON.stringify({ error: 'Faltan campos (username, password, name)' }));
          return;
        }
        if (users[username]) {
          send(res, 409, 'application/json', JSON.stringify({ error: 'El usuario ya existe' }));
          return;
        }
        users[username] = { password: hashPassword(password), name, role: 'user', active: true };
        saveUsers();
        const token = crypto.randomBytes(32).toString('hex');
        sessions[token] = { username, createdAt: Date.now() };
        saveSessions();
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': `session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`,
        });
        res.end(JSON.stringify({ ok: true, token, username, name }));
      } catch (_) {
        send(res, 400, 'application/json', JSON.stringify({ error: 'Invalid request' }));
      }
    });
    return;
  }

  if (pathname === '/api/proxy') {
    const targetUrl = parsed.query.url;
    if (!targetUrl) {
      send(res, 400, 'application/json', JSON.stringify({ error: 'Missing url parameter' }));
      return;
    }
    console.log(`[proxy] ${targetUrl}`);
    fetch(targetUrl)
      .then(proxyRes => {
        const ct = proxyRes.headers.get('content-type') || 'text/calendar; charset=utf-8';
        return proxyRes.arrayBuffer().then(buf => {
          res.writeHead(proxyRes.status, { 'Content-Type': ct, 'Cache-Control': 'public, max-age=300' });
          res.end(Buffer.from(buf));
        });
      })
      .catch(err => {
        send(res, 502, 'application/json', JSON.stringify({ error: err.message }));
      });
    return;
  }

  serveFile(res, path.join(__dirname, pathname === '/' ? 'index.html' : pathname));
});

// Migration: copy data.json -> data_jl.json if needed
const oldData = path.join(__dirname, 'data.json');
const jlData = path.join(__dirname, 'data_jl.json');
if (fs.existsSync(oldData) && !fs.existsSync(jlData)) {
  try { fs.copyFileSync(oldData, jlData); console.log('[migrate] data.json → data_jl.json') } catch (_) {}
}

server.listen(PORT, () => {
  console.log(`Servidor: http://localhost:${PORT}`);
});
