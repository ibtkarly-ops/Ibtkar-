// fetch wrapper: JSON in/out, timeouts, Arabic error messages.
export class ApiError extends Error {
  constructor(status, code, message, data) { super(message); this.status = status; this.code = code; this.data = data || {}; }
}

export async function api(path, { method = 'GET', body, signal, timeout = 20000, raw, headers = {} } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  if (signal) signal.addEventListener('abort', () => ctl.abort(), { once: true });
  const init = { method, credentials: 'same-origin', signal: ctl.signal, headers: { ...headers } };
  if (raw !== undefined) init.body = raw;
  else if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  let res;
  try { res = await fetch(path, init); }
  catch (e) {
    if (signal?.aborted) throw new ApiError(0, 'aborted', 'aborted');
    throw new ApiError(0, 'network', ctl.signal.aborted ? 'انتهت مهلة الاتصال. حاول مرة أخرى.' : 'تعذّر الاتصال بالخادم. تحقق من الإنترنت.');
  } finally { clearTimeout(timer); }
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw new ApiError(res.status, data?.error || 'error', data?.message || 'حدث خطأ. حاول مرة أخرى.', data);
  return data;
}
export const isAbort = (e) => e instanceof ApiError && e.code === 'aborted';
