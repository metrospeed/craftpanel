// REST + WebSocket client.

async function request(method, url, body, { raw = false } = {}) {
  const opts = { method, headers: { 'X-CP-Request': '1' }, credentials: 'same-origin' };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (raw) return res;
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('/api/auth')) window.dispatchEvent(new Event('cp:unauthorized'));
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  get: (url) => request('GET', url),
  post: (url, body) => request('POST', url, body ?? {}),
  put: (url, body) => request('PUT', url, body ?? {}),
  patch: (url, body) => request('PATCH', url, body ?? {}),
  del: (url) => request('DELETE', url),
  upload: (url, files, onProgress, fields = {}) =>
    new Promise((resolve, reject) => {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.append(k, v);
      for (const f of files) form.append('files', f, f.relativePath || f.webkitRelativePath || f.name);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      xhr.setRequestHeader('X-CP-Request', '1');
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
      xhr.onload = () => {
        let data = {};
        try {
          data = JSON.parse(xhr.responseText);
        } catch {}
        xhr.status < 300 ? resolve(data) : reject(new Error(data.error || `Upload failed (${xhr.status})`));
      };
      xhr.onerror = () => reject(new Error('Upload failed'));
      xhr.send(form);
    }),
};

// Live event bus fed by the WebSocket ---------------------------------------

const listeners = new Map();
let socket = null;
let subscriptions = new Set();
let retry = 0;

export function on(type, fn) {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type).add(fn);
  return () => listeners.get(type).delete(fn);
}

function emit(type, msg) {
  listeners.get(type)?.forEach((fn) => fn(msg));
}

export function connect() {
  if (socket && socket.readyState <= 1) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${proto}://${location.host}/ws`);
  socket.onopen = () => {
    retry = 0;
    for (const id of subscriptions) socket.send(JSON.stringify({ type: 'subscribe', server: id }));
    emit('connected');
  };
  socket.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    emit(msg.type, msg);
  };
  socket.onclose = () => {
    emit('disconnected');
    socket = null;
    setTimeout(connect, Math.min(10000, 500 * 2 ** retry++));
  };
}

export function disconnect() {
  if (socket) {
    socket.onclose = null;
    socket.close();
    socket = null;
  }
}

export function subscribe(id) {
  subscriptions.add(id);
  if (socket?.readyState === 1) socket.send(JSON.stringify({ type: 'subscribe', server: id }));
  return () => {
    subscriptions.delete(id);
    if (socket?.readyState === 1) socket.send(JSON.stringify({ type: 'unsubscribe', server: id }));
  };
}
