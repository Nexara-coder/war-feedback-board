require('dotenv').config();
const express = require('express');
const session = require('express-session');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;
const USE_SECURE_COOKIE = process.env.USE_SECURE_COOKIE === 'true';

if (!ADMIN_PASSWORD) {
  console.error('ADMIN_PASSWORD is not set in .env — refusing to start.');
  console.error('Copy .env.example to .env and set a password first.');
  process.exit(1);
}
if (!SESSION_SECRET) {
  console.error('SESSION_SECRET is not set in .env — refusing to start.');
  process.exit(1);
}

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'tasks.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]');

function loadTasks() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return [];
  }
}
function saveTasks(tasks) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(tasks, null, 2));
}

// If nginx sits in front of this (recommended), trust its proxy headers
// so rate limiting and cookies behave correctly.
app.set('trust proxy', 1);

app.use(express.json());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 12, // 12 hours
    sameSite: 'lax',
    secure: USE_SECURE_COOKIE // set true in .env once served over HTTPS
  }
}));

// --- very small login rate limiter (per IP, in-memory) ---
const loginAttempts = new Map();
function isRateLimited(ip) {
  const rec = loginAttempts.get(ip);
  if (!rec) return false;
  const windowMs = 5 * 60 * 1000;
  if (Date.now() - rec.first > windowMs) {
    loginAttempts.delete(ip);
    return false;
  }
  return rec.count >= 8;
}
function recordFailedAttempt(ip) {
  const rec = loginAttempts.get(ip);
  if (!rec) loginAttempts.set(ip, { count: 1, first: Date.now() });
  else rec.count += 1;
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.status(401).json({ error: 'Admin login required.' });
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/session', (req, res) => {
  res.json({ isAdmin: !!(req.session && req.session.isAdmin) });
});

app.post('/api/login', (req, res) => {
  const ip = req.ip;
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  }
  const { password } = req.body || {};
  if (password && password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    loginAttempts.delete(ip);
    return res.json({ ok: true });
  }
  recordFailedAttempt(ip);
  return res.status(401).json({ error: 'Incorrect password.' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/tasks', (req, res) => {
  res.json(loadTasks());
});

// --- light rate limiter for public submissions (prevents spam floods) ---
const submitAttempts = new Map();
function isSubmitRateLimited(ip) {
  const rec = submitAttempts.get(ip);
  if (!rec) return false;
  const windowMs = 10 * 60 * 1000;
  if (Date.now() - rec.first > windowMs) {
    submitAttempts.delete(ip);
    return false;
  }
  return rec.count >= 20;
}
function recordSubmission(ip) {
  const rec = submitAttempts.get(ip);
  if (!rec) submitAttempts.set(ip, { count: 1, first: Date.now() });
  else rec.count += 1;
}

app.post('/api/tasks', (req, res) => {
  const ip = req.ip;
  if (isSubmitRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many reports submitted — try again later.' });
  }
  const { title, desc, priority, reporter } = req.body || {};
  if (!title || !String(title).trim()) {
    return res.status(400).json({ error: 'Title is required.' });
  }
  const tasks = loadTasks();
  const task = {
    id: 't_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    title: String(title).trim().slice(0, 200),
    desc: (desc || '').toString().slice(0, 2000),
    priority: ['critical', 'high', 'medium', 'low'].includes(priority) ? priority : 'medium',
    reporter: (reporter || 'Anonymous').toString().slice(0, 60),
    status: 'queued',
    created: Date.now()
  };
  tasks.unshift(task);
  saveTasks(tasks);
  recordSubmission(ip);
  res.json(task);
});

app.patch('/api/tasks/:id', requireAdmin, (req, res) => {
  const { status, title, desc, priority, reporter } = req.body || {};
  const tasks = loadTasks();
  const task = tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found.' });

  // Status move
  if (status !== undefined) {
    if (!['queued', 'active', 'resolved'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status.' });
    }
    task.status = status;
  }

  // Field edits
  if (title !== undefined) {
    if (!String(title).trim()) {
      return res.status(400).json({ error: 'Title is required.' });
    }
    task.title = String(title).trim().slice(0, 200);
  }
  if (desc !== undefined) {
    task.desc = String(desc).slice(0, 2000);
  }
  if (priority !== undefined) {
    if (!['critical', 'high', 'medium', 'low'].includes(priority)) {
      return res.status(400).json({ error: 'Invalid priority.' });
    }
    task.priority = priority;
  }
  if (reporter !== undefined) {
    task.reporter = (String(reporter).trim() || 'Anonymous').slice(0, 60);
  }

  saveTasks(tasks);
  res.json(task);
});

app.delete('/api/tasks/:id', requireAdmin, (req, res) => {
  let tasks = loadTasks();
  const before = tasks.length;
  tasks = tasks.filter(t => t.id !== req.params.id);
  if (tasks.length === before) return res.status(404).json({ error: 'Not found.' });
  saveTasks(tasks);
  res.json({ ok: true });
});

app.delete('/api/tasks', requireAdmin, (req, res) => {
  saveTasks([]);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`W.A.R. Online feedback board running on port ${PORT}`);
});
