// Admin toolkit: form builder (text/price/image/datetime/repeater…), image upload (client-side WebP), tables.
import { html, setHtml, $, $$, raw } from '/js/util.js';
import { api } from '/js/api.js';
import { toast, openModal, showFieldError, clearFieldErrors } from '/js/ui.js';

export const lyd = (d) => (d === null || d === undefined || d === '' ? '' : d / 1000);
export const localDt = (iso) => { if (!iso) return ''; const d = new Date(iso); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };

// ── Image upload: resize to ≤ max px and convert to WebP in the browser, then upload ──
export async function uploadImage(file, { max = 1200 } = {}) {
  if (!file.type.startsWith('image/')) throw new Error('اختر ملف صورة');
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  const blob = await new Promise((r) => c.toBlob(r, 'image/webp', 0.84));
  if (!blob || blob.type !== 'image/webp') throw new Error('متصفحك لا يدعم تحويل الصور');
  if (blob.size > 2 * 1024 * 1024) throw new Error('الصورة كبيرة بعد الضغط (أكثر من 2 ميغابايت)');
  const r = await api('/api/admin/upload', { method: 'POST', raw: blob, headers: { 'Content-Type': 'image/webp' } });
  return r.url;
}

// ── Field rendering ──
const rowFields = (sub, vals = {}) => html`<div class="rep-row" data-keep="${vals.id ? JSON.stringify({ id: vals.id }) : ''}">${sub.map((s) => html`<label class="rep-f" style="flex:${s.flex || 1}"><span class="sr">${s.label}</span>${
  s.type === 'checkbox' ? html`<span class="check"><input type="checkbox" data-k="${s.name}" ${vals[s.name] === undefined ? (s.def ? 'checked' : '') : (vals[s.name] ? 'checked' : '')}> ${s.label}</span>`
    : html`<input class="input" data-k="${s.name}" type="${s.type === 'price' ? 'number' : s.type || 'text'}" ${s.type === 'price' ? raw('step="0.001" min="0"') : ''} ${s.type === 'number' ? raw('min="1"') : ''} placeholder="${s.label}" value="${s.type === 'price' ? lyd(vals[s.name]) : (vals[s.name] ?? s.def ?? '')}" ${s.required ? 'required' : ''}>`}</label>`)}
  <button type="button" class="icon-btn" data-rep-rm aria-label="حذف الصف">✕</button></div>`;

function fieldHtml(f, v) {
  const id = 'f_' + f.name; const val = v ?? f.def ?? '';
  const hint = f.hint ? html`<span class="hint">${f.hint}</span>` : '';
  switch (f.type) {
    case 'textarea': return html`<div class="field ${f.wide ? 'wide' : ''}"><label for="${id}">${f.label}</label><textarea class="textarea" id="${id}" name="${f.name}" rows="${f.rows || 4}" ${f.mono ? raw('dir="ltr" spellcheck="false" style="font-family:ui-monospace,Menlo,monospace;font-size:13px;text-align:left"') : ''} ${f.required ? 'required' : ''}>${val}</textarea>${hint}</div>`;
    case 'select': return html`<div class="field"><label for="${id}">${f.label}</label><select class="select" id="${id}" name="${f.name}">${f.options.map(([k, t]) => html`<option value="${k}" ${String(k) === String(val) ? 'selected' : ''}>${t}</option>`)}</select>${hint}</div>`;
    case 'checkbox': return html`<div class="field"><label class="check"><input type="checkbox" name="${f.name}" ${(v === undefined ? f.def : v) ? 'checked' : ''}> ${f.label}</label>${hint}</div>`;
    case 'image': return html`<div class="field wide" data-image="${f.name}"><span class="label">${f.label}</span><input type="hidden" name="${f.name}" value="${val || ''}">
        <div class="img-pick"><div class="img-prev">${val ? raw(`<img src="${val}" alt="">`) : html`<span class="cl-sub">لا توجد صورة</span>`}</div>
        <div class="row"><label class="btn btn-ghost btn-sm" style="cursor:pointer">اختيار صورة<input type="file" accept="image/*" hidden></label><button class="btn btn-ghost btn-sm" type="button" data-img-rm ${val ? '' : 'hidden'}>إزالة</button></div></div>${hint}</div>`;
    case 'repeater': return html`<div class="field wide" data-rep="${f.name}"><span class="label">${f.label}</span><div class="rep-rows">${(Array.isArray(v) ? v : []).map((r) => rowFields(f.sub, r))}</div><button class="btn btn-ghost btn-sm" type="button" data-rep-add>＋ ${f.addText || 'إضافة'}</button>${hint}</div>`;
    case 'price': return html`<div class="field"><label for="${id}">${f.label}</label><input class="input" id="${id}" name="${f.name}" type="number" step="0.001" min="0" inputmode="decimal" value="${val === '' ? '' : lyd(val)}" ${f.required ? 'required' : ''}>${hint}</div>`;
    case 'datetime': return html`<div class="field"><label for="${id}">${f.label}</label><input class="input" id="${id}" name="${f.name}" type="datetime-local" value="${localDt(val)}">${hint}</div>`;
    default: return html`<div class="field ${f.wide ? 'wide' : ''}"><label for="${id}">${f.label}</label><input class="input" id="${id}" name="${f.name}" type="${f.type || 'text'}" ${f.type === 'password' ? raw('autocomplete="new-password" spellcheck="false"') : ''} ${f.placeholder ? raw(`placeholder="${String(f.placeholder).replace(/"/g, '&quot;')}"`) : ''} ${f.dir ? raw(`dir="${f.dir}" style="text-align:right"`) : ''} ${f.type === 'number' ? raw('min="0"') : ''} value="${val}" ${f.required ? 'required' : ''} ${f.max ? raw(`maxlength="${f.max}"`) : ''}>${hint}</div>`;
  }
}
export const formFields = (fields, values = {}) => html`<div class="fgrid">${fields.map((f) => fieldHtml(f, values[f.name]))}</div>`;

/** Wire interactive pieces (image pickers, repeaters) inside a form element. */
export function wireForm(form, fields) {
  $$('[data-image]', form).forEach((box) => {
    const name = box.dataset.image; const hidden = $(`input[name="${name}"]`, box); const prev = $('.img-prev', box); const rm = $('[data-img-rm]', box);
    $('input[type=file]', box).addEventListener('change', async (e) => {
      const file = e.target.files[0]; if (!file) return;
      prev.textContent = 'جارٍ الرفع…';
      try { const f = fields.find((x) => x.name === name); hidden.value = await uploadImage(file, { max: f?.max || 1200 }); prev.innerHTML = `<img src="${hidden.value}" alt="">`; rm.hidden = false; }
      catch (err) { prev.textContent = 'لا توجد صورة'; toast(err.message || 'تعذّر رفع الصورة', 'err'); }
      e.target.value = '';
    });
    rm.addEventListener('click', () => { hidden.value = ''; prev.innerHTML = '<span class="cl-sub">لا توجد صورة</span>'; rm.hidden = true; });
  });
  $$('[data-rep]', form).forEach((box) => {
    const f = fields.find((x) => x.name === box.dataset.rep); const rows = $('.rep-rows', box);
    $('[data-rep-add]', box).addEventListener('click', () => { rows.insertAdjacentHTML('beforeend', rowFields(f.sub, {}).s); rows.lastElementChild.querySelector('input')?.focus(); });
    box.addEventListener('click', (e) => { if (e.target.closest('[data-rep-rm]')) e.target.closest('.rep-row').remove(); });
  });
}

/** Collect typed values from a form built with formFields(). Prices stay in LYD (the API converts). */
export function readForm(form, fields) {
  const out = {};
  for (const f of fields) {
    if (f.type === 'checkbox') out[f.name] = form.elements[f.name].checked;
    else if (f.type === 'repeater') {
      out[f.name] = $$('.rep-row', $(`[data-rep="${f.name}"]`, form)).map((row) => {
        const o = {};
        for (const s of f.sub) { const inp = $(`[data-k="${s.name}"]`, row); o[s.name] = s.type === 'checkbox' ? inp.checked : inp.value; }
        if (row.dataset.keep) Object.assign(o, JSON.parse(row.dataset.keep));
        return o;
      }).filter((o) => f.sub.some((s) => s.type !== 'checkbox' && String(o[s.name] ?? '').trim() !== ''));
    } else if (f.type === 'datetime') { const v = form.elements[f.name].value; out[f.name] = v ? new Date(v).toISOString() : ''; }
    else out[f.name] = form.elements[f.name].value;
  }
  return out;
}

/** Opens a modal form. onSubmit(values) may throw an ApiError (field errors are shown inline). */
export function openForm({ title, fields, values = {}, submitText = 'حفظ', onSubmit, wide = true, extra = '' }) {
  const { el, close } = openModal(title, html`<form class="form" novalidate>${formFields(fields, values)}${extra}<div class="row" style="justify-content:flex-start"><button class="btn btn-primary" type="submit">${submitText}</button><button class="btn btn-ghost" type="button" data-close>إلغاء</button></div></form>`, { wide });
  const form = $('form', el); wireForm(form, fields);
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); clearFieldErrors(form);
    const btn = $('[type=submit]', form); btn.disabled = true;
    try { await onSubmit(readForm(form, fields), close); }
    catch (err) { if (!(err.data?.field && showFieldError(form, err.data.field, err.message))) toast(err.message || 'حدث خطأ', 'err', { ms: 5000 }); }
    btn.disabled = false;
  });
  return { el, close, form };
}

// ── Tables (stack into cards on phones via data-label) ──
export function table(cols, rows, { empty = 'لا توجد بيانات بعد', rowAttr } = {}) {
  if (!rows.length) return html`<div class="empty">${empty}</div>`;
  return html`<div class="tbl-wrap"><table class="dt"><thead><tr>${cols.map((c) => html`<th>${c.h}</th>`)}</tr></thead><tbody>
    ${rows.map((r) => html`<tr ${rowAttr ? raw(rowAttr(r)) : ''}>${cols.map((c) => html`<td data-label="${c.h}">${c.v(r)}</td>`)}</tr>`)}</tbody></table></div>`;
}

export const pager = (page, total, size) => {
  const pages = Math.max(1, Math.ceil(total / size));
  return pages <= 1 ? '' : html`<div class="row" style="justify-content:center;margin-top:14px"><button class="btn btn-ghost btn-sm" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>السابق</button><span class="cl-sub">صفحة ${page} من ${pages} (${total})</span><button class="btn btn-ghost btn-sm" data-page="${page + 1}" ${page >= pages ? 'disabled' : ''}>التالي</button></div>`;
};

export const yesNo = (b, y = 'نعم', n = 'لا') => html`<span class="status ${b ? 's-delivered' : 's-cancelled'}">${b ? y : n}</span>`;
export { api, toast, openModal };
