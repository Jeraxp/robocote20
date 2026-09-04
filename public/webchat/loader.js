/*
 * Loader do webchat — a única linha que a corretora cola no site:
 *   <script src="https://.../webchat.js" data-tenant="slug" async></script>
 *
 * Faz só duas coisas: desenha o botão flutuante e abre/fecha um painel com o
 * iframe do chat. A conversa inteira roda dentro do iframe, no nosso domínio —
 * zero CORS, e a identidade da conversa fica no localStorage do iframe.
 *
 * Atributos: data-tenant (obrigatório), data-position="right|left".
 * API: window.RobocoteWebchat = { open(), close(), toggle(), isOpen() }.
 */
(function () {
  'use strict';
  if (window.RobocoteWebchat || document.getElementById('rc-webchat')) return;

  var script = document.currentScript || (function () {
    var todos = document.querySelectorAll('script[src*="webchat.js"][data-tenant]');
    return todos[todos.length - 1] || null;
  })();
  if (!script || !script.src) return;

  var tenant = (script.getAttribute('data-tenant') || '').trim();
  if (!tenant) { console.warn('[webchat] data-tenant ausente no script de instalação'); return; }
  var posicao = script.getAttribute('data-position') === 'left' ? 'left' : 'right';
  var base = script.src.replace(/\/webchat\.js(?:[?#].*)?$/, '');
  var origemBase = null;
  try { origemBase = new URL(base, location.href).origin; } catch (e) { /* fica null: não valida origem */ }
  var urlIframe = base + '/webchat?tenant=' + encodeURIComponent(tenant) + '&embed=1';
  var COR_PADRAO = '#0aa5e8';

  var ICONE_CHAT = '<svg class="rc-i-chat" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3C7 3 3 6.4 3 10.6c0 2.3 1.2 4.4 3.2 5.8L5.4 21l4.5-2.2c.7.1 1.4.2 2.1.2 5 0 9-3.4 9-7.6S17 3 12 3z"/></svg>';
  var ICONE_FECHAR = '<svg class="rc-i-fechar" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  var CSS = [
    '#rc-webchat{position:fixed;z-index:2147483000;bottom:20px;right:20px;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;line-height:1}',
    '#rc-webchat *{box-sizing:border-box}',
    '#rc-webchat[data-posicao="left"]{right:auto;left:20px}',
    '.rc-webchat-botao{width:58px;height:58px;padding:0;margin:0;border:0;border-radius:50%;background:var(--rc-cor,' + COR_PADRAO + ');color:var(--rc-cor-texto,#fff);box-shadow:0 10px 28px rgba(0,0,0,.22);cursor:pointer;display:grid;place-items:center;transition:transform .15s ease,box-shadow .15s ease}',
    '.rc-webchat-botao:hover{transform:scale(1.06);box-shadow:0 14px 32px rgba(0,0,0,.26)}',
    '.rc-webchat-botao:focus-visible{outline:3px solid rgba(0,0,0,.35);outline-offset:3px}',
    '.rc-webchat-botao svg{width:28px;height:28px;display:block}',
    '.rc-webchat-botao .rc-i-fechar{display:none}',
    '#rc-webchat[data-aberto="1"] .rc-i-chat{display:none}',
    '#rc-webchat[data-aberto="1"] .rc-i-fechar{display:block}',
    '#rc-webchat-painel{position:fixed;bottom:92px;right:20px;width:380px;max-width:calc(100vw - 40px);height:min(640px,calc(100vh - 112px));border-radius:16px;overflow:hidden;background:#fff;box-shadow:0 24px 64px rgba(0,0,0,.28);transform-origin:bottom right;animation:rc-webchat-abre .18s ease-out}',
    '#rc-webchat-painel[hidden]{display:none!important}',
    '#rc-webchat[data-posicao="left"] #rc-webchat-painel{right:auto;left:20px;transform-origin:bottom left}',
    '#rc-webchat-painel iframe{width:100%;height:100%;border:0;display:block;background:#fff}',
    '@keyframes rc-webchat-abre{from{opacity:0;transform:translateY(10px) scale(.97)}to{opacity:1;transform:none}}',
    '@media (max-width:480px){#rc-webchat-painel{top:0;left:0;right:0;bottom:0;width:auto;max-width:none;height:100vh;height:100dvh;border-radius:0}#rc-webchat[data-posicao="left"] #rc-webchat-painel{left:0}#rc-webchat[data-aberto="1"] .rc-webchat-botao{display:none}}',
    '@media (prefers-reduced-motion:reduce){#rc-webchat-painel{animation:none}.rc-webchat-botao{transition:none}}',
  ].join('\n');

  var raiz, botao, painel, iframe = null, aberto = false;

  function corDoTexto(hex) {
    var r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    return (r * 299 + g * 587 + b * 114) / 1000 > 160 ? '#14202b' : '#ffffff';
  }
  function aplicarCor(cor) {
    if (typeof cor !== 'string' || !/^#[0-9a-f]{6}$/i.test(cor)) return;
    raiz.style.setProperty('--rc-cor', cor);
    raiz.style.setProperty('--rc-cor-texto', corDoTexto(cor));
  }

  function montarIframe() {
    if (iframe) return iframe;
    iframe = document.createElement('iframe');
    iframe.src = urlIframe;
    iframe.title = 'Atendimento';
    iframe.setAttribute('allow', 'clipboard-write');
    iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    painel.appendChild(iframe);
    return iframe;
  }

  function open() {
    if (aberto) return;
    montarIframe();
    painel.hidden = false;
    raiz.dataset.aberto = '1';
    aberto = true;
    botao.setAttribute('aria-expanded', 'true');
    botao.setAttribute('aria-label', 'Fechar atendimento');
    try {
      iframe.focus();
      if (iframe.contentWindow) iframe.contentWindow.postMessage({ tipo: 'rc-webchat', evento: 'abrir' }, origemBase || '*');
    } catch (e) { /* iframe ainda carregando */ }
  }
  function close() {
    if (!aberto) return;
    painel.hidden = true;
    raiz.dataset.aberto = '';
    aberto = false;
    botao.setAttribute('aria-expanded', 'false');
    botao.setAttribute('aria-label', 'Abrir atendimento');
    botao.focus();
  }
  function toggle() { if (aberto) close(); else open(); }
  function isOpen() { return aberto; }

  function montar() {
    if (document.getElementById('rc-webchat')) return;
    var estilo = document.createElement('style');
    estilo.id = 'rc-webchat-estilo';
    estilo.textContent = CSS;
    document.head.appendChild(estilo);

    raiz = document.createElement('div');
    raiz.id = 'rc-webchat';
    raiz.dataset.posicao = posicao;

    painel = document.createElement('div');
    painel.id = 'rc-webchat-painel';
    painel.setAttribute('role', 'dialog');
    painel.setAttribute('aria-label', 'Atendimento');
    painel.hidden = true;

    botao = document.createElement('button');
    botao.type = 'button';
    botao.className = 'rc-webchat-botao';
    botao.setAttribute('aria-label', 'Abrir atendimento');
    botao.setAttribute('aria-expanded', 'false');
    botao.setAttribute('aria-controls', 'rc-webchat-painel');
    botao.innerHTML = ICONE_CHAT + ICONE_FECHAR;
    botao.addEventListener('click', toggle);
    // Pré-carrega o iframe quando o cursor se aproxima: o clique abre já pronto.
    botao.addEventListener('pointerenter', montarIframe, { once: true });
    botao.addEventListener('focus', montarIframe, { once: true });

    raiz.appendChild(painel);
    raiz.appendChild(botao);
    document.body.appendChild(raiz);

    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && aberto) close(); });
    window.addEventListener('message', function (e) {
      if (!iframe || e.source !== iframe.contentWindow) return;
      if (origemBase && e.origin !== origemBase) return;
      var d = e.data;
      if (!d || d.tipo !== 'rc-webchat') return;
      if (d.evento === 'identidade') aplicarCor(d.cor);
      else if (d.evento === 'fechar') close();
    });

    // Cor do botão antes do 1º clique (dado público, sem credencial). Se a
    // resposta não liberar a origem, fica a cor padrão até o iframe avisar.
    try {
      fetch(base + '/api/webchat/identidade?tenant=' + encodeURIComponent(tenant), { mode: 'cors', credentials: 'omit' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) { if (j && j.ok) aplicarCor(j.cor); })
        .catch(function () { /* fica a cor padrão */ });
    } catch (e) { /* idem */ }
  }

  window.RobocoteWebchat = { open: open, close: close, toggle: toggle, isOpen: isOpen };

  if (document.body) montar();
  else document.addEventListener('DOMContentLoaded', montar, { once: true });
})();
