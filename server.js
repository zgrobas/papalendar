const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');

const DATA_FILE = path.join(__dirname, 'data.json');
const SESSIONS_FILE = path.join(__dirname, '.sessions.json');

const PORT = 9090;
const CREDENTIALS = { username: 'jl', password: 'grobasmato' };

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

let sessions = {};
try {
  const raw = fs.readFileSync(SESSIONS_FILE, 'utf8');
  sessions = JSON.parse(raw);
} catch (_) {}

function saveSessions() {
  try { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions)) } catch (_) {}
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
  return pathname === '/login.html' || pathname === '/api/login' || pathname === '/api/proxy'
    || (ext && ext !== '.html')
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
        if (username === CREDENTIALS.username && password === CREDENTIALS.password) {
          const token = crypto.randomBytes(32).toString('hex');
          sessions[token] = { username, createdAt: Date.now() };
          saveSessions();
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Set-Cookie': `session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`,
          });
          res.end(JSON.stringify({ ok: true, token }));
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
  }

  // ---- API ----

  if (pathname === '/api/data' && req.method === 'GET') {
    fs.readFile(DATA_FILE, 'utf8', (err, data) => {
      if (err) {
        send(res, 200, 'application/json', JSON.stringify({ manualEvents: [], eventOverrides: {}, icalUrl: '' }));
        return;
      }
      send(res, 200, 'application/json', data);
    });
    return;
  }

  if (pathname === '/api/data' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        JSON.parse(body);
        fs.writeFile(DATA_FILE, body, 'utf8', err => {
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

server.listen(PORT, () => {
  console.log(`Servidor: http://localhost:${PORT}`);
});
