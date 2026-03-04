
import './App.css';
import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from './supabaseClient';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const STORAGE_KEYS = {
  collections: 'mso5_collections_v1',
  history: 'mso5_history_v1',
  settings: 'mso5_settings_v1',
  internalSession: 'mso5_internal_session_v1',
};
const INTERNAL_SESSION_DURATION_SECONDS = 6 * 60 * 60;

const QUICK_ENDPOINTS = [
  {
    label: 'JSON Placeholder',
    method: 'GET',
    url: 'https://jsonplaceholder.typicode.com/posts/1',
    headers: 'Accept: application/json',
    body: '',
  },
  {
    label: 'Create Post',
    method: 'POST',
    url: 'https://jsonplaceholder.typicode.com/posts',
    headers: 'Content-Type: application/json\nAccept: application/json',
    body: '{\n  "title": "demo",\n  "body": "hello world",\n  "userId": 1\n}',
  },
  {
    label: 'ReqRes Users',
    method: 'GET',
    url: 'https://reqres.in/api/users?page=1',
    headers: 'Accept: application/json',
    body: '',
  },
];

function parseHeaders(rawHeaders) {
  return rawHeaders
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .reduce((acc, line) => {
      const separatorIndex = line.indexOf(':');
      if (separatorIndex > 0) {
        const key = line.slice(0, separatorIndex).trim();
        const value = line.slice(separatorIndex + 1).trim();
        if (key) acc[key] = value;
      }
      return acc;
    }, {});
}

function getHeaderValue(headersObject, headerName) {
  const target = String(headerName || '').toLowerCase();
  const foundKey = Object.keys(headersObject || {}).find(
    (key) => key.toLowerCase() === target
  );
  return foundKey ? headersObject[foundKey] : '';
}

function upsertHeader(rawHeaders, key, value) {
  const rows = String(rawHeaders || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const nextRows = [];
  let replaced = false;
  rows.forEach((line) => {
    const separatorIndex = line.indexOf(':');
    if (separatorIndex < 1) {
      nextRows.push(line);
      return;
    }
    const rowKey = line.slice(0, separatorIndex).trim();
    if (rowKey.toLowerCase() === key.toLowerCase()) {
      if (!replaced) {
        nextRows.push(`${key}: ${value}`);
        replaced = true;
      }
      return;
    }
    nextRows.push(line);
  });
  if (!replaced) nextRows.push(`${key}: ${value}`);
  return nextRows.join('\n');
}

function stripJsonComments(text) {
  return String(text || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^\\])\/\/.*$/gm, '$1');
}

function extractFirstJsonChunk(text) {
  const source = String(text || '');
  const firstBrace = source.search(/[{[]/);
  if (firstBrace < 0) return source.trim();
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = firstBrace; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{' || char === '[') depth += 1;
    if (char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(firstBrace, index + 1).trim();
      }
    }
  }
  return source.slice(firstBrace).trim();
}

function parseFormBody(rawBody) {
  const text = String(rawBody || '').trim();
  const params = new URLSearchParams();
  if (!text) return params.toString();
  if (text.includes('&') && !text.includes('\n')) {
    const fromQuery = new URLSearchParams(text);
    fromQuery.forEach((value, key) => params.append(key, value));
    return params.toString();
  }
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line) => {
      const separator = line.includes('=') ? '=' : line.includes(':') ? ':' : null;
      if (!separator) return;
      const idx = line.indexOf(separator);
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      if (key) params.append(key, value);
    });
  return params.toString();
}

function inferBodyModeFromRequest(headersText, bodyText = '') {
  const parsed = parseHeaders(headersText || '');
  const contentType = String(getHeaderValue(parsed, 'Content-Type') || '').toLowerCase();
  if (contentType.includes('application/json')) return 'json';
  if (contentType.includes('application/x-www-form-urlencoded')) return 'form';
  const cleaned = stripJsonComments(String(bodyText || ''));
  const chunk = extractFirstJsonChunk(cleaned);
  if (chunk && safeParseJson(chunk, null) !== null) return 'json';
  const looksForm = /(^|\n)\s*[\w.-]+\s*[:=]\s*.+/m.test(String(bodyText || ''));
  if (looksForm) return 'form';
  return 'raw';
}

function prettyData(data) {
  if (typeof data === 'string') return data;
  try {
    return JSON.stringify(data, null, 2);
  } catch (error) {
    return String(data);
  }
}

function safeParseJson(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (error) {
    return fallback;
  }
}

function readLocalJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (error) {
    return fallback;
  }
}

function escapeCsv(value) {
  const raw = String(value ?? '');
  if (raw.includes('"') || raw.includes(',') || raw.includes('\n')) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

function buildCsv(rows) {
  const header = ['name', 'method', 'url', 'headers', 'body'];
  const body = rows.map((row) =>
    [
      escapeCsv(row.name),
      escapeCsv(row.method),
      escapeCsv(row.url),
      escapeCsv(row.headers),
      escapeCsv(row.body),
    ].join(',')
  );
  return [header.join(','), ...body].join('\n');
}

function parseCsv(csvText) {
  const rows = [];
  let current = '';
  let inQuotes = false;
  let row = [];

  const pushCell = () => {
    row.push(current);
    current = '';
  };

  const pushRow = () => {
    if (row.length > 1 || (row.length === 1 && row[0].trim() !== '')) rows.push(row);
    row = [];
  };

  for (let i = 0; i < csvText.length; i += 1) {
    const char = csvText[i];
    const next = csvText[i + 1];
    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      i += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      pushCell();
    } else if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') i += 1;
      pushCell();
      pushRow();
    } else {
      current += char;
    }
  }
  if (current.length || row.length) {
    pushCell();
    pushRow();
  }
  return rows;
}

function parseCsvObjects(csvText) {
  const rows = parseCsv(csvText);
  if (!rows.length) return [];
  const [headers, ...dataRows] = rows;
  const keys = headers.map((h) => h.trim());
  return dataRows.map((row) =>
    keys.reduce((acc, key, index) => {
      acc[key] = row[index] ?? '';
      return acc;
    }, {})
  );
}

function interpolateTemplate(value, variables) {
  if (!value) return value;
  return String(value).replace(/\{\{(.*?)\}\}/g, (_, rawKey) => {
    const key = String(rawKey || '').trim();
    return Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : '';
  });
}

function headersTextToArray(headersText) {
  return headersText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separatorIndex = line.indexOf(':');
      if (separatorIndex < 1) return null;
      return {
        key: line.slice(0, separatorIndex).trim(),
        value: line.slice(separatorIndex + 1).trim(),
        type: 'text',
      };
    })
    .filter(Boolean);
}

function headersArrayToText(headersArray) {
  if (!Array.isArray(headersArray)) return '';
  return headersArray
    .map((item) => {
      const key = item?.key || item?.name || '';
      const value = item?.value || '';
      return key ? `${key}: ${value}` : '';
    })
    .filter(Boolean)
    .join('\n');
}

function encodeBase64Url(value) {
  const json = typeof value === 'string' ? value : JSON.stringify(value);
  return btoa(unescape(encodeURIComponent(json)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function decodeBase64Url(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = padded.length % 4;
  const normalized = padding ? `${padded}${'='.repeat(4 - padding)}` : padded;
  return decodeURIComponent(escape(atob(normalized)));
}

function createInternalJwt(username) {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + INTERNAL_SESSION_DURATION_SECONDS;
  const header = encodeBase64Url({ alg: 'HS256', typ: 'JWT' });
  const payload = encodeBase64Url({ sub: username, iat: now, exp, role: 'internal' });
  const random = new Uint8Array(18);
  crypto.getRandomValues(random);
  const signature = encodeBase64Url(Array.from(random).join('.'));
  return `${header}.${payload}.${signature}`;
}

function parseInternalJwt(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(decodeBase64Url(parts[1]));
    return payload;
  } catch (error) {
    return null;
  }
}

async function showPopup({ icon, title, text }) {
  const { default: Swal } = await import('sweetalert2');
  await Swal.fire({
    toast: true,
    position: 'top-end',
    icon,
    title,
    text,
    showConfirmButton: false,
    timer: 2800,
    timerProgressBar: true,
    confirmButtonColor: '#06b6d4',
    background: '#0f1a33',
    color: '#e0f2fe',
  });
}

async function showConfirmPopup({ title, text, confirmButtonText = 'Ya, lanjut' }) {
  const { default: Swal } = await import('sweetalert2');
  const result = await Swal.fire({
    icon: 'question',
    title,
    text,
    showCancelButton: true,
    confirmButtonText,
    cancelButtonText: 'Batal',
    confirmButtonColor: '#06b6d4',
    cancelButtonColor: '#475569',
    background: '#0f1a33',
    color: '#e0f2fe',
  });
  return result.isConfirmed;
}

async function withLoadingPopup(text, callback) {
  const { default: Swal } = await import('sweetalert2');
  Swal.fire({
    title: 'Please wait',
    text,
    allowOutsideClick: false,
    allowEscapeKey: false,
    showConfirmButton: false,
    background: '#0f1a33',
    color: '#e0f2fe',
    didOpen: () => {
      Swal.showLoading();
    },
  });
  try {
    return await callback();
  } finally {
    Swal.close();
  }
}

async function apiRequest(path, { method = 'GET', body, internalUser } = {}) {
  const response = await fetch(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(internalUser ? { 'x-internal-user': internalUser } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const raw = await response.text();
  const payload = raw ? safeParseJson(raw, { error: raw }) : {};
  if (!response.ok) {
    throw new Error(payload.error || payload.message || `HTTP ${response.status}`);
  }
  return payload;
}

function applyAuthToRequest(request, authConfig) {
  const nextRequest = { ...request };
  const nextHeaders = parseHeaders(nextRequest.headers || '');
  let nextUrl = nextRequest.url || '';

  if (!authConfig || authConfig.type === 'none') {
    return { ...nextRequest, headers: nextRequest.headers || '', url: nextUrl };
  }

  if (authConfig.type === 'bearer' && authConfig.bearerToken.trim()) {
    nextHeaders.Authorization = `Bearer ${authConfig.bearerToken.trim()}`;
  }

  if (authConfig.type === 'basic') {
    const user = authConfig.basicUsername || '';
    const pass = authConfig.basicPassword || '';
    nextHeaders.Authorization = `Basic ${btoa(`${user}:${pass}`)}`;
  }

  if (authConfig.type === 'apikey' && authConfig.apiKeyName.trim()) {
    const keyName = authConfig.apiKeyName.trim();
    const keyValue = authConfig.apiKeyValue || '';
    if (authConfig.apiKeyIn === 'query') {
      try {
        const urlObj = new URL(nextUrl);
        urlObj.searchParams.set(keyName, keyValue);
        nextUrl = urlObj.toString();
      } catch (error) {
        const hasQuery = nextUrl.includes('?');
        nextUrl = `${nextUrl}${hasQuery ? '&' : '?'}${encodeURIComponent(
          keyName
        )}=${encodeURIComponent(keyValue)}`;
      }
    } else {
      nextHeaders[keyName] = keyValue;
    }
  }

  const normalizedHeaders = Object.entries(nextHeaders)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');

  return {
    ...nextRequest,
    url: nextUrl,
    headers: normalizedHeaders,
  };
}

function hydrateAuthFromHeaders(headersText) {
  const parsed = parseHeaders(headersText || '');
  const authHeader = String(getHeaderValue(parsed, 'Authorization') || '').trim();

  const next = {
    authType: 'none',
    bearerToken: '',
    basicUsername: '',
    basicPassword: '',
  };

  if (!authHeader) return next;

  if (authHeader.toLowerCase().startsWith('bearer ')) {
    return {
      ...next,
      authType: 'bearer',
      bearerToken: authHeader.slice(7).trim(),
    };
  }

  if (authHeader.toLowerCase().startsWith('basic ')) {
    try {
      const encoded = authHeader.slice(6).trim();
      const decoded = atob(encoded);
      const separator = decoded.indexOf(':');
      if (separator >= 0) {
        return {
          ...next,
          authType: 'basic',
          basicUsername: decoded.slice(0, separator),
          basicPassword: decoded.slice(separator + 1),
        };
      }
    } catch (error) {
      return next;
    }
  }

  return next;
}

function App() {
  const [activeMenu, setActiveMenu] = useState('Request Builder');
  const [method, setMethod] = useState('GET');
  const [url, setUrl] = useState('https://jsonplaceholder.typicode.com/posts/1');
  const [headersText, setHeadersText] = useState(
    'Content-Type: application/json\nAccept: application/json'
  );
  const [body, setBody] = useState('');
  const [bodyMode, setBodyMode] = useState('json');
  const [requestName, setRequestName] = useState('Untitled Request');
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [responseData, setResponseData] = useState('');
  const [responseStatus, setResponseStatus] = useState('-');
  const [responseTime, setResponseTime] = useState('-');
  const [responseSize, setResponseSize] = useState('-');
  const [responseHeaders, setResponseHeaders] = useState({});
  const [authType, setAuthType] = useState('none');
  const [bearerToken, setBearerToken] = useState('');
  const [basicUsername, setBasicUsername] = useState('');
  const [basicPassword, setBasicPassword] = useState('');
  const [apiKeyName, setApiKeyName] = useState('x-api-key');
  const [apiKeyValue, setApiKeyValue] = useState('');
  const [apiKeyIn, setApiKeyIn] = useState('header');

  const [collections, setCollections] = useState(() =>
    readLocalJson(STORAGE_KEYS.collections, [])
  );
  const [history, setHistory] = useState(() => readLocalJson(STORAGE_KEYS.history, []));
  const [settings, setSettings] = useState(() =>
    readLocalJson(STORAGE_KEYS.settings, {
      timeoutMs: 15000,
      maxHistory: 50,
      autoSaveHistory: true,
    })
  );
  const [runnerResults, setRunnerResults] = useState([]);
  const [runnerLoading, setRunnerLoading] = useState(false);
  const [runnerCsvRows, setRunnerCsvRows] = useState([]);
  const [runnerCsvName, setRunnerCsvName] = useState('');
  const [runnerSelectedIds, setRunnerSelectedIds] = useState([]);
  const [activeRunnerResultKey, setActiveRunnerResultKey] = useState(null);
  const [loadedCollectionId, setLoadedCollectionId] = useState(null);
  const [collectionNotice, setCollectionNotice] = useState('');

  const [, setSession] = useState(null);
  const [sessionChecked, setSessionChecked] = useState(false);
  const [authMessage, setAuthMessage] = useState('');
  const [syncLoading, setSyncLoading] = useState(false);
  const [defaultCollectionId, setDefaultCollectionId] = useState(null);
  const [collectionsLoading, setCollectionsLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [collectionsLoaded, setCollectionsLoaded] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [internalUsername, setInternalUsername] = useState('');
  const [internalPassword, setInternalPassword] = useState('');
  const [showInternalPassword, setShowInternalPassword] = useState(false);
  const [internalAuthLoading, setInternalAuthLoading] = useState(false);
  const [internalAuthError, setInternalAuthError] = useState('');
  const [internalUser, setInternalUser] = useState(null);
  const [internalSessionExp, setInternalSessionExp] = useState(null);
  const [internalReady, setInternalReady] = useState(false);

  const fileInputRef = useRef(null);
  const jsonImportRef = useRef(null);
  const runnerCsvRef = useRef(null);
  const initLoadingPopupOpenRef = useRef(false);
  const methodClassName = useMemo(() => method.toLowerCase(), [method]);
  const cloudUserId = internalUser || null;

  const resetResponsePanel = () => {
    setErrorMessage('');
    setResponseData('');
    setResponseHeaders({});
    setResponseStatus('-');
    setResponseTime('-');
    setResponseSize('-');
  };

  useEffect(() => {
    const token = localStorage.getItem(STORAGE_KEYS.internalSession);
    if (!token) {
      setInternalReady(true);
      return;
    }
    const payload = parseInternalJwt(token);
    if (!payload?.sub || !payload?.exp || payload.exp * 1000 <= Date.now()) {
      localStorage.removeItem(STORAGE_KEYS.internalSession);
      setInternalReady(true);
      return;
    }
    setInternalUser(payload.sub);
    setInternalSessionExp(payload.exp);
    setInternalReady(true);
  }, []);

  useEffect(() => {
    if (!internalUser || !internalSessionExp) return undefined;
    const timer = setInterval(() => {
      if (Date.now() >= internalSessionExp * 1000) {
        localStorage.removeItem(STORAGE_KEYS.internalSession);
        setInternalUser(null);
        setInternalSessionExp(null);
        setInternalAuthError('Session habis. Silakan login ulang.');
      }
    }, 15000);
    return () => clearInterval(timer);
  }, [internalUser, internalSessionExp]);

  useEffect(() => {
    const websiteIsLoading = !internalReady || !sessionChecked;
    let isCancelled = false;

    const togglePopup = async () => {
      const { default: Swal } = await import('sweetalert2');
      if (isCancelled) return;

      if (websiteIsLoading && !initLoadingPopupOpenRef.current) {
        initLoadingPopupOpenRef.current = true;
        Swal.fire({
          title: 'Loading Website',
          text: 'Menyiapkan session dan data awal...',
          allowOutsideClick: false,
          allowEscapeKey: false,
          showConfirmButton: false,
          background: '#0f1a33',
          color: '#e0f2fe',
          didOpen: () => {
            Swal.showLoading();
          },
        });
      }

      if (!websiteIsLoading && initLoadingPopupOpenRef.current) {
        initLoadingPopupOpenRef.current = false;
        Swal.close();
      }
    };

    togglePopup();
    return () => {
      isCancelled = true;
    };
  }, [internalReady, sessionChecked]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.collections, JSON.stringify(collections));
  }, [collections]);

  useEffect(() => {
    setRunnerSelectedIds((previous) =>
      previous.filter((id) => collections.some((item) => item.id === id))
    );
  }, [collections]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.history, JSON.stringify(history));
  }, [history]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(settings));
  }, [settings]);
  useEffect(() => {
    if (!supabase) {
      setAuthMessage(
        'Supabase belum aktif. Isi REACT_APP_SUPABASE_URL dan REACT_APP_SUPABASE_ANON_KEY.'
      );
      setSessionChecked(true);
      return undefined;
    }

    let mounted = true;
    supabase.auth.getSession().then(async ({ data, error }) => {
      if (!mounted) return;
      if (error) {
        setAuthMessage(error.message);
        setSessionChecked(true);
        return;
      }
      if (!data.session) {
        const { data: anonData, error: anonError } = await supabase.auth.signInAnonymously();
        if (!mounted) return;
        if (anonError) {
          setAuthMessage(
            anonError.message ||
              'Gagal membuat session Supabase. Aktifkan Anonymous Sign-ins di Supabase Auth.'
          );
          setSessionChecked(true);
          return;
        }
        setSession(anonData.session ?? null);
        setSessionChecked(true);
        return;
      }

      setSession(data.session);
      setSessionChecked(true);
    });

    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
    });

    return () => {
      mounted = false;
      data.subscription.unsubscribe();
    };
  }, []);

  const mapItemRow = (row) => ({
    id: row.id,
    collectionId: row.collection_id,
    name: row.name,
    method: row.method,
    url: row.url,
    headers: row.headers || '',
    body: row.body || '',
    bodyMode: inferBodyModeFromRequest(row.headers || '', row.body || ''),
    createdAt: row.created_at,
  });

  const mapHistoryRow = (row) => ({
    id: row.id,
    name: row.name,
    method: row.method,
    url: row.url,
    requestHeaders: row.request_headers || '',
    requestBody: row.request_body || '',
    status: row.status,
    statusCode: row.status_code,
    responseBody: row.response_body || '',
    responseHeaders: safeParseJson(row.response_headers, {}),
    time: `${row.response_time_ms || 0} ms`,
    size: `${Number(row.response_size_kb || 0).toFixed(2)} KB`,
    createdAt: row.created_at,
  });

  const ensureDefaultCollection = async (userId) => {
    if (!userId) return null;
    const data = await apiRequest('/api/collections/default', {
      internalUser: userId,
    });
    return data?.id || null;
  };

  const fetchCollectionsCloud = async (userId, silent = false) => {
    if (!userId) return;
    if (!silent) setCollectionsLoading(true);
    try {
      const itemRows = await apiRequest('/api/collection-items', {
        internalUser: userId,
      });
      setCollections((itemRows || []).map(mapItemRow));
      setCollectionsLoaded(true);
      return true;
    } catch (error) {
      setAuthMessage(error.message || 'Gagal load collections.');
      await showPopup({
        icon: 'error',
        title: 'Collections Gagal Dimuat',
        text: error.message || 'Terjadi kesalahan saat mengambil data collections.',
      });
      return false;
    } finally {
      if (!silent) setCollectionsLoading(false);
    }
  };

  const fetchHistoryCloud = async (userId, silent = false) => {
    if (!userId) return;
    if (!silent) setHistoryLoading(true);
    try {
      const historyRows = await apiRequest(
        `/api/request-history?limit=${encodeURIComponent(settings.maxHistory)}`,
        {
          internalUser: userId,
        }
      );
      setHistory((historyRows || []).map(mapHistoryRow));
      setHistoryLoaded(true);
      return true;
    } catch (error) {
      setAuthMessage(error.message || 'Gagal load history.');
      await showPopup({
        icon: 'error',
        title: 'History Gagal Dimuat',
        text: error.message || 'Terjadi kesalahan saat mengambil data history.',
      });
      return false;
    } finally {
      if (!silent) setHistoryLoading(false);
    }
  };

  const refreshCloudData = async (userId) => {
    if (!supabase || !userId) return;
    setSyncLoading(true);
    try {
      const [collectionsOk, historyOk] = await withLoadingPopup(
        'Sinkronisasi data cloud berjalan...',
        async () =>
          Promise.all([fetchCollectionsCloud(userId, true), fetchHistoryCloud(userId, true)])
      );
      if (collectionsOk && historyOk) {
        await showPopup({
          icon: 'success',
          title: 'Sync Berhasil',
          text: 'Data collections dan history sudah diperbarui.',
        });
      }
    } finally {
      setSyncLoading(false);
    }
  };

  useEffect(() => {
    if (cloudUserId) {
      ensureDefaultCollection(cloudUserId)
        .then((collectionId) => {
          setDefaultCollectionId(collectionId);
          setCollectionsLoaded(false);
          setHistoryLoaded(false);
          setCollections([]);
          setHistory([]);
        })
        .catch(async (error) => {
          setAuthMessage(error.message || 'Gagal menyiapkan collection default.');
          await showPopup({
            icon: 'error',
            title: 'Setup Gagal',
            text: error.message || 'Gagal menyiapkan collection default.',
          });
        });
    } else {
      setDefaultCollectionId(null);
      setCollectionsLoaded(false);
      setHistoryLoaded(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloudUserId]);

  useEffect(() => {
    if (!cloudUserId) return;
    if (activeMenu === 'Collections' && !collectionsLoaded) {
      fetchCollectionsCloud(cloudUserId);
    }
    if (activeMenu === 'History' && !historyLoaded) {
      fetchHistoryCloud(cloudUserId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeMenu, cloudUserId, collectionsLoaded, historyLoaded]);

  const applyPreset = (preset) => {
    setMethod(preset.method);
    setUrl(preset.url);
    setHeadersText(preset.headers);
    setBody(preset.body);
    setBodyMode(inferBodyModeFromRequest(preset.headers || '', preset.body || ''));
    setRequestName(preset.label);
    setLoadedCollectionId(null);
    setAuthType('none');
    setBearerToken('');
    setBasicUsername('');
    setBasicPassword('');
    resetResponsePanel();
    setActiveMenu('Request Builder');
  };

  const prepareRequestBody = (request) => {
    const normalizedMethod = (request.method || 'GET').toUpperCase();
    if (['GET', 'DELETE'].includes(normalizedMethod)) {
      return { body: undefined, headers: request.headers || '' };
    }

    const rawBody = String(request.body || '');
    if (!rawBody.trim()) {
      return { body: undefined, headers: request.headers || '' };
    }

    const requestedMode =
      request.bodyMode || inferBodyModeFromRequest(request.headers || '', request.body || '');
    if (requestedMode === 'form') {
      const formBody = parseFormBody(rawBody);
      const headersWithType = upsertHeader(
        request.headers || '',
        'Content-Type',
        'application/x-www-form-urlencoded'
      );
      return { body: formBody, headers: headersWithType };
    }

    if (requestedMode === 'json') {
      const jsonChunk = extractFirstJsonChunk(stripJsonComments(rawBody));
      const parsed = safeParseJson(jsonChunk, null);
      if (parsed === null) {
        throw new Error('Body JSON tidak valid setelah komentar dibersihkan.');
      }
      const headersWithType = upsertHeader(
        request.headers || '',
        'Content-Type',
        'application/json'
      );
      return { body: JSON.stringify(parsed), headers: headersWithType };
    }

    return { body: rawBody, headers: request.headers || '' };
  };

  const executeRequest = async (request) => {
    const normalizedMethod = (request.method || 'GET').toUpperCase();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), settings.timeoutMs);
    const startedAt = performance.now();
    let prepared = {
      headers: request.headers || '',
      body: request.body || '',
    };

    const buildResultPayload = ({
      rawText,
      statusCode,
      statusText,
      headersObject,
      requestHeaders,
      requestBody,
    }) => {
      let formattedBody = rawText;
      try {
        formattedBody = JSON.stringify(JSON.parse(rawText), null, 2);
      } catch (error) {
        formattedBody = rawText || 'No response body';
      }
      const elapsedMs = Math.round(performance.now() - startedAt);
      const bytes = new TextEncoder().encode(rawText || '').length;
      const sizeKb = Number((bytes / 1024).toFixed(2));
      return {
        ok: Number(statusCode || 0) >= 200 && Number(statusCode || 0) < 300,
        status: `${statusCode} ${statusText || ''}`.trim(),
        statusCode: Number(statusCode || 0),
        responseBody: formattedBody,
        responseHeaders: headersObject || {},
        requestHeaders: requestHeaders || '',
        requestBody: requestBody || '',
        time: `${elapsedMs} ms`,
        timeMs: elapsedMs,
        size: `${sizeKb.toFixed(2)} KB`,
        sizeKb,
        url: request.url,
        method: normalizedMethod,
        name: request.name || 'Untitled Request',
        createdAt: new Date().toISOString(),
      };
    };

    try {
      prepared = prepareRequestBody(request);
      const response = await fetch('/api/http-proxy', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(cloudUserId ? { 'x-internal-user': cloudUserId } : {}),
        },
        signal: controller.signal,
        body: JSON.stringify({
          url: request.url,
          method: normalizedMethod,
          headers: parseHeaders(prepared.headers || ''),
          body: prepared.body,
        }),
      });

      const proxyPayload = await response.json();
      if (!response.ok || !proxyPayload?.ok) {
        throw new Error(proxyPayload?.error || `Proxy request gagal (${response.status})`);
      }

      return buildResultPayload({
        rawText: proxyPayload.body || '',
        statusCode: proxyPayload.status,
        statusText: proxyPayload.statusText || '',
        headersObject: proxyPayload.headers || {},
        requestHeaders: prepared.headers || '',
        requestBody: prepared.body || '',
      });
    } catch (error) {
      const timedOut = error.name === 'AbortError';
      const canTryDirect =
        !timedOut &&
        typeof window !== 'undefined' &&
        String(error.message || '').toLowerCase().includes('fetch failed') &&
        /^https?:\/\//i.test(String(request.url || ''));

      if (canTryDirect) {
        try {
          const directResponse = await fetch(request.url, {
            method: normalizedMethod,
            headers: parseHeaders(prepared.headers || ''),
            body: ['GET', 'DELETE'].includes(normalizedMethod) ? undefined : prepared.body,
            signal: controller.signal,
          });
          const directText = await directResponse.text();
          const headersObject = {};
          directResponse.headers.forEach((value, key) => {
            headersObject[key] = value;
          });
          return buildResultPayload({
            rawText: directText,
            statusCode: directResponse.status,
            statusText: directResponse.statusText || '',
            headersObject,
            requestHeaders: prepared.headers || '',
            requestBody: prepared.body || '',
          });
        } catch (directError) {
          const elapsedMsDirect = Math.round(performance.now() - startedAt);
          return {
            ok: false,
            status: 'Request Failed',
            statusCode: 0,
            responseBody:
              'Proxy cloud gagal dijangkau, lalu fallback direct request juga gagal (kemungkinan CORS/jaringan private).',
            responseHeaders: {},
            requestHeaders: prepared.headers || '',
            requestBody: prepared.body || '',
            time: `${elapsedMsDirect} ms`,
            timeMs: elapsedMsDirect,
            size: '0.00 KB',
            sizeKb: 0,
            url: request.url,
            method: normalizedMethod,
            name: request.name || 'Untitled Request',
            createdAt: new Date().toISOString(),
          };
        }
      }

      const elapsedMs = Math.round(performance.now() - startedAt);
      return {
        ok: false,
        status: timedOut ? '408 Timeout' : 'Request Failed',
        statusCode: timedOut ? 408 : 0,
        responseBody: timedOut
          ? `Request timeout setelah ${settings.timeoutMs} ms`
          : `Request gagal. ${String(error.message || 'Cek URL, CORS, atau koneksi jaringan.')}`,
        responseHeaders: {},
        requestHeaders: prepared.headers || request.headers || '',
        requestBody: prepared.body || request.body || '',
        time: `${elapsedMs} ms`,
        timeMs: elapsedMs,
        size: '0.00 KB',
        sizeKb: 0,
        url: request.url,
        method: normalizedMethod,
        name: request.name || 'Untitled Request',
        createdAt: new Date().toISOString(),
      };
    } finally {
      clearTimeout(timeoutId);
    }
  };
  const persistHistoryCloud = async (items) => {
    if (!cloudUserId || !items.length) return;
    const payload = items.map((item) => ({
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
    try {
      await apiRequest('/api/request-history/bulk', {
        method: 'POST',
        internalUser: cloudUserId,
        body: { items: payload },
      });
    } catch (error) {
      setAuthMessage(error.message || 'Gagal menyimpan history ke database.');
      await showPopup({
        icon: 'error',
        title: 'Gagal Simpan History',
        text: error.message || 'Terjadi kesalahan saat menyimpan history.',
      });
    }
  };

  const saveToHistory = async (items) => {
    if (!settings.autoSaveHistory) return;
    const normalized = Array.isArray(items) ? items : [items];
    setHistory((previous) => [...normalized, ...previous].slice(0, settings.maxHistory));
    await persistHistoryCloud(normalized);
  };

  const handleSendSingle = async () => {
    if (!url.trim()) {
      setErrorMessage('URL wajib diisi.');
      await showPopup({
        icon: 'warning',
        title: 'URL Wajib',
        text: 'Mohon isi URL request terlebih dahulu.',
      });
      return;
    }
    setIsLoading(true);
    setErrorMessage('');
    setResponseData('');
    setResponseHeaders({});
    setResponseStatus('-');
    setResponseTime('-');
    setResponseSize('-');

    const result = await executeRequest({
      name: requestName,
      method,
      url,
      headers: headersText,
      body,
      bodyMode,
      ...applyAuthToRequest(
        { method, url, headers: headersText, body },
        {
          type: authType,
          bearerToken,
          basicUsername,
          basicPassword,
          apiKeyName,
          apiKeyValue,
          apiKeyIn,
        }
      ),
    });

    setResponseStatus(result.status);
    setResponseTime(result.time);
    setResponseSize(result.size);
    setResponseHeaders(result.responseHeaders);
    setResponseData(result.responseBody);
    if (!result.ok && result.statusCode === 0) {
      setErrorMessage(result.responseBody);
      await showPopup({
        icon: 'error',
        title: 'Request Gagal',
        text: result.responseBody,
      });
    }
    await saveToHistory(result);
    setIsLoading(false);
  };

  const handleSaveCollection = async () => {
    if (!url.trim()) {
      setCollectionNotice('Tidak bisa simpan: URL masih kosong.');
      await showPopup({
        icon: 'warning',
        title: 'URL Wajib',
        text: 'Tidak bisa save collection karena URL masih kosong.',
      });
      return;
    }
    const requestWithAuth = applyAuthToRequest(
      { method, url: url.trim(), headers: headersText, body },
      {
        type: authType,
        bearerToken,
        basicUsername,
        basicPassword,
        apiKeyName,
        apiKeyValue,
        apiKeyIn,
      }
    );
    const basePayload = {
      name: requestName.trim() || `Request ${collections.length + 1}`,
      method: method.toUpperCase(),
      url: requestWithAuth.url,
      headers: requestWithAuth.headers,
      body,
      bodyMode,
    };

    if (loadedCollectionId) {
      setCollections((previous) =>
        previous.map((item) => (item.id === loadedCollectionId ? { ...item, ...basePayload } : item))
      );

      if (cloudUserId) {
        try {
          const data = await apiRequest(`/api/collection-items/${loadedCollectionId}`, {
            method: 'PUT',
            internalUser: cloudUserId,
            body: {
              name: basePayload.name,
              method: basePayload.method,
              url: basePayload.url,
              headers: basePayload.headers,
              body: basePayload.body,
            },
          });
          setCollections((previous) =>
            previous.map((item) => (item.id === loadedCollectionId ? mapItemRow(data) : item))
          );
        } catch (error) {
          setAuthMessage(error.message || 'Gagal update collection.');
          await showPopup({
            icon: 'error',
            title: 'Gagal Update Collection',
            text: error.message || 'Terjadi kesalahan saat update collection.',
          });
          return;
        }
      }

      setCollectionNotice(`Perubahan "${basePayload.name}" berhasil disimpan.`);
      await showPopup({
        icon: 'success',
        title: 'Collection Updated',
        text: 'Perubahan request berhasil disimpan ke item yang sama.',
      });
      return;
    }

    const newItem = {
      id: crypto.randomUUID(),
      collectionId: defaultCollectionId,
      ...basePayload,
      createdAt: new Date().toISOString(),
    };

    setCollections((previous) => [newItem, ...previous]);
    setLoadedCollectionId(newItem.id);
    setCollectionNotice('Request berhasil disimpan ke Collections.');

    if (!cloudUserId) {
      await showPopup({
        icon: 'success',
        title: 'Collection Tersimpan',
        text: `${newItem.name} berhasil ditambahkan ke collections.`,
      });
      return;
    }

    try {
      const chosenCollectionId = defaultCollectionId || (await ensureDefaultCollection(cloudUserId));
      setDefaultCollectionId(chosenCollectionId);
      const data = await apiRequest('/api/collection-items', {
        method: 'POST',
        internalUser: cloudUserId,
        body: {
          collectionId: chosenCollectionId,
          name: newItem.name,
          method: newItem.method,
          url: newItem.url,
          headers: newItem.headers,
          body: newItem.body,
        },
      });
      setCollections((previous) => [mapItemRow(data), ...previous.filter((x) => x.id !== newItem.id)]);
      setLoadedCollectionId(data.id);
      await showPopup({
        icon: 'success',
        title: 'Collection Tersimpan',
        text: `${newItem.name} berhasil ditambahkan ke collections.`,
      });
    } catch (error) {
      setAuthMessage(error.message || 'Gagal simpan collection ke database.');
      await showPopup({
        icon: 'error',
        title: 'Gagal Simpan Collection',
        text: error.message || 'Terjadi kesalahan saat menyimpan collection.',
      });
    }
  };

  const handleLoadCollection = (item) => {
    const authState = hydrateAuthFromHeaders(item.headers || '');
    setLoadedCollectionId(item.id || null);
    setRequestName(item.name);
    setMethod(item.method);
    setUrl(item.url);
    setHeadersText(item.headers || '');
    setBody(item.body || '');
    setBodyMode(item.bodyMode || inferBodyModeFromRequest(item.headers || '', item.body || ''));
    setAuthType(authState.authType);
    setBearerToken(authState.bearerToken);
    setBasicUsername(authState.basicUsername);
    setBasicPassword(authState.basicPassword);
    resetResponsePanel();
    setActiveMenu('Request Builder');
    setCollectionNotice(`Loaded: ${item.name}`);
  };

  const handleDeleteCollection = async (id) => {
    try {
      const item = collections.find((entry) => entry.id === id);
      const itemName = item?.name || 'API';
      const confirmed = await showConfirmPopup({
        title: 'Hapus API?',
        text: `API "${itemName}" akan dihapus dari collection.`,
        confirmButtonText: 'Ya, hapus',
      });
      if (!confirmed) return;

      if (cloudUserId) {
        await apiRequest(`/api/collection-items/${id}`, {
          method: 'DELETE',
          internalUser: cloudUserId,
        });
      }

      setCollections((previous) => previous.filter((entry) => entry.id !== id));
      if (loadedCollectionId === id) {
        setLoadedCollectionId(null);
      }
      setCollectionNotice(`API "${itemName}" berhasil dihapus.`);
      await showPopup({
        icon: 'success',
        title: 'Delete Berhasil',
        text: `API "${itemName}" berhasil dihapus.`,
      });
    } catch (error) {
      setAuthMessage(error.message || 'Gagal hapus collection item.');
      await showPopup({
        icon: 'error',
        title: 'Gagal Hapus Item',
        text: error.message || 'Terjadi kesalahan saat menghapus collection item.',
      });
    }
  };

  const handleExportCsv = () => {
    if (!collections.length) {
      setCollectionNotice('Collections masih kosong, tidak ada data untuk export.');
      showPopup({
        icon: 'warning',
        title: 'Data Kosong',
        text: 'Collections masih kosong, tidak ada data untuk export.',
      });
      return;
    }
    const csv = buildCsv(collections);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const blobUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = `support-tools-mso5-collections-${new Date()
      .toISOString()
      .slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(blobUrl);
    setCollectionNotice('Collections berhasil diexport ke CSV.');
    showPopup({
      icon: 'success',
      title: 'Export Berhasil',
      text: 'Collections berhasil diexport ke file CSV.',
    });
  };

  const handleExportJson = () => {
    if (!collections.length) {
      setCollectionNotice('Collections masih kosong, tidak ada data untuk export.');
      showPopup({
        icon: 'warning',
        title: 'Data Kosong',
        text: 'Collections masih kosong, tidak ada data untuk export.',
      });
      return;
    }

    const postmanCollection = {
      info: {
        name: 'Support Tools MSO 5 Collection',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
      item: collections.map((item) => ({
        name: item.name,
        request: {
          method: item.method,
          header: headersTextToArray(item.headers || ''),
          body: {
            mode: item.bodyMode === 'form' ? 'urlencoded' : 'raw',
            raw: item.body || '',
          },
          url: item.url,
        },
      })),
    };

    const json = JSON.stringify(postmanCollection, null, 2);
    const blob = new Blob([json], { type: 'application/json;charset=utf-8;' });
    const blobUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = `support-tools-mso5-collections-${new Date()
      .toISOString()
      .slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(blobUrl);
    setCollectionNotice('Collections berhasil diexport ke JSON.');
    showPopup({
      icon: 'success',
      title: 'Export JSON Berhasil',
      text: 'Collections berhasil diexport ke format JSON.',
    });
  };

  const handleImportJson = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const rawText = await file.text();

    try {
      const parsed = JSON.parse(rawText);
      const sourceItems = Array.isArray(parsed?.item)
        ? parsed.item
        : Array.isArray(parsed)
        ? parsed
        : [];

      const imported = sourceItems
        .map((entry, index) => {
          const request = entry.request || entry;
          const methodValue = (request.method || 'GET').toUpperCase();
          const safeMethod = METHODS.includes(methodValue) ? methodValue : 'GET';
          const urlValue =
            typeof request.url === 'string'
              ? request.url
              : request.url?.raw || request.url?.toString?.() || '';
          const finalUrl = String(urlValue).trim();
          if (!finalUrl) return null;
          const rawBody = request.body?.raw || request.body || '';
          const importedMode = String(request.body?.mode || '').toLowerCase();
          const bodyModeValue =
            importedMode === 'urlencoded'
              ? 'form'
              : importedMode === 'raw'
              ? inferBodyModeFromRequest(headersArrayToText(request.header), rawBody)
              : inferBodyModeFromRequest(headersArrayToText(request.header), rawBody);

          return {
            id: crypto.randomUUID(),
            collectionId: defaultCollectionId,
            name: (entry.name || request.name || `Imported JSON ${index + 1}`).trim(),
            method: safeMethod,
            url: finalUrl,
            headers: headersArrayToText(request.header),
            body: typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody, null, 2),
            bodyMode: bodyModeValue,
            createdAt: new Date().toISOString(),
          };
        })
        .filter(Boolean);

      if (!imported.length) {
        await showPopup({
          icon: 'warning',
          title: 'Import JSON Gagal',
          text: 'Tidak ada request valid di file JSON.',
        });
        event.target.value = '';
        return;
      }

      setCollections((previous) => [...imported, ...previous]);
      setCollectionNotice(`Import JSON sukses: ${imported.length} request.`);
      await showPopup({
        icon: 'success',
        title: 'Import JSON Berhasil',
        text: `${imported.length} request berhasil diimport.`,
      });

      if (cloudUserId) {
        const chosenCollectionId = defaultCollectionId || (await ensureDefaultCollection(cloudUserId));
        setDefaultCollectionId(chosenCollectionId);
        const payload = imported.map((item) => ({
          name: item.name,
          method: item.method,
          url: item.url,
          headers: item.headers,
          body: item.body,
        }));
        const data = await apiRequest('/api/collection-items/bulk', {
          method: 'POST',
          internalUser: cloudUserId,
          body: { collectionId: chosenCollectionId, items: payload },
        });
        setCollections((previous) => [
          ...(data || []).map(mapItemRow),
          ...previous.filter((item) => !imported.find((it) => it.id === item.id)),
        ]);
      }
    } catch (error) {
      await showPopup({
        icon: 'error',
        title: 'Import JSON Gagal',
        text: error.message || 'Format JSON tidak valid.',
      });
    } finally {
      event.target.value = '';
    }
  };

  const handleRunnerCsvUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const rawText = await file.text();
    const parsedRows = parseCsvObjects(rawText);
    if (!parsedRows.length) {
      await showPopup({
        icon: 'error',
        title: 'Runner CSV Gagal',
        text: 'CSV kosong atau format tidak valid.',
      });
      event.target.value = '';
      return;
    }

    setRunnerCsvRows(parsedRows);
    setRunnerCsvName(file.name);
    setCollectionNotice(`Runner CSV loaded: ${file.name} (${parsedRows.length} row).`);
    await showPopup({
      icon: 'success',
      title: 'Runner CSV Loaded',
      text: `${file.name} siap dipakai dengan ${parsedRows.length} row.`,
    });
    event.target.value = '';
  };

  const toggleRunnerSelection = (id) => {
    setRunnerSelectedIds((previous) =>
      previous.includes(id) ? previous.filter((value) => value !== id) : [...previous, id]
    );
  };

  const handleSelectAllRunner = () => {
    setRunnerSelectedIds(collections.map((item) => item.id));
  };

  const handleClearRunnerSelection = () => {
    setRunnerSelectedIds([]);
  };

  const handleImportCsv = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const text = await file.text();
    const rows = parseCsv(text);
    if (!rows.length) {
      setCollectionNotice('File CSV kosong atau format tidak valid.');
      await showPopup({
        icon: 'error',
        title: 'Import Gagal',
        text: 'File CSV kosong atau format tidak valid.',
      });
      event.target.value = '';
      return;
    }

    const [headerRow, ...dataRows] = rows;
    const headerIndex = {
      name: headerRow.findIndex((h) => h.trim().toLowerCase() === 'name'),
      method: headerRow.findIndex((h) => h.trim().toLowerCase() === 'method'),
      url: headerRow.findIndex((h) => h.trim().toLowerCase() === 'url'),
      headers: headerRow.findIndex((h) => h.trim().toLowerCase() === 'headers'),
      body: headerRow.findIndex((h) => h.trim().toLowerCase() === 'body'),
    };

    if (headerIndex.method === -1 || headerIndex.url === -1) {
      setCollectionNotice(
        'CSV wajib punya kolom minimal: method,url (opsional: name,headers,body).'
      );
      await showPopup({
        icon: 'error',
        title: 'Format CSV Salah',
        text: 'CSV wajib memiliki kolom method dan url.',
      });
      event.target.value = '';
      return;
    }

    const imported = dataRows
      .map((columns, index) => {
        const methodValue = (columns[headerIndex.method] || 'GET').toUpperCase();
        const safeMethod = METHODS.includes(methodValue) ? methodValue : 'GET';
        const urlValue = (columns[headerIndex.url] || '').trim();
        if (!urlValue) return null;
        return {
          id: crypto.randomUUID(),
          collectionId: defaultCollectionId,
          name:
            (headerIndex.name > -1 ? columns[headerIndex.name] : '').trim() ||
            `Imported ${index + 1}`,
          method: safeMethod,
          url: urlValue,
          headers: headerIndex.headers > -1 ? columns[headerIndex.headers] || '' : '',
          body: headerIndex.body > -1 ? columns[headerIndex.body] || '' : '',
          createdAt: new Date().toISOString(),
        };
      })
      .filter(Boolean);
    if (!imported.length) {
      setCollectionNotice('Tidak ada data request valid yang bisa diimport.');
      await showPopup({
        icon: 'warning',
        title: 'Tidak Ada Data Valid',
        text: 'Tidak ada request valid yang bisa diimport dari file CSV.',
      });
      event.target.value = '';
      return;
    }

    setCollections((previous) => [...imported, ...previous]);
    setCollectionNotice(`Import sukses: ${imported.length} request.`);
    await showPopup({
      icon: 'success',
      title: 'Import Berhasil',
      text: `${imported.length} request berhasil diimport.`,
    });

    if (cloudUserId) {
      try {
        const chosenCollectionId = defaultCollectionId || (await ensureDefaultCollection(cloudUserId));
        setDefaultCollectionId(chosenCollectionId);
        const payload = imported.map((item) => ({
          name: item.name,
          method: item.method,
          url: item.url,
          headers: item.headers,
          body: item.body,
        }));
        const data = await apiRequest('/api/collection-items/bulk', {
          method: 'POST',
          internalUser: cloudUserId,
          body: { collectionId: chosenCollectionId, items: payload },
        });
        setCollections((previous) => [
          ...(data || []).map(mapItemRow),
          ...previous.filter((item) => !imported.find((it) => it.id === item.id)),
        ]);
      } catch (error) {
        setAuthMessage(error.message || 'Import CSV lokal sukses, tapi sync database gagal.');
        await showPopup({
          icon: 'warning',
          title: 'Import Lokal Sukses',
          text: error.message || 'Sync ke Supabase gagal, tapi data tersimpan lokal.',
        });
      }
    }

    event.target.value = '';
  };

  const handleRunCollections = async () => {
    if (cloudUserId && !collectionsLoaded) {
      await fetchCollectionsCloud(cloudUserId, true);
    }
    if (!collections.length) {
      setCollectionNotice('Collections kosong. Tambahkan request dulu.');
      await showPopup({
        icon: 'warning',
        title: 'Collections Kosong',
        text: 'Tambahkan request dulu sebelum Run All.',
      });
      return;
    }

    const selectedRequests = runnerSelectedIds.length
      ? collections.filter((item) => runnerSelectedIds.includes(item.id))
      : [];
    if (!selectedRequests.length) {
      await showPopup({
        icon: 'warning',
        title: 'Pilih API Runner',
        text: 'Pilih minimal 1 API di collections untuk dijalankan.',
      });
      return;
    }

    setRunnerLoading(true);
    setRunnerResults([]);
    setActiveRunnerResultKey(null);
    const iterations = runnerCsvRows.length ? runnerCsvRows : [{}];
    setCollectionNotice(
      `Runner berjalan (${selectedRequests.length} API x ${iterations.length} iterasi)...`
    );

    const results = await withLoadingPopup('Menjalankan API runner...', async () => {
      const all = [];
      for (let rowIndex = 0; rowIndex < iterations.length; rowIndex += 1) {
        const rowVars = iterations[rowIndex] || {};
        const runtimeVars = { ...rowVars };

        for (let requestIndex = 0; requestIndex < selectedRequests.length; requestIndex += 1) {
          const item = selectedRequests[requestIndex];
          const mergedVars = {
            ...runtimeVars,
            scmt_token: runtimeVars.scmt_token || '',
            access_token: runtimeVars.access_token || '',
          };
          const renderedRequest = {
            name: `${item.name} [${rowIndex + 1}]`,
            method: interpolateTemplate(item.method, mergedVars),
            url: interpolateTemplate(item.url, mergedVars),
            headers: interpolateTemplate(item.headers || '', mergedVars),
            body: interpolateTemplate(item.body || '', mergedVars),
            bodyMode: inferBodyModeFromRequest(item.headers || '', item.body || ''),
          };

          const result = await executeRequest(renderedRequest);
          all.push(result);

          try {
            const payload = JSON.parse(result.responseBody || '{}');
            if (payload?.access_token) {
              runtimeVars.access_token = payload.access_token;
              runtimeVars.scmt_token = payload.access_token;
            }
          } catch (error) {
            // Ignore non-json body
          }
        }
      }
      return all;
    });

    setRunnerResults(results);
    await saveToHistory(results);
    setRunnerLoading(false);
    setCollectionNotice(
      `Runner selesai. ${selectedRequests.length} API, ${iterations.length} iterasi, total ${results.length} request.`
    );
    await showPopup({
      icon: 'success',
      title: 'Runner Selesai',
      text: `${selectedRequests.length} API dijalankan dengan ${iterations.length} iterasi.`,
    });
  };

  const handleClearHistory = async () => {
    const confirmed = await showConfirmPopup({
      title: 'Clear History?',
      text: 'Semua riwayat request akan dihapus permanen.',
      confirmButtonText: 'Ya, hapus',
    });
    if (!confirmed) return;

    setHistory([]);
    if (!cloudUserId) {
      await showPopup({
        icon: 'success',
        title: 'History Dibersihkan',
        text: 'Semua history lokal berhasil dihapus.',
      });
      return;
    }
    try {
      await apiRequest('/api/request-history', {
        method: 'DELETE',
        internalUser: cloudUserId,
      });
    } catch (error) {
      setAuthMessage(error.message || 'Gagal clear history di database.');
      await showPopup({
        icon: 'error',
        title: 'Clear History Gagal',
        text: error.message || 'Terjadi kesalahan saat menghapus history.',
      });
      return;
    }
    await showPopup({
      icon: 'success',
      title: 'History Dibersihkan',
      text: 'Semua history berhasil dihapus.',
    });
  };

  const handleInternalLogin = async (event) => {
    event.preventDefault();
    if (!internalUsername.trim() || !internalPassword.trim()) {
      setInternalAuthError('Username dan password wajib diisi.');
      return;
    }
    if (!supabase) {
      setInternalAuthError('Supabase belum aktif.');
      return;
    }

    setInternalAuthLoading(true);
    setInternalAuthError('');

    try {
      const data = await withLoadingPopup('Memverifikasi akun internal...', async () =>
        apiRequest('/api/internal/login', {
          method: 'POST',
          body: {
            username: internalUsername.trim(),
            password: internalPassword,
          },
        })
      );

      const token = createInternalJwt(data.username);
      const payload = parseInternalJwt(token);
      localStorage.setItem(STORAGE_KEYS.internalSession, token);
      setInternalUser(data.username);
      setInternalSessionExp(payload?.exp || null);
      setInternalAuthError('');
      await showPopup({
        icon: 'success',
        title: 'Login Berhasil',
        text: 'Selamat datang di Support Tools MSO 5.',
      });
    } catch (error) {
      setInternalAuthError(error.message || 'Gagal login internal.');
      await showPopup({
        icon: 'error',
        title: 'Login Gagal',
        text: error.message || 'Terjadi kesalahan saat login internal.',
      });
    } finally {
      setInternalAuthLoading(false);
    }
  };

  const handleInternalLogout = async () => {
    const confirmed = await showConfirmPopup({
      title: 'Logout Internal?',
      text: 'Sesi internal akan dihapus dan Anda kembali ke halaman login.',
      confirmButtonText: 'Ya, logout',
    });
    if (!confirmed) return;

    localStorage.removeItem(STORAGE_KEYS.internalSession);
    setInternalUser(null);
    setInternalSessionExp(null);
    setInternalAuthError('');
    setInternalUsername('');
    setInternalPassword('');
    setShowInternalPassword(false);
  };

  const renderInternalLoginPage = () => (
    <div className="login-shell">
      <div className="login-card">
        <h1>Support Tools MSO 5</h1>
        <p>Internal Access Required</p>
        <form onSubmit={handleInternalLogin} className="login-form" autoComplete="on">
          <label>
            Username
            <input
              type="text"
              name="username"
              autoComplete="username"
              value={internalUsername}
              onChange={(event) => setInternalUsername(event.target.value)}
            />
          </label>
          <label>
            Password
            <div className="password-input-wrap">
              <input
                type={showInternalPassword ? 'text' : 'password'}
                name="password"
                autoComplete="current-password"
                value={internalPassword}
                onChange={(event) => setInternalPassword(event.target.value)}
              />
              <button
                type="button"
                className="password-toggle-btn"
                onClick={() => setShowInternalPassword((previous) => !previous)}
                aria-label={showInternalPassword ? 'Hide password' : 'Show password'}
                title={showInternalPassword ? 'Hide password' : 'Show password'}
              >
                {showInternalPassword ? (
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M3 4.2L4.2 3 21 19.8 19.8 21l-3.1-3.1c-1.5.7-3 .9-4.7.9-5.4 0-9.5-3.8-11-6.8.8-1.6 2.4-3.8 4.6-5.2L3 4.2zm6.3 6.3a3.5 3.5 0 004.2 4.2l-4.2-4.2zM12 7.2c1.9 0 3.5 1.6 3.5 3.5 0 .6-.1 1.1-.4 1.6l2.7 2.7c1.6-1.1 2.8-2.6 3.5-4-1.4-2.6-5-5.8-9.3-5.8-1.2 0-2.4.2-3.5.6L10.4 7c.5-.2 1-.3 1.6-.3z" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M12 5c5.4 0 9.5 3.8 11 6.8-1.5 3-5.6 6.8-11 6.8S2.5 14.8 1 11.8C2.5 8.8 6.6 5 12 5zm0 2C7.8 7 4.5 9.9 3.2 11.8 4.5 13.7 7.8 16.6 12 16.6s7.5-2.9 8.8-4.8C19.5 9.9 16.2 7 12 7zm0 1.8a3 3 0 110 6 3 3 0 010-6z" />
                  </svg>
                )}
              </button>
            </div>
          </label>
          <button type="submit" className="send-btn login-submit" disabled={internalAuthLoading}>
            {internalAuthLoading ? 'Checking...' : 'Login'}
          </button>
        </form>
        <p className="hint-text">Session token berlaku 6 jam per login.</p>
        {internalAuthError && <p className="error-message">{internalAuthError}</p>}
      </div>
    </div>
  );

  if (!internalReady) {
    return (
      <div className="login-shell">
        <div className="login-card">
          <h1>Support Tools MSO 5</h1>
          <p>Memeriksa session...</p>
        </div>
      </div>
    );
  }

  if (!internalUser) {
    return renderInternalLoginPage();
  }

  const renderRequestBuilder = () => (
    <>
      <section className="request-panel glass">
        <div className="request-headline">
          <h3>Request Builder</h3>
          <input
            className="name-input"
            value={requestName}
            onChange={(event) => setRequestName(event.target.value)}
            placeholder="Nama request..."
          />
        </div>

        <div className="request-row">
          <select
            value={method}
            onChange={(event) => setMethod(event.target.value)}
            className={`method-select ${methodClassName}`}
          >
            {METHODS.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>

          <input
            type="text"
            className="url-input"
            placeholder="https://api.example.com/users"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />

          <button
            type="button"
            className={`send-btn ${isLoading ? 'loading' : ''}`}
            onClick={handleSendSingle}
            disabled={isLoading}
          >
            {isLoading ? 'Sending...' : 'Send'}
          </button>
        </div>

        <div className="request-action-row">
          <button type="button" className="ghost-btn" onClick={handleSaveCollection}>
            {loadedCollectionId ? 'Save Changes' : 'Save to Collection'}
          </button>
        </div>

        <div className="auth-panel-inline">
          <div className="auth-panel-head">
            <h3>Auth</h3>
            <select
              className="auth-type-select"
              value={authType}
              onChange={(event) => setAuthType(event.target.value)}
            >
              <option value="none">None</option>
              <option value="bearer">Bearer Token</option>
              <option value="basic">Basic Auth</option>
              <option value="apikey">API Key</option>
            </select>
          </div>

          {authType === 'bearer' && (
            <input
              type="text"
              value={bearerToken}
              onChange={(event) => setBearerToken(event.target.value)}
              placeholder="Masukkan token bearer..."
            />
          )}

          {authType === 'basic' && (
            <div className="auth-inline-grid">
              <input
                type="text"
                value={basicUsername}
                onChange={(event) => setBasicUsername(event.target.value)}
                placeholder="Basic username"
              />
              <input
                type="password"
                value={basicPassword}
                onChange={(event) => setBasicPassword(event.target.value)}
                placeholder="Basic password"
              />
            </div>
          )}

          {authType === 'apikey' && (
            <div className="auth-inline-grid">
              <input
                type="text"
                value={apiKeyName}
                onChange={(event) => setApiKeyName(event.target.value)}
                placeholder="API Key name"
              />
              <input
                type="text"
                value={apiKeyValue}
                onChange={(event) => setApiKeyValue(event.target.value)}
                placeholder="API Key value"
              />
              <select
                className="auth-type-select"
                value={apiKeyIn}
                onChange={(event) => setApiKeyIn(event.target.value)}
              >
                <option value="header">Send in Header</option>
                <option value="query">Send in Query</option>
              </select>
            </div>
          )}
        </div>

        <div className="editor-grid">
          <div className="editor-card">
            <h3>Headers</h3>
            <textarea
              value={headersText}
              onChange={(event) => setHeadersText(event.target.value)}
              placeholder="Authorization: Bearer token"
            />
          </div>
          <div className="editor-card">
            <div className="editor-card-head">
              <h3>Body</h3>
              <select value={bodyMode} onChange={(event) => setBodyMode(event.target.value)}>
                <option value="raw">raw (Text)</option>
                <option value="json">raw (JSON)</option>
                <option value="form">x-www-form-urlencoded</option>
              </select>
            </div>
            <textarea
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder={
                bodyMode === 'form'
                  ? 'grant_type=client_credentials\nclient_id=xxx\nclient_secret=yyy'
                  : '{"name":"John"}'
              }
            />
          </div>
        </div>

        {errorMessage && <p className="error-message">{errorMessage}</p>}
        {collectionNotice && <p className="info-message">{collectionNotice}</p>}
      </section>

      <section className="response-panel glass">
        <div className="response-meta">
          <div>
            <span>Status</span>
            <strong>{responseStatus}</strong>
          </div>
          <div>
            <span>Time</span>
            <strong>{responseTime}</strong>
          </div>
          <div>
            <span>Size</span>
            <strong>{responseSize}</strong>
          </div>
        </div>

        <div className="response-grid">
          <div className="response-box">
            <h3>Response Body</h3>
            <pre>{responseData || 'Belum ada response.'}</pre>
          </div>
          <div className="response-box">
            <h3>Response Headers</h3>
            <pre>
              {Object.keys(responseHeaders).length
                ? prettyData(responseHeaders)
                : 'Belum ada response headers.'}
            </pre>
          </div>
        </div>
      </section>
    </>
  );

  const renderCollections = () => (
    <section className="request-panel glass">
      <div className="panel-title-row">
        <h3>Collections</h3>
        <div className="toolbar">
          <button type="button" className="ghost-btn" onClick={() => fileInputRef.current?.click()}>
            Import CSV Requests
          </button>
          <button type="button" className="ghost-btn" onClick={() => jsonImportRef.current?.click()}>
            Import JSON
          </button>
          <button type="button" className="ghost-btn" onClick={handleExportCsv}>
            Export CSV
          </button>
          <button type="button" className="ghost-btn" onClick={handleExportJson}>
            Export JSON
          </button>
          <button type="button" className="ghost-btn" onClick={() => runnerCsvRef.current?.click()}>
            Upload Runner CSV (Use locally)
          </button>
          <button
            type="button"
            className={`send-btn compact ${runnerLoading ? 'loading' : ''}`}
            onClick={handleRunCollections}
            disabled={runnerLoading}
          >
            {runnerLoading ? 'Running...' : 'Run Selected'}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden-file-input"
            onChange={handleImportCsv}
          />
          <input
            ref={jsonImportRef}
            type="file"
            accept=".json,application/json"
            className="hidden-file-input"
            onChange={handleImportJson}
          />
          <input
            ref={runnerCsvRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden-file-input"
            onChange={handleRunnerCsvUpload}
          />
        </div>
      </div>

      <p className="hint-text">
        Request CSV format: <code>name,method,url,headers,body</code>. Runner CSV bisa pakai kolom
        bebas untuk variable <code>{'{{kolom}}'}</code> pada URL/header/body.
      </p>
      <div className="runner-config">
        <div className="runner-config-row">
          <strong>Runner data file:</strong>{' '}
          <span>{runnerCsvName ? `${runnerCsvName} (${runnerCsvRows.length} row)` : 'Belum ada'}</span>
        </div>
        <div className="runner-config-row">
          <button type="button" className="ghost-btn" onClick={handleSelectAllRunner}>
            Select All API
          </button>
          <button type="button" className="ghost-btn" onClick={handleClearRunnerSelection}>
            Clear Selection
          </button>
        </div>
      </div>
      {collectionNotice && <p className="info-message">{collectionNotice}</p>}

      <div className="list-wrap">
        {collectionsLoading ? (
          <p className="empty-state">Loading collections...</p>
        ) : collections.length ? (
          collections.map((item) => (
            <article key={item.id} className="list-card">
              <div>
                <label className="runner-select-row">
                  <input
                    type="checkbox"
                    checked={runnerSelectedIds.includes(item.id)}
                    onChange={() => toggleRunnerSelection(item.id)}
                  />
                  <span>Pilih untuk runner</span>
                </label>
                <h4>{item.name}</h4>
                <p>
                  <span className={`method-pill ${item.method.toLowerCase()}`}>{item.method}</span>{' '}
                  {item.url}
                </p>
                {loadedCollectionId === item.id && (
                  <p className="hint-text">Item ini sedang aktif di Request Builder.</p>
                )}
              </div>
              <div className="card-actions">
                <button type="button" className="ghost-btn" onClick={() => handleLoadCollection(item)}>
                  Load
                </button>
                <button
                  type="button"
                  className="danger-btn"
                  onClick={() => handleDeleteCollection(item.id)}
                >
                  Delete
                </button>
              </div>
            </article>
          ))
        ) : (
          <p className="empty-state">Belum ada collection.</p>
        )}
      </div>

      <div className="runner-results">
        <h3>Runner Results</h3>
        {runnerResults.length ? (
          runnerResults.map((result, index) => {
            const resultKey = `${result.url}-${index}`;
            const isOpen = activeRunnerResultKey === resultKey;
            return (
              <article key={resultKey} className="runner-item">
                <p>
                  <strong>{result.name}</strong> | {result.method} | {result.url}
                </p>
                <p>
                  Status: <span>{result.status}</span> | Time: <span>{result.time}</span> | Size:{' '}
                  <span>{result.size}</span>
                </p>
                <div className="card-actions">
                  <button
                    type="button"
                    className="ghost-btn"
                    onClick={() => setActiveRunnerResultKey(isOpen ? null : resultKey)}
                  >
                    {isOpen ? 'Hide Detail' : 'View Detail'}
                  </button>
                </div>
                {isOpen && (
                  <div className="runner-detail-grid">
                    <div className="response-box">
                      <h3>Response Body</h3>
                      <pre>{result.responseBody || 'No response body'}</pre>
                    </div>
                    <div className="response-box">
                      <h3>Response Headers</h3>
                      <pre>{prettyData(result.responseHeaders || {})}</pre>
                    </div>
                    <div className="response-box">
                      <h3>Request Sent</h3>
                      <pre>
                        {prettyData({
                          method: result.method,
                          url: result.url,
                          headers: parseHeaders(result.requestHeaders || ''),
                          body: result.requestBody || '',
                        })}
                      </pre>
                    </div>
                  </div>
                )}
              </article>
            );
          })
        ) : (
          <p className="empty-state">Belum ada hasil runner.</p>
        )}
      </div>
    </section>
  );
  const renderHistory = () => (
    <section className="request-panel glass">
      <div className="panel-title-row">
        <h3>History</h3>
        <button type="button" className="ghost-btn" onClick={handleClearHistory}>
          Clear History
        </button>
      </div>
      <div className="list-wrap">
        {historyLoading ? (
          <p className="empty-state">Loading history...</p>
        ) : history.length ? (
          history.map((item, index) => (
            <article key={`${item.createdAt}-${index}`} className="list-card">
              <div>
                <h4>{item.name}</h4>
                <p>
                  <span className={`method-pill ${item.method.toLowerCase()}`}>{item.method}</span>{' '}
                  {item.url}
                </p>
                <p>
                  {item.status} | {item.time} | {item.size}
                </p>
              </div>
              <div className="card-actions">
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={() =>
                    handleLoadCollection({
                      name: item.name,
                      method: item.method,
                      url: item.url,
                      headers: item.requestHeaders || '',
                      body: item.requestBody || '',
                    })
                  }
                >
                  Use Again
                </button>
              </div>
            </article>
          ))
        ) : (
          <p className="empty-state">Belum ada history request.</p>
        )}
      </div>
    </section>
  );

  const renderSettings = () => (
    <section className="request-panel glass">
      <h3>Settings</h3>
      <div className="settings-grid">
        <label>
          Request Timeout (ms)
          <input
            type="number"
            min="1000"
            value={settings.timeoutMs}
            onChange={(event) =>
              setSettings((previous) => ({
                ...previous,
                timeoutMs: Number(event.target.value || 15000),
              }))
            }
          />
        </label>
        <label>
          Max History
          <input
            type="number"
            min="10"
            value={settings.maxHistory}
            onChange={(event) =>
              setSettings((previous) => ({
                ...previous,
                maxHistory: Number(event.target.value || 50),
              }))
            }
          />
        </label>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={settings.autoSaveHistory}
            onChange={(event) =>
              setSettings((previous) => ({
                ...previous,
                autoSaveHistory: event.target.checked,
              }))
            }
          />
          Auto Save History
        </label>
      </div>

      <div className="supabase-note auth-panel">
        <h4>Cloud Sync</h4>
        <p>Sinkronisasi collections dan history ke database cloud.</p>
        <div className="auth-actions">
          <button
            type="button"
            className="ghost-btn"
            onClick={() => cloudUserId && refreshCloudData(cloudUserId)}
            disabled={!cloudUserId || syncLoading}
          >
            {syncLoading ? 'Syncing...' : 'Sync Now'}
          </button>
        </div>
        {authMessage && <p className="info-message">{authMessage}</p>}
      </div>
    </section>
  );

  return (
    <div className="dashboard-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-dot" />
          <div>
            <h1>MSO 5</h1>
            <p>API Support Workspace</p>
          </div>
        </div>

        <nav className="menu-list">
          {['Request Builder', 'Collections', 'History', 'Settings'].map((item) => (
            <button
              key={item}
              className={`menu-item ${activeMenu === item ? 'active' : ''}`}
              onClick={() => setActiveMenu(item)}
              type="button"
            >
              {item}
            </button>
          ))}
        </nav>

        <div className="sidebar-card">
          <h2>Quick Endpoints</h2>
          {QUICK_ENDPOINTS.map((preset) => (
            <button
              key={preset.label}
              className="preset-btn"
              onClick={() => applyPreset(preset)}
              type="button"
            >
              {preset.label}
            </button>
          ))}
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="title-wrap">
            <h2>Support Tools MSO 5</h2>
            <p>Runner API massal + collections CSV + request history.</p>
          </div>
          <div className="topbar-actions">
            <div className="topbar-badge">{`Account: ${internalUser}`}</div>
            <button type="button" className="ghost-btn" onClick={handleInternalLogout}>
              Logout
            </button>
          </div>
        </header>

        {activeMenu === 'Request Builder' && renderRequestBuilder()}
        {activeMenu === 'Collections' && renderCollections()}
        {activeMenu === 'History' && renderHistory()}
        {activeMenu === 'Settings' && renderSettings()}
      </main>
    </div>
  );
}

export default App;
