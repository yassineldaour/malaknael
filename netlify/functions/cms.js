// Secure bridge between the admin panel and GitHub.
// The GitHub token and admin password live in Netlify environment variables,
// never in the browser. The panel sends credentials with each request; this
// function checks them, then talks to GitHub on the panel's behalf.

const REPO = 'yassineldaour/malaknael';
const BRANCH = 'main';
const API = `https://api.github.com/repos/${REPO}/contents/`;

// Only content and image files inside the site folder may be read or written.
const ALLOWED = /^malaknael-portfolio\/(content|images)\//;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  const TOKEN = process.env.GH_TOKEN;
  const PASSWORD = process.env.ADMIN_PASSWORD;
  const USERNAME = process.env.ADMIN_USERNAME || 'malak';

  if (!TOKEN || !PASSWORD) {
    return json(500, { error: 'Server not configured. Set GH_TOKEN and ADMIN_PASSWORD in Netlify.' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return json(400, { error: 'Bad request' });
  }

  if (body.username !== USERNAME || body.password !== PASSWORD) {
    return json(401, { error: 'Wrong username or password' });
  }

  const headers = {
    Authorization: `token ${TOKEN}`,
    Accept: 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
    'User-Agent': 'malaknael-admin',
  };

  const pathOk = (p) => typeof p === 'string' && ALLOWED.test(p) && !p.includes('..');

  if (body.action === 'login') {
    return json(200, { ok: true });
  }

  if (body.action === 'get') {
    if (!pathOk(body.path)) return json(400, { error: 'Path not allowed' });
    const r = await fetch(`${API}${body.path}?ref=${BRANCH}`, { headers });
    return json(r.status, await r.json());
  }

  if (body.action === 'put') {
    if (!pathOk(body.path)) return json(400, { error: 'Path not allowed' });
    if (typeof body.content !== 'string') return json(400, { error: 'Missing content' });
    const payload = {
      message: body.message || 'Update from admin panel',
      content: body.content,
      branch: BRANCH,
    };
    if (body.sha) payload.sha = body.sha;
    const r = await fetch(`${API}${body.path}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(payload),
    });
    return json(r.status, await r.json());
  }

  return json(400, { error: 'Unknown action' });
};

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  };
}
