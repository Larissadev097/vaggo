'use strict';
/* ==========================================================================
   Vaggo — frontend (JS puro, sem dependências)
   - Todo texto vindo do servidor passa por esc() antes de entrar no HTML (evita XSS).
   - Eventos por delegação (data-act / data-input / data-change / data-form):
     não há onclick="" no HTML, o que permite uma CSP restritiva no servidor.
   ========================================================================== */

const $ = s => document.querySelector(s);
const app = $('#app');

const S = {
  cfg: { max_vagas: 500, max_horas: 12, ttl_min: 10 },   // o servidor sobrescreve em /api/eu
  user: null,
  auth: { modo: 'entrar', papel: 'motorista', nome: '', email: '' },
  // motorista
  step: 1, q: '', locais: [], lote: null, vaga: null, pref: false, horas: 1,
  res: null, deadline: 0, poll: null, tick: null,
  // empresa
  emp: { tela: 'lista', lotes: [], gerir: null, tipo: 'terreno' },
};

/* ---------- utilidades ---------- */
const esc = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ini = n => n.trim().split(/\s+/).slice(0, 2).map(p => p[0]).join('').toUpperCase();
const TIPO = { shopping: 'Shopping', terreno: 'Terreno', estacionamento: 'Estacionamento' };
const cls = x => x.status === 'ocupada' ? 'ocupada' : x.tipo === 'pref' ? 'pref' : 'livre';

const ICONS = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  building: '<path d="M4 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16M16 9h2a2 2 0 0 1 2 2v10M2 21h20M8 7h4M8 11h4M8 15h4"/>',
  car: '<path d="M3 13l2-5a2 2 0 0 1 2-1.5h10A2 2 0 0 1 19 8l2 5v5h-3v-2H6v2H3z"/><circle cx="7.5" cy="14" r="1"/><circle cx="16.5" cy="14" r="1"/>',
  pin: '<path d="M12 21s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="9" r="2.5"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  coin: '<circle cx="12" cy="12" r="9"/><path d="M14.5 9a2.5 2 0 0 0-2.5-1.5c-1.4 0-2.5.8-2.5 2s1.1 1.6 2.5 2 2.5.8 2.5 2-1.1 2-2.5 2A2.5 2 0 0 1 9.5 15M12 6v1.5M12 16.5V18"/>',
  qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h3M20 17v4"/>',
};
const ico = n => `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n]}</svg>`;

let toastT;
function toast(t, tipo = '') {
  const e = $('#toast');
  e.textContent = t; e.className = 'show ' + tipo;
  clearTimeout(toastT); toastT = setTimeout(() => { e.className = ''; }, 3200);
}

async function api(url, method = 'GET', body) {
  const opt = { method, headers: {} };
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  let r;
  try { r = await fetch(url, opt); }
  catch { return { ok: false, status: 0, data: { erro: 'Sem conexão com o servidor.' } }; }
  let data = {}; try { data = await r.json(); } catch { /* resposta sem corpo */ }
  if (r.status === 401 && S.user) sessaoExpirada();
  return { ok: r.ok, status: r.status, data };
}

function parar() { clearInterval(S.poll); clearInterval(S.tick); S.poll = S.tick = null; }
function resetFluxo() { parar(); S.step = 1; S.lote = null; S.vaga = null; S.res = null; S.horas = 1; S.pref = false; S.q = ''; }
function sessaoExpirada() { resetFluxo(); S.user = null; render(); toast('Sua sessão expirou. Entre novamente.', 'err'); }

/* ---------- peças de interface ---------- */
const brand = () => `<div class="brand"><img src="/logo.png" alt="" width="52" height="52"><span>Vaggo</span></div>`;

const userChip = () => `<div class="chip"><span class="av">${esc(ini(S.user.nome))}</span>
  <span class="who"><b>${esc(S.user.nome)}</b><small>${S.user.papel === 'empresa' ? 'Conta empresa' : 'Motorista'}</small></span>
  <button class="icon-btn" data-act="sair" title="Sair" aria-label="Sair">${ico('logout')}</button></div>`;

const field = (id, label, icon, { type = 'text', ph = '', val = '', ac = 'off', attrs = '', eye = false } = {}) =>
  `<label class="field"><span>${label}</span><div class="inp">${ico(icon)}
   <input id="${id}" name="${id}" type="${type}" value="${esc(val)}" placeholder="${esc(ph)}" autocomplete="${ac}" ${attrs}>
   ${eye ? `<button type="button" class="eye" data-act="ver" aria-label="Mostrar ou ocultar senha">${ico('eye')}</button>` : ''}</div></label>`;

function gradeHTML(vagas, cols, tile, extra = '') {
  const rows = [];
  for (let i = 0; i < vagas.length; i += cols) rows.push(vagas.slice(i, i + cols));
  return `<div class="lot ${extra}" style="--cols:${cols}">${rows.map((r, i) =>
    `<div class="row">${r.map(tile).join('')}</div>${i % 2 && i < rows.length - 1 ? '<div class="aisle">corredor</div>' : ''}`).join('')}</div>`;
}
const colunas = () => innerWidth > 860 ? 10 : 6;

/* ==========================================================================
   LOGIN / CADASTRO
   ========================================================================== */
const AUTH = () => {
  const a = S.auth, cad = a.modo === 'cadastro', emp = a.papel === 'empresa';
  return `<div class="auth">
  <section class="hero">${brand()}
    <h1>Achou a vaga. Reservou. Pagou.</h1>
    <p>Encontre estacionamento em shoppings e terrenos parceiros, escolha a vaga no mapa e pague por Pix em segundos.</p>
    <div class="feat">
      <div>${ico('pin')}<span>Vagas livres em tempo real no mapa</span></div>
      <div>${ico('qr')}<span>Pagamento por QR Code ou link</span></div>
      <div>${ico('building')}<span>Painel para quem tem lote ou terreno</span></div>
    </div>
  </section>
  <section class="auth-wrap"><form class="card auth-card" data-form="auth" novalidate>
    <div class="tabs" role="tablist">
      <button type="button" class="tab ${!cad ? 'on' : ''}" data-act="modo" data-v="entrar">Entrar</button>
      <button type="button" class="tab ${cad ? 'on' : ''}" data-act="modo" data-v="cadastro">Criar conta</button>
    </div>
    <h2>${cad ? 'Crie sua conta' : 'Bem-vindo de volta'}</h2>
    <p class="sub">${cad ? 'Escolha como você vai usar o Vaggo.' : 'Entre para ver as vagas disponíveis.'}</p>
    ${cad ? `<div class="roles">
      <button type="button" class="role ${!emp ? 'on' : ''}" data-act="papel" data-v="motorista">${ico('car')}<b>Motorista</b><small>Busco e reservo vagas</small></button>
      <button type="button" class="role ${emp ? 'on' : ''}" data-act="papel" data-v="empresa">${ico('building')}<b>Empresa / lote</b><small>Tenho vagas para oferecer</small></button>
    </div>${field('nome', emp ? 'Nome da empresa' : 'Seu nome', emp ? 'building' : 'user', { val: a.nome, ac: 'name' })}` : ''}
    ${field('email', 'E-mail', 'mail', { type: 'email', val: a.email, ac: 'email', ph: 'voce@exemplo.com' })}
    ${field('senha', 'Senha', 'lock', { type: 'password', ac: cad ? 'new-password' : 'current-password', eye: true, ph: cad ? 'Mínimo de 8 caracteres' : '' })}
    <div class="alert" id="auth-erro" role="alert" hidden></div>
    <button class="btn wide" type="submit" style="margin-top:20px">${cad ? 'Criar conta' : 'Entrar'}</button>
  </form></section></div>`;
};

function lerAuth() {
  const f = $('[data-form=auth]'); if (!f) return;
  for (const k of ['nome', 'email']) if (f.elements[k]) S.auth[k] = f.elements[k].value;
}

/* ==========================================================================
   MOTORISTA: 1) local  2) vaga  3) confirmar e pagar
   ========================================================================== */
const SIDE_M = () => {
  const l = S.lote, pago = S.res?.status === 'paga';
  const steps = [
    ['Local', l ? l.nome : 'Escolha o shopping ou terreno'],
    ['Vaga', S.vaga ? 'Vaga ' + S.vaga : 'Escolha a vaga'],
    ['Confirmar', pago ? 'Pago' : 'Pagamento por QR Code ou link'],
  ];
  return `<aside class="side">${brand()}<nav class="steps" aria-label="Etapas">${steps.map(([t, d], i) => {
    const n = i + 1, on = S.step === n, ok = n < S.step || (n === 3 && pago);
    return `<button class="step ${on ? 'on' : ''} ${ok ? 'ok' : ''}" data-act="go" data-n="${n}">
      <span class="num">${ok && !on ? ico('check') : n}</span><span class="txt"><b>${t}</b><small>${esc(d)}</small></span></button>`;
  }).join('')}</nav>
  <div class="side-end">
    <div class="promo"><b>Tem um terreno com vagas?</b><small>Crie uma conta de empresa e publique no mapa.</small>
      <button class="btn light" data-act="virarEmpresa">Cadastrar meu terreno</button></div>
    ${userChip()}</div></aside>`;
};

const V1 = () => `<div id="pins"></div>
  <section class="card search"><h2>Para onde você vai?</h2>
    <div class="inp">${ico('search')}<input id="q" type="search" placeholder="Busque shopping, terreno..." value="${esc(S.q)}"
      data-input="buscar" autocomplete="off" aria-label="Buscar local"></div>
    <div id="lista"></div></section>`;

const optHTML = x => `<button class="opt" data-act="escolher" data-id="${+x.id}">
  <span class="opt-ico">${ico(x.tipo === 'shopping' ? 'building' : 'pin')}</span>
  <span class="opt-txt"><b>${esc(x.nome)}</b><small>${esc(x.endereco)} · R$ ${fmt(x.preco)}/h</small></span>
  <span class="badge ${x.livres ? '' : 'off'}">${+x.livres} livres</span></button>`;

const pinHTML = x => `<button class="pin ${x.livres ? '' : 'off'}" style="--x:${+x.x}%;top:${+x.y}%" data-act="escolher" data-id="${+x.id}"
  aria-label="${esc(x.nome)}, ${+x.livres} vagas livres">${ico('pin')}<span>${esc(x.nome)}</span><em>${+x.livres}</em></button>`;

let buscaSeq = 0;
async function buscar(q) {
  S.q = q; const seq = ++buscaSeq;
  const r = await api('/api/locais?q=' + encodeURIComponent(q));
  if (seq !== buscaSeq || !r.ok) return;            // ignora respostas antigas
  S.locais = r.data;
  const lista = $('#lista'), pins = $('#pins'); if (!lista || !pins) return;
  lista.innerHTML = q.trim()
    ? (S.locais.map(optHTML).join('') || '<p class="empty">Nenhum local encontrado.</p>')
    : `<div class="chips"><span>Sugestões:</span>${['Shopping', 'Terreno', 'Estacionamento'].map(t =>
        `<button type="button" class="pillb" data-act="chip" data-q="${t}">${t}</button>`).join('')}</div>`;
  pins.innerHTML = S.locais.map(pinHTML).join('');
}

async function escolher(id) {
  const r = await api('/api/locais/' + id);
  if (!r.ok) return toast(r.data.erro || 'Não foi possível abrir o local.', 'err');
  await cancelar(); S.lote = r.data; S.vaga = null; S.step = 2; render();
}

const V2 = () => {
  const l = S.lote, vs = l.vagas, livres = vs.filter(v => v.status === 'livre').length;
  const prefL = vs.filter(v => v.status === 'livre' && v.tipo === 'pref').length;
  const tile = x => `<button class="v ${cls(x)} ${x.id === S.vaga ? 'sel' : ''}" data-act="vaga" data-id="${esc(x.id)}"
    ${x.status !== 'livre' ? 'aria-disabled="true"' : ''} aria-label="Vaga ${esc(x.id)}">${esc(x.id)}</button>`;
  return `<div class="card panel">
    <header class="ph"><div><h2>${esc(l.nome)}</h2><p class="muted">${esc(l.endereco)}</p></div>
      <div class="price"><b>R$ ${fmt(l.preco)}</b><small>por hora</small></div></header>
    <div class="stats"><span class="stat"><b>${livres}</b>livres</span><span class="stat"><b>${vs.length}</b>no total</span>
      <span class="stat"><b>${prefL}</b>idoso/PCD livres</span></div>
    <label class="switch"><input type="checkbox" data-change="pref" ${S.pref ? 'checked' : ''}><i></i>
      <span>Preciso de vaga para idoso / PCD</span></label>
    <div class="leg"><span><i style="background:var(--g)"></i>Disponível</span><span><i style="background:var(--b)"></i>Idoso/PCD</span>
      <span><i style="background:var(--c)"></i>Ocupada</span></div>
    ${gradeHTML(vs, colunas(), tile)}</div>`;
};

function escolherVaga(id) {
  const x = S.lote.vagas.find(v => v.id === id); if (!x) return;
  if (x.status !== 'livre') return toast('Vaga ocupada. Escolha outra.', 'err');
  if (x.tipo === 'pref' && !S.pref) return toast('Vaga de idoso/PCD: marque a opção acima para usar.', 'err');
  S.vaga = id; S.step = 3; render();
}

const V3 = () => {
  const l = S.lote, r = S.res;
  if (r?.status === 'paga') return `<div class="card panel done"><div class="okring">${ico('check')}</div>
    <h2>Pagamento confirmado</h2><p>${esc(l.nome)} · vaga ${esc(S.vaga)} reservada por ${S.horas} h.<br>Siga a sinalização até a vaga.</p>
    <button class="btn" data-act="novo">Nova busca</button></div>`;
  const total = r ? r.total : l.preco * S.horas;
  return `<div class="card panel"><h2>Confirmar reserva</h2>
    <div class="sum">
      <div><span class="muted">Local</span><b>${esc(l.nome)}</b></div>
      <div><span class="muted">Vaga</span><b>${esc(S.vaga)}</b></div>
      <div><span class="muted">Tempo</span><span class="stepper">
        <button class="icon-btn" data-act="horas" data-d="-1" ${r ? 'disabled' : ''} aria-label="Menos uma hora">${ico('minus')}</button>
        <b>${S.horas} h</b>
        <button class="icon-btn" data-act="horas" data-d="1" ${r ? 'disabled' : ''} aria-label="Mais uma hora">${ico('plus')}</button></span></div>
      <div class="tot"><span class="muted">Total</span><b>R$ ${fmt(total)}</b></div>
    </div>
    ${r ? `<div class="pay"><div class="qr">${r.qr}</div><div class="pay-info">
        <p>Escaneie o QR Code ou abra o link:</p>
        <div class="copy"><input id="lnk" readonly value="${esc(r.link)}" aria-label="Link de pagamento">
          <button class="btn soft icon" data-act="copiar" aria-label="Copiar link">${ico('copy')}</button></div>
        <p class="wait"><span class="dot"></span><span>Aguardando pagamento… reserva garantida por <b id="tempo">--:--</b></span></p>
      </div></div>`
      : `<button class="btn wide green" data-act="pagar">${ico('qr')} Gerar QR Code / link de pagamento</button>`}
  </div>`;
};

async function cancelar() {
  parar();
  if (S.res && S.res.status === 'pendente') await api('/api/reservas/' + S.res.id, 'DELETE');
  S.res = null;
}

async function go(n) {
  if (S.res?.status === 'paga' && n < 3) { resetFluxo(); n = 1; }
  if ((n > 1 && !S.lote) || (n > 2 && !S.vaga)) return;
  if (n < 3) await cancelar();
  if (n === 2) { const r = await api('/api/locais/' + S.lote.id); if (r.ok) S.lote = r.data; }
  S.step = n; render();
}

async function pagar() {
  const r = await api('/api/reservas', 'POST', { local: S.lote.id, vaga: S.vaga, horas: S.horas, pref: S.pref });
  if (!r.ok) { toast(r.data.erro || 'Não foi possível reservar.', 'err'); return go(2); }
  S.res = { ...r.data, status: 'pendente' };
  S.deadline = Date.now() + r.data.restante * 1000;
  render();
  S.tick = setInterval(() => {
    const t = $('#tempo'); if (!t) return;
    const s = Math.max(0, Math.round((S.deadline - Date.now()) / 1000));
    t.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 500);
  S.poll = setInterval(async () => {
    if (!S.res) return parar();
    const s = await api('/api/reservas/' + S.res.id);
    if (!s.ok) return;
    if (s.data.status === 'paga') { parar(); S.res.status = 'paga'; render(); }
    else if (s.data.status !== 'pendente') {
      parar(); S.res = null; toast('A reserva expirou. Escolha a vaga novamente.', 'err'); go(2);
    }
  }, 1500);
}

const MOTORISTA = () => `<div class="shell">${SIDE_M()}<main class="map" id="main">${[V1, V2, V3][S.step - 1]()}</main></div>`;

/* ==========================================================================
   EMPRESA: painel, cadastro e gerenciamento de vagas
   ========================================================================== */
async function carregarEmpresa() {
  const r = await api('/api/meus-locais');
  if (r.ok) S.emp.lotes = r.data;
}

const SIDE_E = () => {
  const L = S.emp.lotes, tot = L.reduce((a, l) => a + l.total, 0), t = S.emp.tela;
  const it = (tela, icon, titulo, desc, on) => `<button class="step ${on ? 'on' : ''}" data-act="empTela" data-tela="${tela}">
    <span class="num">${ico(icon)}</span><span class="txt"><b>${titulo}</b><small>${desc}</small></span></button>`;
  return `<aside class="side">${brand()}<nav class="steps" aria-label="Menu">
    ${it('lista', 'grid', 'Meus lotes', `${L.length} ${L.length === 1 ? 'lote' : 'lotes'} · ${tot} vagas`, t === 'lista' || t === 'gerir')}
    ${it('novo', 'plus', 'Cadastrar lote', 'Publicar no mapa', t === 'novo')}</nav>
    <div class="side-end">${userChip()}</div></aside>`;
};

const kpi = (t, v, i) => `<div class="card kpi">${ico(i)}<div><small>${t}</small><b>${v}</b></div></div>`;

const lotCard = l => {
  const oc = l.total - l.livres, pct = l.total ? Math.round(oc / l.total * 100) : 0;
  return `<article class="card lot-card">
    <div class="lc-h"><div><span class="tag">${esc(TIPO[l.tipo] || l.tipo)}</span><h3>${esc(l.nome)}</h3><p class="muted">${esc(l.endereco)}</p></div>
      <div class="price"><b>R$ ${fmt(l.preco)}</b><small>por hora</small></div></div>
    <div><div class="limit"><span>${l.livres} livres de ${l.total}</span><b>${pct}% ocupado</b></div><div class="bar"><i style="width:${pct}%"></i></div></div>
    <div class="lc-f"><small class="muted">Receita: R$ ${fmt(l.receita)}</small>
      <div class="btns"><button class="btn soft" data-act="gerir" data-id="${+l.id}">Gerenciar vagas</button>
        <button class="btn danger icon" data-act="excluir" data-id="${+l.id}" aria-label="Excluir ${esc(l.nome)}">${ico('trash')}</button></div></div>
  </article>`;
};

const E_LISTA = () => {
  const L = S.emp.lotes, tot = L.reduce((a, l) => a + l.total, 0), liv = L.reduce((a, l) => a + l.livres, 0),
    rec = L.reduce((a, l) => a + l.receita, 0);
  return `<div class="page"><header class="page-h"><div><h1>Meus lotes</h1>
      <p class="muted">Gerencie vagas e preços e acompanhe a ocupação.</p></div>
      <button class="btn" data-act="empTela" data-tela="novo">${ico('plus')} Cadastrar lote</button></header>
    <div class="kpis">${kpi('Lotes', L.length, 'building')}${kpi('Vagas cadastradas', tot, 'grid')}${kpi('Livres agora', liv, 'check')}${kpi('Receita', 'R$ ' + fmt(rec), 'coin')}</div>
    ${L.length ? `<div class="lots">${L.map(lotCard).join('')}</div>`
      : `<div class="card empty-state">${ico('building')}<h3>Nenhum lote ainda</h3>
         <p>Cadastre seu primeiro estacionamento ou terreno e comece a receber reservas.</p>
         <button class="btn" data-act="empTela" data-tela="novo">Cadastrar lote</button></div>`}</div>`;
};

const E_NOVO = () => {
  const t = S.emp.tipo, max = S.cfg.max_vagas;
  return `<div class="page narrow"><header class="page-h"><div><h1>Cadastrar lote</h1>
      <p class="muted">Publique seu estacionamento ou terreno no mapa do Vaggo.</p></div></header>
    <form class="card" data-form="lote" novalidate>
      ${field('nome', 'Nome do local', 'building', { ph: 'Ex.: Estacionamento Centro' })}
      ${field('endereco', 'Endereço', 'pin', { ph: 'Rua, número, bairro', ac: 'street-address' })}
      <div class="field"><span>Tipo</span><div class="seg">${[['terreno', 'Terreno'], ['estacionamento', 'Estacionamento'], ['shopping', 'Shopping']]
        .map(([v, n]) => `<button type="button" class="${t === v ? 'on' : ''}" data-act="tipo" data-v="${v}">${n}</button>`).join('')}</div></div>
      <div class="grid2">
        ${field('vagas', 'Quantidade de vagas', 'grid', { type: 'number', ph: 'Ex.: 30', attrs: `min="1" max="${max}" inputmode="numeric" data-input="cnt"` })}
        ${field('pref', 'Vagas idoso/PCD', 'user', { type: 'number', ph: '0', attrs: 'min="0" inputmode="numeric" data-input="prefTocada"' })}
      </div>
      <div style="margin-top:12px"><div class="limit" id="limite"><span>Limite inicial: ${max} vagas por lote</span><b id="cntv">0 / ${max}</b></div>
        <div class="bar"><i id="cntb" style="width:0%"></i></div></div>
      <p class="muted hint">Sugestão de vagas especiais: 7% (5% idosos + 2% PCD). Confira as regras do seu município.</p>
      ${field('preco', 'Preço por hora (R$)', 'coin', { type: 'number', ph: 'Ex.: 8', attrs: 'min="0.5" max="500" step="0.5" inputmode="decimal"' })}
      <div class="alert" id="erro-lote" role="alert" hidden></div>
      <button class="btn wide" type="submit" style="margin-top:20px">Publicar no mapa</button>
    </form></div>`;
};

const E_GERIR = () => {
  const l = S.emp.gerir, livres = l.vagas.filter(v => v.status === 'livre').length;
  const tile = x => `<button class="v ${cls(x)}" data-act="alternar" data-n="${esc(x.id)}" aria-label="Vaga ${esc(x.id)}">${esc(x.id)}</button>`;
  return `<div class="page"><button class="back" data-act="empTela" data-tela="lista">${ico('back')} Voltar aos lotes</button>
    <div class="card"><header class="ph"><div><span class="tag">${esc(TIPO[l.tipo] || l.tipo)}</span><h2>${esc(l.nome)}</h2><p class="muted">${esc(l.endereco)}</p></div>
      <div class="price"><b>R$ ${fmt(l.preco)}</b><small>por hora</small></div></header>
      <form class="price-form" data-form="preco">${field('preco', 'Novo preço por hora (R$)', 'coin', { type: 'number', val: l.preco, attrs: 'min="0.5" max="500" step="0.5" inputmode="decimal"' })}
        <button class="btn" type="submit">Salvar preço</button></form>
      <div class="stats"><span class="stat"><b id="cnt">${livres}</b>livres</span><span class="stat"><b>${l.vagas.length}</b>no total</span></div>
      <p class="muted hint">Clique numa vaga para marcá-la como ocupada ou livre (por exemplo, quando um carro chega sem reserva).
        Vagas com reserva ativa não podem ser alteradas.</p>
      <div class="leg"><span><i style="background:var(--g)"></i>Livre</span><span><i style="background:var(--b)"></i>Idoso/PCD</span><span><i style="background:var(--c)"></i>Ocupada</span></div>
      ${gradeHTML(l.vagas, colunas(), tile, 'edit')}</div></div>`;
};

const EMPRESA = () => `<div class="shell">${SIDE_E()}<main class="work">${({ lista: E_LISTA, novo: E_NOVO, gerir: E_GERIR })[S.emp.tela]()}</main></div>`;

/* ==========================================================================
   Render principal
   ========================================================================== */
function render() {
  if (!S.user) app.innerHTML = AUTH();
  else if (S.user.papel === 'empresa') app.innerHTML = EMPRESA();
  else {
    app.innerHTML = MOTORISTA();
    if (S.step === 1) { buscar(S.q); if (innerWidth > 860) $('#q')?.focus({ preventScroll: true }); }
  }
}

/* ==========================================================================
   Eventos (delegação)
   ========================================================================== */
const ACT = {
  modo(el) { lerAuth(); S.auth.modo = el.dataset.v; render(); },
  papel(el) { lerAuth(); S.auth.papel = el.dataset.v; render(); },
  ver(el) { const i = el.parentElement.querySelector('input'); i.type = i.type === 'password' ? 'text' : 'password'; },

  async sair() { await api('/api/logout', 'POST'); resetFluxo(); S.user = null; S.emp = { tela: 'lista', lotes: [], gerir: null, tipo: 'terreno' }; render(); },
  async virarEmpresa() { await ACT.sair(); S.auth.modo = 'cadastro'; S.auth.papel = 'empresa'; render(); },

  go(el) { go(+el.dataset.n); },
  escolher(el) { escolher(+el.dataset.id); },
  chip(el) { const q = $('#q'); q.value = el.dataset.q; buscar(q.value); q.focus(); },
  vaga(el) { escolherVaga(el.dataset.id); },
  horas(el) { const n = S.horas + +el.dataset.d; if (n < 1 || n > S.cfg.max_horas) return; S.horas = n; render(); },
  pagar,
  novo() { resetFluxo(); render(); },
  copiar() {
    const i = $('#lnk'); i.select();
    navigator.clipboard?.writeText(i.value).then(() => toast('Link copiado!'), () => toast('Copie o link manualmente.', 'err'));
  },

  async empTela(el) {
    if (el.dataset.tela === 'lista') await carregarEmpresa();
    S.emp.tela = el.dataset.tela; render();
  },
  tipo(el) { S.emp.tipo = el.dataset.v; el.parentElement.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === el)); },
  async gerir(el) {
    const r = await api('/api/locais/' + el.dataset.id);
    if (!r.ok) return toast(r.data.erro || 'Erro ao abrir o lote.', 'err');
    S.emp.gerir = r.data; S.emp.tela = 'gerir'; render();
  },
  async excluir(el) {
    const l = S.emp.lotes.find(x => x.id === +el.dataset.id); if (!l) return;
    if (!confirm(`Excluir "${l.nome}"? Todas as vagas e reservas deste lote serão removidas.`)) return;
    const r = await api('/api/locais/' + l.id, 'DELETE');
    if (!r.ok) return toast(r.data.erro || 'Erro ao excluir.', 'err');
    await carregarEmpresa(); render(); toast('Lote excluído.');
  },
  async alternar(el) {
    const l = S.emp.gerir;
    const r = await api(`/api/locais/${l.id}/vagas/${encodeURIComponent(el.dataset.n)}/alternar`, 'POST');
    if (!r.ok) return toast(r.data.erro || 'Erro ao alterar a vaga.', 'err');
    const v = l.vagas.find(x => x.id === el.dataset.n); v.status = r.data.status;
    el.className = 'v ' + cls(v);                       // atualiza só a vaga (não perde a rolagem)
    $('#cnt').textContent = l.vagas.filter(x => x.status === 'livre').length;
  },
};

const INP = {
  buscar(el) { buscar(el.value); },
  cnt(el) {
    const max = S.cfg.max_vagas, n = Math.floor(+el.value) || 0, ruim = n > max;
    $('#cntv').textContent = `${n} / ${max}`;
    $('#cntb').style.width = Math.min(100, n / max * 100) + '%';
    $('#limite').classList.toggle('bad', ruim);
    $('#limite span').textContent = ruim ? `Máximo de ${max} vagas por lote` : `Limite inicial: ${max} vagas por lote`;
    const p = $('#pref'); if (p && !p.dataset.t) p.value = n > 0 && !ruim ? Math.ceil(n * 0.07) : '';
  },
  prefTocada(el) { el.dataset.t = '1'; },
};

const CHG = { pref(el) { S.pref = el.checked; } };

const FRM = {
  async auth(f) {
    const a = S.auth, cad = a.modo === 'cadastro', v = Object.fromEntries(new FormData(f));
    const erro = m => { const e = $('#auth-erro'); e.textContent = m; e.hidden = false; };
    const email = (v.email || '').trim();
    if (cad && (v.nome || '').trim().length < 2) return erro('Informe o nome.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return erro('Digite um e-mail válido.');
    if (!v.senha) return erro('Digite sua senha.');
    if (cad && v.senha.length < 8) return erro('A senha precisa ter pelo menos 8 caracteres.');
    const btn = f.querySelector('button[type=submit]'); btn.disabled = true;
    const r = await api(cad ? '/api/cadastro' : '/api/login', 'POST',
      cad ? { nome: v.nome.trim(), email, senha: v.senha, papel: a.papel } : { email, senha: v.senha });
    btn.disabled = false;
    if (!r.ok) return erro(r.data.erro || 'Não foi possível continuar.');
    S.user = r.data.usuario; S.auth.nome = S.auth.email = ''; resetFluxo();
    if (S.user.papel === 'empresa') { S.emp.tela = 'lista'; await carregarEmpresa(); }
    render();
  },

  async lote(f) {
    const v = Object.fromEntries(new FormData(f)), max = S.cfg.max_vagas;
    const erro = m => { const e = $('#erro-lote'); e.textContent = m; e.hidden = false; };
    const n = Number(v.vagas), p = v.pref === '' ? 0 : Number(v.pref), preco = Number(String(v.preco).replace(',', '.'));
    if ((v.nome || '').trim().length < 2) return erro('Informe o nome do local.');
    if ((v.endereco || '').trim().length < 5) return erro('Informe o endereço.');
    if (!Number.isInteger(n) || n < 1) return erro('Informe a quantidade de vagas.');
    if (n > max) return erro(`O limite inicial é de ${max} vagas por lote.`);
    if (!Number.isInteger(p) || p < 0 || p > n) return erro('Vagas idoso/PCD deve ficar entre 0 e o total de vagas.');
    if (!(preco >= 0.5 && preco <= 500)) return erro('Informe um preço por hora entre R$ 0,50 e R$ 500,00.');
    const btn = f.querySelector('button[type=submit]'); btn.disabled = true;
    const r = await api('/api/locais', 'POST', { nome: v.nome.trim(), endereco: v.endereco.trim(), tipo: S.emp.tipo, vagas: n, pref: p, preco });
    btn.disabled = false;
    if (!r.ok) return erro(r.data.erro || 'Não foi possível publicar.');
    await carregarEmpresa(); S.emp.tela = 'lista'; render(); toast('Lote publicado no mapa!');
  },

  async preco(f) {
    const l = S.emp.gerir, preco = Number(String(new FormData(f).get('preco')).replace(',', '.'));
    if (!(preco >= 0.5 && preco <= 500)) return toast('Informe um preço entre R$ 0,50 e R$ 500,00.', 'err');
    const r = await api('/api/locais/' + l.id, 'PATCH', { preco });
    if (!r.ok) return toast(r.data.erro || 'Erro ao salvar.', 'err');
    l.preco = r.data.preco; await carregarEmpresa();
    $('.price b').textContent = 'R$ ' + fmt(l.preco); toast('Preço atualizado!');
  },
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = ACT[el.dataset.act];
  if (fn) { e.preventDefault(); fn(el, e); }
});
document.addEventListener('input', e => { const el = e.target.closest('[data-input]'); if (el) INP[el.dataset.input]?.(el, e); });
document.addEventListener('change', e => { const el = e.target.closest('[data-change]'); if (el) CHG[el.dataset.change]?.(el, e); });
document.addEventListener('submit', e => {
  const f = e.target.closest('[data-form]');
  if (f) { e.preventDefault(); FRM[f.dataset.form]?.(f); }
});

let larga = innerWidth > 860;
addEventListener('resize', () => {     // ao cruzar o limite mobile/desktop, refaz a grade de vagas
  const agora = innerWidth > 860; if (agora === larga) return; larga = agora;
  if (S.user?.papel === 'motorista' && S.step === 2) render();
  if (S.user?.papel === 'empresa' && S.emp.tela === 'gerir') render();
});

/* ---------- início ---------- */
(async () => {
  const r = await api('/api/eu');
  if (r.ok) {
    S.cfg = r.data.config; S.user = r.data.usuario;
    if (S.user?.papel === 'empresa') await carregarEmpresa();
  }
  render();
})();
