/*
 * Webchat embutido — a conversa do lead dentro do iframe, no nosso domínio.
 *
 * O motor é o MESMO do WhatsApp: o servidor manda as falas (e, junto de cada
 * uma, o plano de chips que o planejador já usa nos botões do WhatsApp). Aqui
 * só se desenha e se devolve o que o lead tocou ou digitou.
 *
 * Identidade da conversa: id `wc_<uuid>` guardado no localStorage DO IFRAME e
 * enviado no header `x-rc-chat`. Cookie de terceiro não é confiável dentro de
 * iframe (Safari/ITP, Chrome com bloqueio) — por isso o header manda.
 *
 * ?tenant=<slug>  obrigatório — corretora dona do canal
 * ?preview=1      pré-visualização do painel: nada persiste, cada abertura é nova
 * ?embed=1        aberto pelo loader: mostra o X e avisa o pai pra fechar
 */
(function () {
  'use strict';

  var q = new URLSearchParams(location.search);
  var TENANT = (q.get('tenant') || '').trim();
  var PREVIEW = q.get('preview') === '1';
  var EMBED = q.get('embed') === '1';
  var CHAVE = 'rc.webchat.' + TENANT;
  var RE_ID = /^wc_[0-9a-f-]{36}$/;
  var RE_COR = /^#[0-9a-f]{6}$/i;
  var LIMITE_TEXTO = 2000;

  function $(id) { return document.getElementById(id); }
  var raiz = $('wc');
  var feed = $('wcFeed');
  var form = $('wcForm');
  var campo = $('wcTexto');
  var btnEnviar = $('wcEnviar');
  var btnNova = $('wcNova');
  var btnFechar = $('wcFechar');
  var elNome = $('wcNome');
  var elStatus = $('wcStatusTexto');
  var elInicial = $('wcInicial');
  var elAvatarImg = $('wcAvatarImg');
  var elSelo = $('wcSelo');
  var elIndisponivel = $('wcIndisponivel');

  var conversaId = null;
  var emVoo = false;
  var chipsAtivos = null;
  var indicador = null;
  var pronto = false;

  /* ---------- identidade da conversa ---------- */

  function uuid() {
    if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    var b = new Uint8Array(16);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(b);
    else for (var i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.prototype.map.call(b, function (x) { return (x + 256).toString(16).slice(1); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  function novoIdLocal() { return 'wc_' + uuid(); }

  function lerId() {
    if (PREVIEW) return null;
    try {
      var v = localStorage.getItem(CHAVE);
      return v && RE_ID.test(v) ? v : null;
    } catch (e) { return null; }
  }
  function gravarId(id) {
    if (typeof id !== 'string' || !RE_ID.test(id)) return;
    conversaId = id;
    if (PREVIEW) return;
    try { localStorage.setItem(CHAVE, id); } catch (e) { /* storage bloqueado: segue só em memória */ }
  }
  function apagarId() {
    conversaId = null;
    try { localStorage.removeItem(CHAVE); } catch (e) { /* idem */ }
  }
  /** O servidor devolve o id da conversa no header (e no JSON de /session). */
  function absorverId(resp, json) {
    var h = resp && resp.headers ? resp.headers.get('x-rc-chat') : null;
    if (h && RE_ID.test(h)) gravarId(h);
    else if (json && typeof json.conversationId === 'string') gravarId(json.conversationId);
  }
  function cabecalhos(extra) {
    var h = extra || {};
    if (conversaId) h['x-rc-chat'] = conversaId;
    return h;
  }
  function url(caminho) { return '/api' + caminho + '?tenant=' + encodeURIComponent(TENANT); }

  /* ---------- pai (loader) ---------- */

  // Só dados públicos (cor, nome, eventos de abrir/fechar) — por isso '*' é aceitável.
  function avisarPai(msg) {
    if (!window.parent || window.parent === window) return;
    try { window.parent.postMessage(Object.assign({ tipo: 'rc-webchat' }, msg), '*'); } catch (e) { /* sem pai */ }
  }

  /* ---------- render ---------- */

  function rolar() { feed.scrollTop = feed.scrollHeight; }

  // URL | *negrito* | _itálico_ — só DOM, nunca innerHTML com texto do servidor.
  var RE_TOKEN = /(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|(^|[\s(])\*([^*\n]+)\*(?=$|[\s.,;:!?)])|(^|[\s(])_([^_\n]+)_(?=$|[\s.,;:!?)])/g;
  function renderTexto(el, texto) {
    var linhas = String(texto == null ? '' : texto).split('\n');
    linhas.forEach(function (linha, i) {
      if (i) el.appendChild(document.createElement('br'));
      var ultimo = 0, m;
      RE_TOKEN.lastIndex = 0;
      while ((m = RE_TOKEN.exec(linha))) {
        if (m.index > ultimo) el.appendChild(document.createTextNode(linha.slice(ultimo, m.index)));
        if (m[1]) {
          var a = document.createElement('a');
          a.href = m[1];
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.textContent = m[1];
          el.appendChild(a);
        } else if (m[3] != null) {
          if (m[2]) el.appendChild(document.createTextNode(m[2]));
          var b = document.createElement('strong');
          b.textContent = m[3];
          el.appendChild(b);
        } else {
          if (m[4]) el.appendChild(document.createTextNode(m[4]));
          var em = document.createElement('em');
          em.textContent = m[5];
          el.appendChild(em);
        }
        ultimo = m.index + m[0].length;
      }
      if (ultimo < linha.length) el.appendChild(document.createTextNode(linha.slice(ultimo)));
    });
  }

  function bolha(tipo, texto) {
    var el = document.createElement('div');
    el.className = 'wc-msg ' + tipo;
    renderTexto(el, texto);
    feed.appendChild(el);
    rolar();
    return el;
  }

  function desativarChips() {
    if (!chipsAtivos) return;
    Array.prototype.forEach.call(chipsAtivos.querySelectorAll('button'), function (b) { b.disabled = true; });
    chipsAtivos = null;
  }

  function chipBotao(titulo, descricao, aoClicar) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'wc-chip';
    b.appendChild(document.createTextNode(titulo));
    if (descricao) {
      var s = document.createElement('small');
      s.textContent = descricao;
      b.appendChild(s);
    }
    b.addEventListener('click', function () {
      b.classList.add('escolhido');
      aoClicar();
    });
    return b;
  }

  function urlSegura(u) {
    return typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null;
  }

  /** Chips a partir do plano interativo (botoes | lista | link) que veio com a fala. */
  function desenharChips(plano) {
    if (!plano || typeof plano !== 'object') return;
    var grupo = document.createElement('div');
    grupo.className = 'wc-chips';
    grupo.setAttribute('role', 'group');
    grupo.setAttribute('aria-label', 'Opções de resposta');

    if (plano.tipo === 'link') {
      var href = urlSegura(plano.url);
      if (!href) return;
      var a = document.createElement('a');
      a.className = 'wc-chip link';
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = plano.rotulo || 'Abrir';
      a.insertAdjacentHTML('beforeend', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8"/></svg>');
      grupo.appendChild(a);
      feed.appendChild(grupo);
      rolar();
      return;
    }

    var opcoes = [];
    if (plano.tipo === 'botoes' && Array.isArray(plano.botoes)) opcoes = plano.botoes;
    else if (plano.tipo === 'lista' && Array.isArray(plano.secoes)) {
      plano.secoes.forEach(function (s) { if (s && Array.isArray(s.itens)) opcoes = opcoes.concat(s.itens); });
    }
    opcoes.forEach(function (o) {
      if (!o || typeof o.titulo !== 'string' || !o.titulo.trim()) return;
      var titulo = o.titulo.trim();
      // O título é o que o parser do passo entende — vai como se o lead tivesse digitado.
      grupo.appendChild(chipBotao(titulo, o.descricao, function () { enviar(titulo, false); }));
    });
    if (!grupo.childNodes.length) return;
    desativarChips();
    chipsAtivos = grupo;
    feed.appendChild(grupo);
    rolar();
  }

  function mostrarEscrevendo() {
    if (!indicador) {
      indicador = document.createElement('div');
      indicador.className = 'wc-escrevendo';
      indicador.setAttribute('aria-hidden', 'true');
      indicador.innerHTML = '<i></i><i></i><i></i>';
    }
    feed.appendChild(indicador);
    raiz.dataset.escrevendo = '1';
    elStatus.textContent = 'escrevendo…';
    rolar();
  }
  function tirarEscrevendo() {
    if (indicador && indicador.parentNode) indicador.parentNode.removeChild(indicador);
    raiz.dataset.escrevendo = '';
    if (pronto) elStatus.textContent = 'online';
  }

  function travarComposer(travado) {
    campo.disabled = travado;
    ajustarEnviar();
  }
  function ajustarEnviar() {
    btnEnviar.disabled = emVoo || campo.disabled || !campo.value.trim();
  }
  function autoAltura() {
    campo.style.height = 'auto';
    campo.style.height = Math.min(campo.scrollHeight, 120) + 'px';
  }

  function indisponivel() {
    raiz.dataset.estado = 'indisponivel';
    elStatus.textContent = 'indisponível';
    elIndisponivel.hidden = false;
    btnNova.hidden = true;
    travarComposer(true);
  }

  /* ---------- identidade da corretora ---------- */

  // Contraste: sobre cor clara o texto vai escuro; sobre escura, branco.
  function corDoTexto(hex) {
    var r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    return (r * 299 + g * 587 + b * 114) / 1000 > 160 ? '#14202b' : '#ffffff';
  }

  function aplicarIdentidade(id) {
    var nome = typeof id.agentName === 'string' && id.agentName.trim() ? id.agentName.trim() : 'Atendimento';
    elNome.textContent = nome;
    document.title = nome;
    elInicial.textContent = nome.charAt(0).toUpperCase();

    var cor = typeof id.cor === 'string' && RE_COR.test(id.cor) ? id.cor : null;
    if (cor) {
      document.documentElement.style.setProperty('--wc-cor', cor);
      document.documentElement.style.setProperty('--wc-cor-texto', corDoTexto(cor));
    }

    var avatar = typeof id.avatarUrl === 'string' && /^(https?:\/\/|data:image\/)/i.test(id.avatarUrl) ? id.avatarUrl : null;
    if (avatar) {
      elAvatarImg.onload = function () { elAvatarImg.hidden = false; elInicial.hidden = true; };
      elAvatarImg.onerror = function () { elAvatarImg.hidden = true; elInicial.hidden = false; };
      elAvatarImg.src = avatar;
    }
    avisarPai({ evento: 'identidade', cor: cor, agentName: nome });
    return { nome: nome, saudacao: typeof id.saudacao === 'string' && id.saudacao.trim() ? id.saudacao.trim() : null };
  }

  async function carregarIdentidade() {
    var r = await fetch(url('/webchat/identidade'), { credentials: 'same-origin' });
    var j = await r.json().catch(function () { return null; });
    if (!r.ok || !j || j.ok !== true) return null;
    return aplicarIdentidade(j);
  }

  /* ---------- conversa ---------- */

  function abertura(ident) {
    if (ident && ident.saudacao) bolha('bot', ident.saudacao);
    else bolha('sistema', 'Escreva sua mensagem para começar.');
    var grupo = document.createElement('div');
    grupo.className = 'wc-chips';
    grupo.appendChild(chipBotao('Começar', null, function () { enviar('Olá', false); }));
    chipsAtivos = grupo;
    feed.appendChild(grupo);
    rolar();
  }

  async function retomar(ident) {
    var r = await fetch(url('/chat/session'), { credentials: 'same-origin', headers: cabecalhos() });
    if (r.status === 404) { indisponivel(); return false; }
    var j = await r.json().catch(function () { return null; });
    if (!r.ok || !j || j.ok !== true) throw new Error('sessão indisponível');
    absorverId(r, j);

    feed.innerHTML = '';
    chipsAtivos = null;
    var historico = j.exists && Array.isArray(j.history) ? j.history : [];
    if (!historico.length) { abertura(ident); return true; }
    historico.forEach(function (h, i) {
      if (!h || typeof h.text !== 'string') return;
      bolha(h.direction === 'inbound' ? 'lead' : 'bot', h.text);
      // Chips só na última fala do bot — as anteriores já foram respondidas.
      if (i === historico.length - 1 && h.direction !== 'inbound' && h.interativo) desenharChips(h.interativo);
    });
    if (!j.completed) bolha('sistema', 'Conversa retomada');
    return true;
  }

  async function tratarErroHttp(r) {
    var j = await r.json().catch(function () { return null; });
    var msg = j && typeof j.error === 'string' ? j.error : null;
    if (r.status === 429) bolha('sistema', msg || 'muitas mensagens — espere um instante');
    else if (r.status === 404) indisponivel();
    else if (r.status === 400 && msg) bolha('erro', msg);
    else bolha('erro', 'Não consegui responder agora. Tente de novo em instantes.');
  }

  async function enviar(texto, veioDoCampo) {
    texto = String(texto || '').trim().slice(0, LIMITE_TEXTO);
    if (!texto || emVoo || !TENANT || raiz.dataset.estado === 'indisponivel') return;
    emVoo = true;
    travarComposer(true);
    desativarChips();
    bolha('lead', texto);
    mostrarEscrevendo();

    var primeira = true;
    try {
      var r = await fetch(url('/chat/turn/stream'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: cabecalhos({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ text: texto }),
      });
      absorverId(r);
      if (!r.ok) { tirarEscrevendo(); await tratarErroHttp(r); return; }
      if (!r.body) { tirarEscrevendo(); bolha('erro', 'Não consegui responder agora. Tente de novo em instantes.'); return; }

      // Cada evento SSE traz uma fala; desenha na hora que chega (a cotação demora).
      var leitor = r.body.getReader();
      var dec = new TextDecoder();
      var buffer = '';
      for (;;) {
        var lido = await leitor.read();
        if (lido.done) break;
        buffer += dec.decode(lido.value, { stream: true });
        var partes = buffer.split('\n\n');
        buffer = partes.pop() || '';
        for (var p = 0; p < partes.length; p++) {
          var linha = partes[p].split('\n').filter(function (l) { return l.indexOf('data:') === 0; })[0];
          if (!linha) continue;
          var ev;
          try { ev = JSON.parse(linha.slice(5).trim()); } catch (e) { continue; }
          if (ev.tipo === 'msg') {
            if (primeira) { tirarEscrevendo(); primeira = false; }
            var plano = ev.interativo && typeof ev.interativo === 'object' ? ev.interativo : null;
            var corpo = plano && typeof plano.corpo === 'string' && plano.corpo.trim() ? plano.corpo : ev.texto;
            bolha('bot', corpo);
            if (plano) desenharChips(plano);
            // Volta o indicador: pode vir mais fala (a cotação ainda está correndo).
            mostrarEscrevendo();
          } else if (ev.tipo === 'fim') {
            tirarEscrevendo();
          } else if (ev.tipo === 'erro') {
            tirarEscrevendo();
            bolha('erro', typeof ev.erro === 'string' && ev.erro ? ev.erro : 'Não consegui responder agora.');
          }
        }
      }
      tirarEscrevendo();
    } catch (e) {
      tirarEscrevendo();
      bolha('erro', 'Sem conexão. Verifique sua internet e tente de novo.');
    } finally {
      emVoo = false;
      if (raiz.dataset.estado !== 'indisponivel') travarComposer(false);
      // Só devolve o foco quando o lead já estava digitando — evita abrir teclado no celular ao tocar chip.
      if (veioDoCampo && !campo.disabled) campo.focus();
    }
  }

  async function novaConversa() {
    if (emVoo) return;
    if (!PREVIEW && !window.confirm('Começar uma nova conversa? A atual será encerrada.')) return;
    try {
      await fetch(url('/chat/reset'), { method: 'POST', credentials: 'same-origin', headers: cabecalhos() });
    } catch (e) { /* segue: o id local some de qualquer jeito */ }
    apagarId();
    if (PREVIEW) conversaId = novoIdLocal();
    try {
      await retomar(identidade);
    } catch (e) {
      bolha('erro', 'Não consegui iniciar a conversa. Recarregue a página.');
    }
  }

  /* ---------- eventos ---------- */

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var t = campo.value;
    campo.value = '';
    autoAltura();
    ajustarEnviar();
    enviar(t, true);
  });
  campo.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!btnEnviar.disabled) form.requestSubmit ? form.requestSubmit() : btnEnviar.click();
    }
  });
  campo.addEventListener('input', function () { autoAltura(); ajustarEnviar(); });
  btnNova.addEventListener('click', novaConversa);
  btnFechar.addEventListener('click', function () { avisarPai({ evento: 'fechar' }); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && EMBED) avisarPai({ evento: 'fechar' });
  });
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.tipo !== 'rc-webchat') return;
    // Só foco — inofensivo, então não exige origem conhecida (o pai é o site da corretora).
    if (d.evento === 'abrir' && pronto && !campo.disabled && window.matchMedia('(pointer: fine)').matches) campo.focus();
  });

  /* ---------- início ---------- */

  var identidade = null;

  async function iniciar() {
    if (!TENANT) { indisponivel(); return; }
    if (PREVIEW) { elSelo.hidden = false; conversaId = novoIdLocal(); }
    else conversaId = lerId();
    if (EMBED) btnFechar.hidden = false;

    try {
      identidade = await carregarIdentidade();
    } catch (e) { identidade = null; }
    if (!identidade) { indisponivel(); return; }

    try {
      if (!(await retomar(identidade))) return;
    } catch (e) {
      bolha('erro', 'Não consegui carregar a conversa. Recarregue a página.');
    }
    pronto = true;
    raiz.dataset.estado = 'pronto';
    elStatus.textContent = 'online';
    btnNova.hidden = false;
    travarComposer(false);
    avisarPai({ evento: 'pronto' });
  }

  iniciar();
})();
