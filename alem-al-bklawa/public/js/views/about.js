import { html, setHtml } from '../util.js';
import { settings, state, mainBranch } from '../state.js';
import { branchCard, contactCards, sectionHead } from '../components.js';

export default async function about({ el, setTitle }) {
  const s = settings();
  setTitle(`${s.about_title} | ${s.brand_name_ar}`);
  setHtml(el, html`<div class="wrap"><div class="page-head"><div class="crumbs"><a href="/">الرئيسية</a> / ${s.about_title}</div></div>
    <div class="about"><div class="about-card"><div class="sec-eyebrow" style="color:var(--gold)">${s.brand_name_en}</div><h1 style="color:#fff">${s.about_title}</h1><p>${s.about_text}</p>
      <div class="row"><a class="btn btn-gold" href="/shop">تصفح المنتجات</a><a class="btn btn-outline-light" href="/bundles">باقات المناسبات</a></div></div></div>
    <section class="section">${sectionHead('تفضّل بزيارتنا', 'فروعنا')}<div class="bgrid">${state.boot.branches.map(branchCard)}</div></section>
    <section class="section">${sectionHead('نسعد بخدمتك', 'تواصل معنا')}${contactCards(s, mainBranch())}</section></div>`);
}
