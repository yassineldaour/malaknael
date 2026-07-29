// Admin panel backend for malaknael.com — needs no configuration.
//
// Content and uploaded images are kept in Netlify Blobs, which is available to
// this function automatically. There is no GitHub token and no environment
// variable to set. The login password is stored only as a salted hash, so the
// password itself exists nowhere on the server or in this repository.
//
// Routes (all on /.netlify/functions/cms):
//   GET  ?action=content        -> public site content (falls back to the
//                                 committed JSON files before the first edit)
//   GET  ?action=img&key=...    -> an uploaded image
//   POST                        -> admin actions, each carrying the password
//
// Deliberate design choice: content lives in Blobs rather than in git, so
// saving is instant and never triggers a rebuild.

import { getStore } from '@netlify/blobs';

const STORE = 'malaknael-cms';

const USERNAME = 'malak';

// Used only until the owner sets their own password in the panel.
const DEFAULT_PASSWORD = 'Yassin123';

const CONTENT_KEYS = { settings: 'settings.json', projects: 'projects.json' };
const AUTH_KEY = 'auth.json';
const IMG_PREFIX = 'img/';

// ---------------------------------------------------------------- helpers

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

function store() {
  return getStore({ name: STORE, consistency: 'strong' });
}

async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomSalt() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Reads the stored credential, creating it from the default on first use.
async function loadAuth(s) {
  const existing = await s.get(AUTH_KEY, { type: 'json' });
  if (existing) return existing;
  const salt = randomSalt();
  const fresh = { salt, hash: await sha256(salt + DEFAULT_PASSWORD) };
  await s.setJSON(AUTH_KEY, fresh);
  return fresh;
}

async function checkPassword(s, password) {
  if (typeof password !== 'string' || !password) return false;
  const auth = await loadAuth(s);
  return (await sha256(auth.salt + password)) === auth.hash;
}

// Before the first save, fall back to the JSON committed in the repo so the
// site keeps rendering exactly as it does today.
async function readContent(s, which) {
  const fromBlobs = await s.get(CONTENT_KEYS[which], { type: 'json' });
  if (fromBlobs) return fromBlobs;

  // Try the Netlify-internal hostnames before the public one: the public domain
  // sits behind a proxy that can block or loop a request coming from here.
  const bases = [
    process.env.DEPLOY_URL,
    process.env.DEPLOY_PRIME_URL,
    process.env.URL,
    'https://malaknael.netlify.app',
  ].filter(Boolean);

  for (const base of bases) {
    try {
      const r = await fetch(`${base}/content/${which}.json`);
      if (r.ok) return await r.json();
    } catch (e) {
      // try the next hostname
    }
  }
  return which === 'projects' ? { projects: [] } : {};
}

// ---------------------------------------------------------------- GET

async function handleGet(url) {
  const action = url.searchParams.get('action');
  const s = store();

  if (action === 'content') {
    const [settings, projects] = await Promise.all([
      readContent(s, 'settings'),
      readContent(s, 'projects'),
    ]);
    return json({ settings, projects });
  }

  if (action === 'img') {
    const key = url.searchParams.get('key') || '';
    if (!key.startsWith(IMG_PREFIX) || key.includes('..')) {
      return json({ error: 'Bad image key' }, 400);
    }
    const blob = await s.getWithMetadata(key, { type: 'arrayBuffer' });
    if (!blob) return json({ error: 'Not found' }, 404);
    return new Response(blob.data, {
      headers: {
        'Content-Type': (blob.metadata && blob.metadata.contentType) || 'image/jpeg',
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  }

  return json({ error: 'Unknown action' }, 400);
}

// ---------------------------------------------------------------- POST

async function handlePost(req) {
  let body;
  try {
    body = await req.json();
  } catch (e) {
    return json({ error: 'Bad request' }, 400);
  }

  const s = store();
  if (body.username !== USERNAME || !(await checkPassword(s, body.password))) {
    return json({ error: 'Wrong username or password' }, 401);
  }

  switch (body.action) {
    case 'login':
      return json({ ok: true });

    case 'load': {
      const [settings, projects] = await Promise.all([
        readContent(s, 'settings'),
        readContent(s, 'projects'),
      ]);
      return json({ ok: true, settings, projects });
    }

    case 'saveSettings': {
      if (!body.settings || typeof body.settings !== 'object') {
        return json({ error: 'Missing settings' }, 400);
      }
      await s.setJSON(CONTENT_KEYS.settings, body.settings);
      return json({ ok: true });
    }

    case 'saveProjects': {
      if (!Array.isArray(body.projects)) {
        return json({ error: 'Missing projects' }, 400);
      }
      await s.setJSON(CONTENT_KEYS.projects, { projects: body.projects });
      return json({ ok: true });
    }

    case 'uploadImage': {
      // dataUrl looks like "data:image/jpeg;base64,AAAA..."
      const m = /^data:([\w/+.-]+);base64,(.+)$/.exec(body.dataUrl || '');
      if (!m) return json({ error: 'Bad image data' }, 400);
      const contentType = m[1];
      if (!contentType.startsWith('image/')) {
        return json({ error: 'Only images are allowed' }, 400);
      }
      const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
      if (bytes.length > 8 * 1024 * 1024) {
        return json({ error: 'Image is larger than 8 MB' }, 400);
      }
      const safeName = String(body.name || 'photo')
        .toLowerCase()
        .replace(/[^a-z0-9.]+/g, '-')
        .slice(-60);
      const key = `${IMG_PREFIX}${Date.now()}-${safeName}`;
      await s.set(key, bytes, { metadata: { contentType } });
      return json({
        ok: true,
        key,
        url: `/.netlify/functions/cms?action=img&key=${encodeURIComponent(key)}`,
      });
    }

    case 'changePassword': {
      const next = body.newPassword;
      if (typeof next !== 'string' || next.length < 6) {
        return json({ error: 'New password must be at least 6 characters' }, 400);
      }
      const salt = randomSalt();
      await s.setJSON(AUTH_KEY, { salt, hash: await sha256(salt + next) });
      return json({ ok: true });
    }

    default:
      return json({ error: 'Unknown action' }, 400);
  }
}

// ---------------------------------------------------------------- entry

export default async (req) => {
  try {
    const url = new URL(req.url);
    if (req.method === 'GET') return await handleGet(url);
    if (req.method === 'POST') return await handlePost(req);
    return json({ error: 'Method not allowed' }, 405);
  } catch (err) {
    return json({ error: 'Server error: ' + (err && err.message) }, 500);
  }
};
