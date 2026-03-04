const path = require('path');
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');

dotenv.config({ path: path.resolve(__dirname, '..', '.env.local') });
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const supabaseUrl = process.env.REACT_APP_SUPABASE_URL || process.env.SUPABASE_URL;
const serviceRoleKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.REACT_APP_SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  const missingEnvMessage =
    'Missing Supabase env. Set REACT_APP_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.';
  if (require.main === module) {
    // eslint-disable-next-line no-console
    console.error(`${missingEnvMessage} (for local dev, put it in .env.local)`);
    process.exit(1);
  }
  throw new Error(missingEnvMessage);
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function resolveInternalUser(username) {
  if (!username) return null;
  const { data, error } = await supabase
    .from('internal_users')
    .select('id,username,is_active')
    .eq('username', username)
    .maybeSingle();
  if (error) throw error;
  if (!data || data.is_active === false) return null;
  return data;
}

function requireInternalUser(req, res, next) {
  const username = req.header('x-internal-user');
  resolveInternalUser(username)
    .then((user) => {
      if (!user) {
        res.status(401).json({ error: 'Unauthorized internal user' });
        return;
      }
      req.internalUser = user;
      next();
    })
    .catch((error) => {
      res.status(500).json({ error: error.message || 'Internal user resolution failed' });
    });
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/internal/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    res.status(400).json({ error: 'Username and password are required' });
    return;
  }
  try {
    const { data, error } = await supabase
      .from('internal_users')
      .select('id,username,is_active')
      .eq('username', username.trim())
      .eq('password', password)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      res.status(401).json({ error: 'Username or password is invalid' });
      return;
    }
    if (data.is_active === false) {
      res.status(403).json({ error: 'Internal account is inactive' });
      return;
    }
    res.json({ id: data.id, username: data.username });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Internal login failed' });
  }
});

app.post('/api/http-proxy', requireInternalUser, async (req, res) => {
  try {
    const { url, method = 'GET', headers = {}, body } = req.body || {};
    if (!url || typeof url !== 'string') {
      res.status(400).json({ ok: false, error: 'url is required' });
      return;
    }

    let targetUrl;
    try {
      targetUrl = new URL(url.trim());
    } catch (error) {
      res.status(400).json({ ok: false, error: 'Invalid URL format' });
      return;
    }

    if (!['http:', 'https:'].includes(targetUrl.protocol)) {
      res.status(400).json({ ok: false, error: 'Only http/https URL is allowed' });
      return;
    }

    const cleanHeaders = {};
    Object.entries(headers || {}).forEach(([key, value]) => {
      if (!key) return;
      const normalizedKey = String(key).toLowerCase();
      if (['host', 'connection', 'content-length'].includes(normalizedKey)) return;
      cleanHeaders[key] = String(value);
    });

    const normalizedMethod = String(method || 'GET').toUpperCase();
    const requestInit = {
      method: normalizedMethod,
      headers: cleanHeaders,
    };

    if (!['GET', 'DELETE'].includes(normalizedMethod) && body !== undefined && body !== null) {
      requestInit.body = typeof body === 'string' ? body : JSON.stringify(body);
    }

    const upstream = await fetch(targetUrl.toString(), requestInit);
    const upstreamBody = await upstream.text();
    const upstreamHeaders = {};
    upstream.headers.forEach((value, key) => {
      upstreamHeaders[key] = value;
    });

    res.status(200).json({
      ok: true,
      status: upstream.status,
      statusText: upstream.statusText || '',
      headers: upstreamHeaders,
      body: upstreamBody,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message || 'Proxy request failed',
    });
  }
});

app.get('/api/collections/default', requireInternalUser, async (req, res) => {
  try {
    const userId = req.internalUser.id;
    const { data: existing, error: findError } = await supabase
      .from('collections')
      .select('id,name,created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (findError) throw findError;
    if (existing?.id) {
      res.json(existing);
      return;
    }

    const { data: created, error: createError } = await supabase
      .from('collections')
      .insert({ user_id: userId, name: 'Default Collection' })
      .select('id,name,created_at')
      .single();
    if (createError) throw createError;
    res.json(created);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to ensure default collection' });
  }
});

app.get('/api/collection-items', requireInternalUser, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('collection_items')
      .select('*')
      .eq('user_id', req.internalUser.id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to fetch collection items' });
  }
});

app.post('/api/collection-items', requireInternalUser, async (req, res) => {
  try {
    const { collectionId, name, method, url, headers = '', body = '' } = req.body || {};
    if (!collectionId || !name || !method || !url) {
      res.status(400).json({ error: 'collectionId, name, method, and url are required' });
      return;
    }
    const { data, error } = await supabase
      .from('collection_items')
      .insert({
        collection_id: collectionId,
        user_id: req.internalUser.id,
        name,
        method,
        url,
        headers,
        body,
      })
      .select('*')
      .single();
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to save collection item' });
  }
});

app.post('/api/collection-items/bulk', requireInternalUser, async (req, res) => {
  try {
    const { collectionId, items } = req.body || {};
    if (!collectionId || !Array.isArray(items) || !items.length) {
      res.status(400).json({ error: 'collectionId and items[] are required' });
      return;
    }
    const payload = items.map((item) => ({
      collection_id: collectionId,
      user_id: req.internalUser.id,
      name: item.name,
      method: item.method,
      url: item.url,
      headers: item.headers || '',
      body: item.body || '',
    }));
    const { data, error } = await supabase.from('collection_items').insert(payload).select('*');
    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to bulk insert collection items' });
  }
});

app.delete('/api/collection-items/:id', requireInternalUser, async (req, res) => {
  try {
    const { error } = await supabase
      .from('collection_items')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.internalUser.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to delete collection item' });
  }
});

app.put('/api/collection-items/:id', requireInternalUser, async (req, res) => {
  try {
    const { name, method, url, headers = '', body = '' } = req.body || {};
    if (!name || !method || !url) {
      res.status(400).json({ error: 'name, method, and url are required' });
      return;
    }
    const { data, error } = await supabase
      .from('collection_items')
      .update({
        name,
        method,
        url,
        headers,
        body,
      })
      .eq('id', req.params.id)
      .eq('user_id', req.internalUser.id)
      .select('*')
      .single();
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to update collection item' });
  }
});

app.get('/api/request-history', requireInternalUser, async (req, res) => {
  try {
    const limit = Number(req.query.limit || 50);
    const { data, error } = await supabase
      .from('request_history')
      .select('*')
      .eq('user_id', req.internalUser.id)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to fetch request history' });
  }
});

app.post('/api/request-history/bulk', requireInternalUser, async (req, res) => {
  try {
    const { items } = req.body || {};
    if (!Array.isArray(items) || !items.length) {
      res.status(400).json({ error: 'items[] is required' });
      return;
    }
    const payload = items.map((item) => ({
      user_id: req.internalUser.id,
      name: item.name,
      method: item.method,
      url: item.url,
      request_headers: item.requestHeaders || '',
      request_body: item.requestBody || '',
      status: item.status,
      status_code: item.statusCode || 0,
      response_body: item.responseBody || '',
      response_headers: JSON.stringify(item.responseHeaders || {}),
      response_time_ms: item.timeMs || 0,
      response_size_kb: item.sizeKb || 0,
    }));
    const { error } = await supabase.from('request_history').insert(payload);
    if (error) throw error;
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to insert request history' });
  }
});

app.delete('/api/request-history', requireInternalUser, async (req, res) => {
  try {
    const { error } = await supabase
      .from('request_history')
      .delete()
      .eq('user_id', req.internalUser.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to clear request history' });
  }
});

if (require.main === module) {
  const PORT = Number(process.env.PORT || 4000);
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Backend API listening on http://localhost:${PORT}`);
  });
}

module.exports = app;
