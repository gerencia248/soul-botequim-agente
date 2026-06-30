// ============================================================
//  Soul Botequim — Agente Luz via WhatsApp (Z-API + Claude)
//  Servidor Node.js (Express) + Redis
//  Versão com correções de formatação WhatsApp, brevidade e
//  fluxo de reserva com pré-qualificação.
// ============================================================

const express = require("express");
const axios = require("axios");
const Redis = require("ioredis");
const app = express();
app.use(express.json());

const CONFIG = {
  ZAPI_INSTANCE_ID: process.env.ZAPI_INSTANCE_ID,
  ZAPI_TOKEN: process.env.ZAPI_TOKEN,
  ZAPI_CLIENT_TOKEN: process.env.ZAPI_CLIENT_TOKEN,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  PORT: process.env.PORT || 3000,
  NUMERO_DOURADO: "5511954657178",
  NUMERO_ITALO: "5511953580917", // fornecedores e entregadores
};

// ── ACESSO AO PAINEL (auditoria/dashboard) ──
// Se DASHBOARD_TOKEN estiver definido (Railway > Variables), exige ?token=SEGREDO.
// Senão, mantém o acesso por ?phone=NUMERO_DOURADO (compatível com o link atual).
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || null;
function painelAutorizado(req) {
  if (DASHBOARD_TOKEN) return !!req.query && req.query.token === DASHBOARD_TOKEN;
  return !!req.query && req.query.phone === CONFIG.NUMERO_DOURADO;
}

// ── REDIS ────────────────────────────────────────────────────
const redis = new Redis(process.env.REDIS_URL);
redis.on("connect", () => console.log("✅ Redis conectado!"));
redis.on("error", (e) => console.error("❌ Redis erro:", e.message));

// ── MEMÓRIA PERSISTENTE (Redis) ──────────────────────────────
async function carregarMemoria(telefone) {
  try {
    const val = await redis.get("memoria:" + telefone);
    return val ? JSON.parse(val) : [];
  } catch (e) { return []; }
}

async function salvarMemoria(telefone, historico) {
  try { await redis.set("memoria:" + telefone, JSON.stringify(historico)); }
  catch (e) { console.error("Erro ao salvar memória:", e.message); }
}

async function carregarEventos() {
  try {
    const val = await redis.get("eventos");
    return val ? JSON.parse(val) : {};
  } catch (e) { return {}; }
}

async function salvarEventos(eventos) {
  try { await redis.set("eventos", JSON.stringify(eventos)); }
  catch (e) { console.error("Erro ao salvar eventos:", e.message); }
}

// ── LEADS DE RESERVA (captura de intenção) ──────────────────
// Salvamos sempre que o bot manda o link de reserva, com o que
// conseguimos extrair da última mensagem do cliente (dia + pessoas).
// status: "pendente" | "confirmado" | "perdido"
async function salvarLead(telefone, dados) {
  try {
    const lead = {
      telefone,
      dia: dados.dia ?? null,
      pessoas: dados.pessoas ?? null,
      status: dados.status || "pendente",
      criadoEm: dados.criadoEm || new Date().toISOString(),
      lembreteEnviado: dados.lembreteEnviado || false,
      lembreteEnviadoEm: dados.lembreteEnviadoEm || null,
      confirmadoEm: dados.confirmadoEm || null,
      // Campos opcionais de lead enriquecido (Evento / Grupo Grande)
      nomeLead: dados.nomeLead ?? null,
      tipoLead: dados.tipoLead ?? null,
      horarioLead: dados.horarioLead ?? null,
      observacoesLead: dados.observacoesLead ?? null,
    };
    await redis.set("lead:" + telefone, JSON.stringify(lead), "EX", 86400 * 7); // 7 dias
    return lead;
  } catch (e) { console.error("Erro ao salvar lead:", e.message); return null; }
}
async function obterLead(telefone) {
  try {
    const v = await redis.get("lead:" + telefone);
    return v ? JSON.parse(v) : null;
  } catch (e) { return null; }
}
async function listarLeads() {
  try {
    const keys = await redis.keys("lead:*");
    const leads = [];
    for (const k of keys) {
      const v = await redis.get(k);
      if (v) { try { leads.push(JSON.parse(v)); } catch (e) {} }
    }
    return leads.sort((a, b) => (b.criadoEm || "").localeCompare(a.criadoEm || ""));
  } catch (e) { return []; }
}

// Extrai dia e quantidade de pessoas de uma mensagem livre.
function extrairDadosReserva(texto) {
  if (!texto) return { pessoas: null, dia: null };
  const t = texto.toLowerCase();
  const matchPessoas = t.match(/(\d+)\s*pessoa/);
  const diasMap = ["hoje","amanhã","amanha","segunda","terça","terca","quarta","quinta","sexta","sábado","sabado","domingo"];
  let dia = null;
  for (const d of diasMap) { if (t.includes(d)) { dia = d; break; } }
  return {
    pessoas: matchPessoas ? parseInt(matchPessoas[1]) : null,
    dia,
  };
}

// Detecta quando o cliente confirma uma reserva já iniciada.
function pareceConfirmacao(texto) {
  if (!texto) return false;
  const t = texto.toLowerCase();
  return ["confirmei","confirmado","fiz a reserva","reservei","reserva feita","ta feito","tá feito","já confirmei","ja confirmei","ja reservei","já reservei"].some(p => t.includes(p));
}

// ── DETECTOR DE DATAS + DIA DA SEMANA (BLINDAGEM ANTI-BUG) ──
// Quando o cliente menciona uma data (12/06, "dia 15", "15 de junho"),
// calculamos o dia da semana DETERMINISTICAMENTE e injetamos no contexto
// do Claude. Assim a Luz nunca mais vai perguntar ao cliente em que dia
// da semana uma data cai — o sistema sempre sabe.

const NOMES_DIAS_SEMANA = ["domingo","segunda-feira","terça-feira","quarta-feira","quinta-feira","sexta-feira","sábado"];
const NOMES_MESES_PT = {
  janeiro: 1, fevereiro: 2, março: 3, marco: 3, abril: 4, maio: 5, junho: 6,
  julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12
};

function detectarDatasNaMensagem(texto) {
  if (!texto) return [];
  const datas = [];

  // Pattern 1: DD/MM ou DD/MM/YY ou DD/MM/YYYY
  const re1 = /\b(\d{1,2})\s*\/\s*(\d{1,2})(?:\s*\/\s*(\d{2,4}))?\b/g;
  let m;
  while ((m = re1.exec(texto)) !== null) {
    const dia = parseInt(m[1]);
    const mes = parseInt(m[2]);
    if (dia < 1 || dia > 31 || mes < 1 || mes > 12) continue;
    let ano = m[3] ? parseInt(m[3]) : null;
    if (ano && ano < 100) ano += 2000;
    datas.push({ dia, mes, ano, original: m[0] });
  }

  // Pattern 2: "12 de junho" / "dia 15 de outubro"
  const re2 = /\b(\d{1,2})\s+de\s+(janeiro|fevereiro|março|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)/gi;
  while ((m = re2.exec(texto)) !== null) {
    const dia = parseInt(m[1]);
    const mes = NOMES_MESES_PT[m[2].toLowerCase()];
    if (mes && dia >= 1 && dia <= 31) {
      datas.push({ dia, mes, ano: null, original: m[0] });
    }
  }
  return datas;
}

function diaSemanaDeData(dia, mes, ano) {
  const agora = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  // Compara apenas a DATA (meia-noite), nunca a hora. Sem isso, uma data de HOJE
  // (ex.: cliente cita "06/06" no próprio dia 06/06) era tratada como "já passou" —
  // porque candidato fica à meia-noite e agora já passou da meia-noite — e o ano
  // rolava pro seguinte, retornando o dia da semana ERRADO (06/06/2026=sábado virava
  // 06/06/2027=domingo). Normalizar pra meia-noite corrige.
  const hojeMeiaNoite = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate());
  let anoUsar = ano;
  if (!anoUsar) {
    anoUsar = agora.getFullYear();
    const candidato = new Date(anoUsar, mes - 1, dia);
    if (candidato < hojeMeiaNoite) anoUsar++; // só rola pro próximo ano se a data REALMENTE já passou
  }
  const d = new Date(anoUsar, mes - 1, dia);
  if (isNaN(d.getTime())) return null;
  return {
    nomeDia: NOMES_DIAS_SEMANA[d.getDay()],
    diaSemanaIdx: d.getDay(),
    dataFormatada: d.toLocaleDateString("pt-BR"),
    anoUsado: anoUsar,
  };
}

function formatarContextoDatas(texto) {
  const datas = detectarDatasNaMensagem(texto);
  if (datas.length === 0) return "";
  const linhas = [];
  for (const d of datas) {
    const r = diaSemanaDeData(d.dia, d.mes, d.ano);
    if (r) linhas.push(`- "${d.original}" => ${r.dataFormatada} (${r.nomeDia})`);
  }
  if (linhas.length === 0) return "";
  return "\n\nINFO DETERMINISTICA (DATAS MENCIONADAS PELO CLIENTE):\n" +
    "O sistema calculou o dia da semana exato pra cada data citada:\n" +
    linhas.join("\n") +
    "\n\nUSE estas informacoes ao falar sobre as datas. NUNCA pergunte ao cliente em que dia da semana uma data cai — o sistema ja calculou.";
}

// ── DETECTOR DE DELIVERY/ENTREGA ─────────────────────────────
// Quando o cliente pergunta sobre delivery/entrega, injetamos a instrucao
// deterministica com o link do iFood, garantindo que a Luz sempre encaminhe.
const LINK_IFOOD = "https://www.ifood.com.br/delivery/sao-paulo-sp/soul-botequim-cidade-moncoes/ea4f128a-d5a3-4105-b5e7-631fed695741";
function mencionaDelivery(texto) {
  if (!texto) return false;
  const t = texto.toLowerCase();
  return [
    "delivery", "entrega", "entregam", "entregar", "entregue",
    "ifood", "i food", "pra viagem", "para viagem", "viagem",
    "pedir em casa", "pedido em casa", "leva em casa", "levam em casa",
    "tele entrega", "tele-entrega", "vocês entregam", "voces entregam", "voce entrega"
  ].some(k => t.includes(k));
}
function instrucaoDelivery(texto) {
  if (!mencionaDelivery(texto)) return "";
  return "\n\nINSTRUCAO DETERMINISTICA (DELIVERY): O cliente perguntou sobre delivery/entrega. " +
    "Responda de forma curta e simpatica que SIM, fazemos entrega pelo iFood, e mande o link PURO (sem ** sem colchetes): " +
    LINK_IFOOD;
}

// ── RESOLVER DE DIAS DA SEMANA (nome do dia → DATA exata) ────
// Sentido inverso do diaSemanaDeData: quando o cliente cita um DIA DA
// SEMANA ("que dia e sabado?", "sexta que vem", "amanha"), calculamos
// a DATA exata deterministicamente e injetamos no contexto, pra Luz
// nunca errar a conta (ex.: dizia que sabado era 19/06 quando era 20/06).
function resolverDiasSemana(texto) {
  if (!texto) return "";
  const t = texto.toLowerCase();
  const agora = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  const hoje = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate());
  const fmt = (d) => d.toLocaleDateString("pt-BR");
  const porData = new Map(); // dataStr -> { label, nomeDia }
  const reg = (label, d) => { const k = fmt(d); if (!porData.has(k)) porData.set(k, { label, nomeDia: NOMES_DIAS_SEMANA[d.getDay()] }); };

  if (/\bhoje\b/.test(t)) reg("hoje", hoje);
  if (/\bdepois de amanh[ãa]\b/.test(t)) { const d = new Date(hoje); d.setDate(d.getDate() + 2); reg("depois de amanhã", d); }
  else if (/\bamanh[ãa]\b/.test(t)) { const d = new Date(hoje); d.setDate(d.getDate() + 1); reg("amanhã", d); }

  const semana = [
    { nome: "domingo",       idx: 0, re: /\bdomingo\b/,            base: "domingo" },
    { nome: "segunda-feira", idx: 1, re: /\bsegunda(-feira)?\b/,   base: "segunda" },
    { nome: "terça-feira",   idx: 2, re: /\bter[çc]a(-feira)?\b/,  base: "ter[çc]a" },
    { nome: "quarta-feira",  idx: 3, re: /\bquarta(-feira)?\b/,    base: "quarta" },
    { nome: "quinta-feira",  idx: 4, re: /\bquinta(-feira)?\b/,    base: "quinta" },
    { nome: "sexta-feira",   idx: 5, re: /\bsexta(-feira)?\b/,     base: "sexta" },
    { nome: "sábado",        idx: 6, re: /\bs[áa]bado\b/,          base: "s[áa]bado" },
  ];
  for (const s of semana) {
    if (!s.re.test(t)) continue;
    let delta = (s.idx - hoje.getDay() + 7) % 7; // 0 = hoje
    // "X que vem" / "próximo X" → semana seguinte
    const proxima = new RegExp(s.base + "[^.]{0,15}(que vem|próxim|proxim)").test(t)
      || new RegExp("(próxim|proxim)\\w*\\s+" + s.base).test(t);
    if (proxima) delta += 7;
    const d = new Date(hoje); d.setDate(d.getDate() + delta);
    reg(s.nome, d);
  }
  if (porData.size === 0) return "";
  const linhas = [...porData.entries()].map(([data, v]) => `- "${v.label}" => ${data} (${v.nomeDia})`);
  return "\n\nINFO DETERMINISTICA (DIAS DA SEMANA CITADOS PELO CLIENTE):\n" +
    "O sistema JA calculou a DATA exata de cada dia citado. Use EXATAMENTE estas datas, NUNCA recalcule por conta propria:\n" +
    linhas.join("\n");
}

// ── EXTRATOR DE QUANTIDADE DE PESSOAS ───────────────────────
// Pega "30 pessoas", "umas 40", "por volta de 50", "30 a 40 convidados"
function extrairQuantidadePessoas(texto) {
  if (!texto) return null;
  const t = texto.toLowerCase();
  // Range "N a M pessoas" → pega o máximo
  let m = t.match(/(\d+)\s*(?:a|ou|até|ate|-)\s*(\d+)\s*(?:pessoas?|convidados?|gente|pax)/);
  if (m) return parseInt(m[2]);
  // "N pessoas/convidados/gente"
  m = t.match(/(\d+)\s*(?:pessoas?|convidados?|gente|pax)/);
  if (m) return parseInt(m[1]);
  // "por volta de N" / "em torno de N" / "umas N" / "uns N"
  m = t.match(/(?:por volta de|em torno de|cerca de|umas?|uns)\s*(\d+)/);
  if (m) return parseInt(m[1]);
  return null;
}

// ── DETECTOR DE EVENTO (pessoal ou corporativo) ─────────────
function querEventoOuFestaPessoal(t) {
  if (!t) return false;
  const txt = t.toLowerCase();
  // Só eventos PESSOAIS específicos vão pro Dourado independente do tamanho.
  // "festa"/"comemoração" genéricos foram removidos: "festa de 10 amigos" deve ir
  // pelo GetinApp normal (até 30), não pro Dourado.
  return [
    "aniversário","aniversario","casamento","bodas","formatura","despedida de solteiro",
    "despedida de solteira","chá de bebê","cha de bebe","chá de panela","cha de panela",
    "bate-papo de noivos",
    "evento privado","evento particular","reservar o bar","fechar o bar","fechamento do bar"
  ].some(g => txt.includes(g));
}

// ── FLUXO DE EVENTOS CORPORATIVOS (persistido no Redis) ─────
const ETAPAS_EVENTO = [
  { campo: "nome",      pergunta: "Qual é o seu nome?" },
  { campo: "empresa",   pergunta: "Qual é o nome da sua empresa?" },
  { campo: "data",      pergunta: "Qual data você tem em mente para o evento?" },
  { campo: "pessoas",   pergunta: "Quantas pessoas participarão?" },
  { campo: "tipo",      pergunta: "Que tipo de evento é? (confraternização, reunião, aniversário, happy hour, outro)" },
  { campo: "orcamento", pergunta: "Qual é o orçamento aproximado?" },
];

async function iniciarFluxoEvento(telefone) {
  await salvarFluxo("evento", telefone, { etapa: 0, dados: {} });
}
async function estaNoFluxoEvento(telefone) {
  return await temFluxo("evento", telefone);
}
async function processarFluxoEvento(telefone, mensagem) {
  const fluxo = await carregarFluxo("evento", telefone);
  if (!fluxo) return;
  const etapaAtual = ETAPAS_EVENTO[fluxo.etapa];
  fluxo.dados[etapaAtual.campo] = mensagem;
  fluxo.etapa++;
  if (fluxo.etapa < ETAPAS_EVENTO.length) {
    await salvarFluxo("evento", telefone, fluxo);
    await enviarMensagem(telefone, ETAPAS_EVENTO[fluxo.etapa].pergunta);
    return;
  }
  const d = fluxo.dados;
  const id = "evento_" + Date.now();
  const eventos = await carregarEventos();
  eventos[id] = { telefone, ...d, criadoEm: new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) };
  await salvarEventos(eventos);
  await apagarFluxo("evento", telefone);
  await enviarMensagem(telefone, "Perfeito! Recebi todas as informações. Nosso gerente Dourado entrará em contato em breve para montar o pacote ideal. Qualquer dúvida, estou à disposição!");
  await enviarMensagem(CONFIG.NUMERO_DOURADO,
    "🎉 *NOVO LEAD — Evento Corporativo*\n\n" +
    "📱 Contato: " + telefone + "\n👤 Nome: " + d.nome + "\n🏢 Empresa: " + d.empresa +
    "\n📅 Data: " + d.data + "\n👥 Pessoas: " + d.pessoas + "\n🎊 Tipo: " + d.tipo + "\n💰 Orçamento: " + d.orcamento
  );
}

// ── FLUXO DE COLETA DE LEAD COMPLETO (EVENTO PESSOAL / GRUPO GRANDE) ──
// Quando o cliente menciona evento pessoal ou grupo >30, em vez de mandar
// info parcial pro Dourado imediatamente, a Luz primeiro coleta TODOS os
// dados estruturados (nome, tipo, data, pessoas, horário, obs) e só DEPOIS
// encaminha o lead COMPLETO. Otimiza o tempo do Dourado.
const ETAPAS_LEAD_DOURADO = [
  { campo: "nome",        pergunta: "Beleza, deixa eu anotar tudo certinho pro Dourado já te chamar com tudo pronto. Primeiro: qual é o seu nome?" },
  { campo: "tipoEvento",  pergunta: "Que tipo de comemoração ou evento é? (aniversário, casamento, formatura, festa entre amigos, etc.)" },
  { campo: "dataEvento",  pergunta: "Pra qual data você está pensando?" },
  { campo: "pessoas",     pergunta: "Quantas pessoas, aproximadamente?" },
  { campo: "horario",     pergunta: "Tem um horário em mente? (ex: 'à noite', 'a partir das 20h')" },
  { campo: "observacoes", pergunta: "Por último: tem alguma preferência ou pedido especial? (decoração, cardápio personalizado, espaço reservado, bolo, etc.) Se não tiver nada específico, é só dizer 'nenhuma'." },
];

async function estaNoFluxoLeadDourado(telefone) {
  return await temFluxo("lead", telefone);
}

async function iniciarFluxoLeadDourado(telefone, dadosIniciais) {
  await salvarFluxo("lead", telefone, {
    etapa: -1,
    dados: dadosIniciais || {},
    iniciadoEm: new Date().toISOString()
  });
  await avancarFluxoLeadDourado(telefone, null);
}

async function avancarFluxoLeadDourado(telefone, respostaAtual) {
  const fluxo = await carregarFluxo("lead", telefone);
  if (!fluxo) return;

  // Guarda resposta da etapa atual (só se já fez ao menos uma pergunta)
  if (respostaAtual !== null && fluxo.etapa >= 0 && fluxo.etapa < ETAPAS_LEAD_DOURADO.length) {
    const etapaAtual = ETAPAS_LEAD_DOURADO[fluxo.etapa];
    fluxo.dados[etapaAtual.campo] = respostaAtual;
  }

  // Avança até encontrar próxima etapa não-preenchida (pula as que já têm dados)
  fluxo.etapa++;
  while (fluxo.etapa < ETAPAS_LEAD_DOURADO.length) {
    const etapa = ETAPAS_LEAD_DOURADO[fluxo.etapa];
    if (fluxo.dados[etapa.campo]) {
      fluxo.etapa++;
      continue;
    }
    await salvarFluxo("lead", telefone, fluxo); // salva o progresso ANTES de perguntar
    await enviarMensagem(telefone, etapa.pergunta);
    return;
  }

  // Fluxo completo → salva (com a última resposta) e finaliza
  await salvarFluxo("lead", telefone, fluxo);
  await finalizarLeadDourado(telefone);
}

async function processarFluxoLeadDourado(telefone, mensagem) {
  // Saída de emergência se cliente quiser cancelar
  const t = String(mensagem).toLowerCase();
  const cancelar = ["cancelar","desistir","deixa pra la","deixa pra lá","esqueci","esquece","não quero mais","nao quero mais","parar","sai dessa"];
  if (cancelar.some(g => t.includes(g))) {
    await apagarFluxo("lead", telefone);
    await enviarMensagem(telefone, "Tudo bem! Se mudar de ideia depois, é só me chamar. 🍻");
    return;
  }
  await avancarFluxoLeadDourado(telefone, mensagem);
}

async function finalizarLeadDourado(telefone) {
  const fluxo = await carregarFluxo("lead", telefone);
  if (!fluxo) return;
  const d = fluxo.dados;

  // 1) Avisa cliente
  await enviarMensagem(telefone,
    "Show, anotei tudo! 🍻\n\n" +
    "Vou passar agora pro *Dourado* (nosso gerente). Ele vai te chamar aqui no WhatsApp em alguns minutos pra alinhar o resto. Combinado?\n\n" +
    "Se for urgente, pode chamar ele direto: (11) 95465-7178"
  );

  // 2) Envia lead COMPLETO pro Dourado
  const mensagemDourado =
    "🎉 *NOVO LEAD COMPLETO — Evento/Grupo Grande*\n\n" +
    "📱 Contato cliente: " + telefone + "\n" +
    "👤 Nome: " + (d.nome || "(não informado)") + "\n" +
    "🎊 Tipo de evento: " + (d.tipoEvento || "(não informado)") + "\n" +
    "📅 Data: " + (d.dataEvento || "(não informada)") + "\n" +
    "👥 Pessoas: " + (d.pessoas || "(não informado)") + "\n" +
    "🕒 Horário: " + (d.horario || "(não informado)") + "\n" +
    "📝 Observações: " + (d.observacoes || "(nenhuma)") + "\n\n" +
    "_Cliente já foi avisado que você vai chamar. Lead 100% coletado pela Luz._";
  try {
    await enviarMensagem(CONFIG.NUMERO_DOURADO, mensagemDourado);
    console.log("[DOURADO ✓] Lead COMPLETO enviado para " + CONFIG.NUMERO_DOURADO + " | cliente: " + telefone);
  } catch (e) {
    console.error("[DOURADO ✗] FALHA ao enviar lead completo de " + telefone + ": " + e.message);
  }

  // 3) Salva no Redis com todos os campos
  await salvarLead(telefone, {
    pessoas: parseInt(d.pessoas) || null,
    dia: d.dataEvento || null,
    status: "encaminhado_dourado",
    nomeLead: d.nome,
    tipoLead: d.tipoEvento,
    horarioLead: d.horario,
    observacoesLead: d.observacoes,
  });

  // 4) Limpa o fluxo
  await apagarFluxo("lead", telefone);
}

// ── MEMÓRIA DE CONVERSAS ─────────────────────────────────────
async function getHistorico(telefone) { return await carregarMemoria(telefone); }
async function adicionarMensagem(telefone, role, content) {
  const h = await carregarMemoria(telefone);
  h.push({ role, content });
  if (h.length > 20) h.splice(0, h.length - 20);
  await salvarMemoria(telefone, h);
}

// ── CONTROLE DE DUPLICATAS ───────────────────────────────────
async function jaProcessou(msgId) {
  if (!msgId) return false;
  try {
    const resultado = await redis.set("msg:" + msgId, "1", "EX", 86400, "NX");
    return resultado === null;
  } catch (e) { return false; }
}

// ── ESTADO DE FLUXO (persistido no Redis — sobrevive a restart) ──
// Antes os fluxos de evento/grupo grande ficavam só na memória: se a Railway
// reiniciava (todo deploy), o cliente no meio da coleta perdia o progresso.
// Agora ficam no Redis, com TTL que expira fluxos abandonados sozinho.
const FLUXO_TTL = 3600; // 1h de inatividade -> expira automaticamente
async function carregarFluxo(tipo, telefone) {
  try { const v = await redis.get("fluxo:" + tipo + ":" + telefone); return v ? JSON.parse(v) : null; }
  catch (e) { return null; }
}
async function salvarFluxo(tipo, telefone, fluxo) {
  try { await redis.set("fluxo:" + tipo + ":" + telefone, JSON.stringify(fluxo), "EX", FLUXO_TTL); }
  catch (e) { console.error("Erro ao salvar fluxo:", e.message); }
}
async function apagarFluxo(tipo, telefone) {
  try { await redis.del("fluxo:" + tipo + ":" + telefone); } catch (e) {}
}
async function temFluxo(tipo, telefone) {
  try { return (await redis.exists("fluxo:" + tipo + ":" + telefone)) === 1; } catch (e) { return false; }
}

// ── CARDÁPIOS COMPLETOS ──────────────────────────────────────
const CARDAPIO_DRINKS = `🍹 *DRINKS AUTORAIS — Soul Botequim*

• CORSÁRIO R$38
  Rum, uvas, tomilho limão, suco de limão taiti e calda de agave

• DAMA DA NOITE R$38
  Rum, xarope de capim santo com mel e suco de limão siciliano

• CARCARAH R$36
  Cachaça, suco de limão siciliano e xarope de abacaxi

• AMARELO MANGA R$42
  Rum, licor de banana, suco de manga, suco de limão taiti e mel defumado

• JACIRA R$38
  Tiquira, suco de melão cantaloupe, suco de limão siciliano e xarope de açúcar de coco

• CAJU AMIGO R$38
  Cachaça, suco e compota de caju, suco de limão taiti e xarope simples

• MACUNAÍMA R$35
  Cachaça, suco de limão taiti, xarope simples e Fernet

• SOUL PUNCH R$38
  Rum, spiced rum, licor de laranja, suco de limão, xarope de abacaxi e refrigerante de gengibre

• BITTER GIUSEPPE R$42
  Cynas, vermute rosso, suco de limão siciliano e orange aromatic bitters

🍸 *DRINKS CLÁSSICOS — Soul Botequim*

• FITZGERALD R$39 ⭐ (o mais pedido!)
  Gin, suco de limão siciliano, xarope simples e aromatic bitters

• NEGRONI R$42
  Gin, Campari e vermute rosso

• MOJITO R$36
  Rum, hortelã, suco de limão taiti, xarope simples e água com gás

• CAIPIRINHA R$34 (com Vodka R$46)
  Cachaça, limão taiti e açúcar

• EL DIABLO R$38
  Tequila, licor de groselhas negras, suco de limão taiti e refrigerante de gengibre

• HIBISCUS MARGARITA R$39
  Tequila, licor de laranja, suco de limão taiti e xarope de hibisco

• APEROL SPRITZ R$38
  Aperol, espumante e água com gás

🥤 *NÃO ALCOÓLICOS*
• Mate da Casa R$26 — Infusão de mate tostado, suco de manga, limão taiti e xarope simples
• Shirley Temple R$26 — Xarope de frutas vermelhas, limão siciliano e refrigerante de gengibre
• Irarã R$26 — Matcha, suco de abacaxi, xarope de frutas passas e limão siciliano

🥤 *BEBIDAS*
Água R$9 | Tônica R$10 | Guaraná R$10 | Coca R$10 | Suco R$16`;

const CARDAPIO_VINHOS = `🍷 *CARTA DE VINHOS — Soul Botequim*

🫧 *BOLHAS*
• Eu Borbulho Branco Brut R$130
  Morada Cia Etílica | Chardonnay | Bento Gonçalves RS Brasil

🥃 *JEREZ*
• Delgado Zuleta R$160
  Jerez Fino | Sanlúcar de Barrameda Espanha

🌸 *ROSÉS*
• Falernia Rosé R$140
  Viña Falernia | Viognier e Syrah | Vale do Elqui Chile
• Le Loup Dans La Bergerie Rosé R$180
  Domaine de l'Hortus | Syrah, Cinsault | Languedoc França

🍊 *LARANJA*
• Lazy Winemaker R$150
  Echeverria | Sauvignon Blanc | Vale do Maule Chile

🥂 *BRANCOS*
• Lupi Reali Trebbiano d'Abruzzo R$130
  Passione Natura | Trebbiano | Abruzzo Itália
• Lazy Winemaker Chardonnay R$140
  Echeverria | Chardonnay | Vale do Maule Chile
• Durbanville Hills Chenin Blanc R$180
  Chenin Blanc | Cidade do Cabo África do Sul
• Sin R$190
  Amós Bañeres e Alex Ruiz | Xarel-lo | Catalunha Espanha
• The Stump Jump R$220
  D'Arenberg | Riesling, Marsanne e Roussane | McLaren Vale Austrália
• Pfaffmann Riesling Trocken (1L) R$230
  Weingut Heinz Pfaffmann | Riesling | Pfalz Alemanha
• Je T'aime Mais J'ai Soif NV R$240
  Domaine Vincent Caillé | Melon de Bourgogne e Marsanne | Loire França
• Les P'tits Gars Blanc R$260
  Domaine Oratoire Saint Martin | Grenache Blanc, Clairette, Vlognier e Roussaine | Rhône França

🍷 *TINTOS*
• Scorpio Malbec R$130
  Jasmine Monet | Malbec | Mendoza Argentina
• Dominio Cassis Cabernet Franc Reserva R$140
  Cabernet Franc | Lomas de la Paloma Uruguai
• Aqui Estamos Todos Locos R$150
  Niven | Lambrusco Maestri | Mendoza Argentina
• Regeneración Bonarda R$180
  Familia Kogan | Bonarda | Mendoza Argentina
• De Lucca Tannat Reserva R$190
  Lucca Wines | Tannat | Canelones Uruguai
• Sin Negre R$190
  Amós Bañeres e Alex Ruiz | Ull de Llebre | Catalunha Espanha
• Cabernet Sauvignon Funckenhausen (1L) R$220
  Cab. Sauvignon Malbec Petit Verdot | San Rafael Mendoza Argentina
• Un Air de la Réméjeanne R$230
  Domaine de la Réméjeanne | Grenache, Sirah | Rhône França
• Cousin Oscar R$240
  Domaine Rimbert | Cinsault, Pinot Noir | Languedoc França
• Unlitro Costa Toscana IGT R$250
  Ampeleia | Alicante Nero, Carignano, Sangiovese e Alicante Bouschet | Toscana Itália
• Hunter's Stoneburn Pinot Noir R$340
  Hunter's Wines | Pinot Noir | Marlborough Nova Zelândia`;

const CARDAPIO_COMIDAS = `🍽️ *CARDÁPIO DE COMIDAS — Soul Botequim*

🍢 *PETISCOS*
• Caldinho de Feijão R$26 — Com linguiça defumada, jarofinha de torresmo, cebolinha e torrada
• Coxinha de Frango e Catupiry R$36 — Crocante por fora, recheada com frango e catupiry (4 un)
• Torresmo de Panceta R$68 — Barriga de porco marinada, assada e frita
• Vinagrete Polvo R$75 — Picles de maçã-verde, tomates selecionados e chips de batata-doce
• Croquete de Carne R$40 — Carne assada lentamente com cebola, tomate, pimentões e azeitona
• Bolinho Carne Seca R$43 — Com muçarela e compota de abacaxi
• Frango Frito R$47 — Com nossa maionese de leite
• Cogumelos R$48 — Salteados na manteiga de alho e ervas, ovo caipira frito e focaccia
• Batata Frita R$42 — Com sal temperado da casa e maionese de leite
• Bolovo R$30 — Ovo empanado com a massa do nosso croquete
• Pastel Misto R$43 — De carne e queijo (6 unidades)
• Chips Batata Doce R$30 — Colorido, sequinho e bem feito
• Costelinha de Porco R$78 — Pro comer com a mão
• Quiabo na Brasa com Coalhada Fresca R$46 — Quiabo grelhado, coalhado e páprica picante
• Tulipinha de Frango Picante R$67 — Fritas com molho de pimenta coreana e mel
• Milanesa Aperitivo com Creme de Parmesão R$67 — Milanesa crocante, molho cremoso de parmesão
• Palmito Pupunha na Brasa R$65 — Com manteiga de alho, ervas e amêndoas torradas
• Bolinho de Mandioquinha e Carne de Panela R$27 — Mandioquinha cremosa, carne desfiada na cerveja
• Crudo de Atum e Cítricos R$78 — Atum cru, molho de cítricos, wasabi e flor de sal

🥩 *PROTEÍNAS*
• Steak Tartare R$76 — Carne crua na ponta da faca, com fritas e salada verde
• Rosbife Salada de Batata R$58 — Mal-passado, não negociamos o ponto
• Parmeggiana de Mignon R$68 — Do nosso jeito, com batata da casa
• Oswaldo Aranha R$95 — Filé mignon, alho frito, arroz de brócolis, fritas e farofa de cebola
• Fraldinha R$140 — Com chimichurri e farofa de cebola
• Ancho R$135 — Corte nobre na brasa, chimichurri e farofa de cebola
• Picanha R$165 — Com chimichurri, farofa de cebola, tomate e cebola assados
• Linguiça Aperitivo R$92 — Com chimichurri e farofa de cebola
• Legumes na Brasa R$70 — Com chimichurri e farofa de cebola

🍔 *LANCHES*
• Cheeseburger R$40 — American cheese. Extras: salada, bacon, tomate, cogumelos R$8 cada
• Bauru a Moda R$47 — Rosbife caseiro, queijo, tomate e mostarda
• Choripan R$42 — Com salsa roxa
• Soul Crispy Chicken R$43 — Frango empanado, molho tártaro e alface americana
• Fritas Acompanhamento R$22 — Meia porção da nossa batata

👶 *KIDS*
• Steak de Filé Mignon, Arroz e Fritas R$65
• Espaguette com Molho Pomodoro R$48

🍮 *SOBREMESA*
• Crepe de Doce de Leite Caramelizado R$32`;

const CARDAPIO_DOSES = `🥃 *DOSES — Soul Botequim*

🌾 *CACHAÇAS*
• Salinéssima Prata R$24
• Tié Prata R$28
• Weber Haus Amburana R$28
• Soledade Pau-Brasil R$36
• Porto Morretes R$36
• Matriarca 4 Madeiras R$40
• Maria Izabel Prata R$40
• Salineira Bálsamo R$52
• Gogó de Ema Alquimia R$52
• Colombina Jatobá R$50
• Sebastiana Duas Barricas R$80

🍹 *RUM*
• Havana 3 Anos R$38
• Havana 7 Anos R$42

🌵 *TEQUILA*
• Spolón R$42
• Spolón Reposado R$44

🥃 *WHISKY*
• Jameson R$38
• Jack Daniel's R$38
• Woodford Reserve R$46
• The Glenlivet Founder's R$50
• Ardbeg R$80

🍸 *VODKA*
• Absolut R$40`;

// ── OPÇÕES VEGANAS E VEGETARIANAS ───────────────────────────
const OPCOES_VEGANAS = `🌱 *OPÇÕES VEGANAS — Soul Botequim*

• Chips Batata Doce R$30 — Colorido, sequinho e bem feito
• Batata Frita R$42 — Com sal temperado da casa e maionese de leite*
• Palmito Pupunha na Brasa R$65 — Com manteiga de alho, ervas e amêndoas torradas*
• Legumes na Brasa R$70 — Com chimichurri e farofa de cebola
• Quiabo na Brasa com Coalhada Fresca R$46*

_*Consulte o garçom para adaptações_`;

const OPCOES_VEGETARIANAS = `🥗 *OPÇÕES VEGETARIANAS — Soul Botequim*

• Chips Batata Doce R$30 — Colorido, sequinho e bem feito
• Batata Frita R$42 — Com sal temperado da casa e maionese de leite
• Cogumelos R$48 — Salteados na manteiga de alho e ervas, ovo caipira frito e focaccia
• Quiabo na Brasa com Coalhada Fresca R$46 — Quiabo grelhado, coalhado e páprica picante
• Palmito Pupunha na Brasa R$65 — Com manteiga de alho, ervas e amêndoas torradas
• Legumes na Brasa R$70 — Com chimichurri e farofa de cebola`;

// ── FILTROS ──────────────────────────────────────────────────
const palavroes = ["puta","merda","caralho","porra","viado","idiota","imbecil","cretino","otario","otário","fdp","arrombado","babaca"];
function contemPalavroes(t) { return palavroes.some(p => t.toLowerCase().includes(p)); }

function querFalarComHumano(t) {
  return ["falar com atendente","falar com humano","falar com pessoa","atendente humano","quero um humano",
    "não quero robô","nao quero robo","falar com dourado","fala com o dourado","gerente"].some(g => t.toLowerCase().includes(g));
}

function querEventoCorporativo(t) {
  return ["evento corporativo","confraternização","confraternizacao","evento empresa","festa empresa",
    "reunião empresa","happy hour empresa","pacote evento","evento para empresa","aniversario empresa",
    "comemoração empresa","evento para grupo","reserva para empresa"].some(g => t.toLowerCase().includes(g));
}

function perguntaSobreHorario(t) {
  const txt = t.toLowerCase();
  // Se a pergunta menciona um DIA DIFERENTE DE HOJE (amanhã, sábado, etc.),
  // NÃO usamos o handler determinístico (que só sabe do "hoje").
  // Deixamos o Claude responder com contexto, pois ele tem a tabela completa de
  // horários no system prompt e sabe qual dia é hoje.
  const mencionaOutroDia = [
    "amanhã","amanha","depois de amanhã","depois de amanha",
    "segunda","terça","terca","quarta","quinta","sexta","sábado","sabado","domingo",
    "próxima semana","proxima semana","semana que vem","feriado","próximo","proximo"
  ].some(d => txt.includes(d));
  if (mencionaOutroDia) return false;
  // Só dispara handler determinístico quando a pergunta é claramente sobre AGORA/HOJE
  return ["que horas fecha","que horas abre","qual horario","qual o horário","horário de hoje",
    "fecha hoje","abre hoje","que horas","funcionamento","aberto agora","fechado agora"
  ].some(g => txt.includes(g));
}

function querRecomendacaoDrink(t) {
  return ["me indica","me recomenda","qual drink","o que você sugere","o que me recomenda",
    "não sei o que pedir","nao sei o que pedir","me sugere um drink","qual é o melhor",
    "algo refrescante","algo forte","drink leve","drink especial"].some(g => t.toLowerCase().includes(g));
}

function querVeganoVegetariano(t) {
  return ["vegano","vegana","vegetariano","vegetariana","sem carne","plant based","plant-based",
    "opção vegana","opcao vegana","opção vegetariana","opcao vegetariana","não come carne",
    "nao come carne","sem proteína animal","sem proteina animal"].some(g => t.toLowerCase().includes(g));
}

function querCardapio(t) {
  const txt = t.toLowerCase();
  // PRIMEIRO as categorias ESPECÍFICAS — assim "cardápio de comida" manda só comida,
  // "cardápio de vinho" só vinho, etc. (antes a palavra "cardápio" caía no completo).
  if (["vinho","vinhos","carta de vinho","carta de vinhos","wine"].some(g => txt.includes(g))) return "vinhos";
  if (["dose","doses","cachaça","cachaca","whisky","whiskey","rum","tequila","vodka"].some(g => txt.includes(g))) return "doses";
  if (["comida","comer","petisco","petiscos","lanche","lanches","food","prato","proteína"].some(g => txt.includes(g))) return "comidas";
  if (["drink","drinque","drinks","cocktail","coquetél","coquetel","bebida","bebidas"].some(g => txt.includes(g))) return "drinks";
  // SÓ DEPOIS o completo — quando pede "cardápio"/"menu" sem citar uma categoria.
  if (["cardápio","cardapio","menu","o que tem","o que vocês servem","o que voces servem","o que tem pra comer","o que tem pra beber"].some(g => txt.includes(g))) return "completo";
  return null;
}

// Cliente está PEDINDO UMA SUGESTÃO/RECOMENDAÇÃO (quer que a Luz indique e converse).
function pedeSugestao(t) {
  if (!t) return false;
  const txt = t.toLowerCase();
  return [
    "sugest","sugere","sugerir","recomend","indic",
    "o que é bom","o que e bom","o que tem de bom","o que tem de melhor",
    "o que você gosta","o que voce gosta","o que mais gosta","o que você mais gosta",
    "o que você acha","o que voce acha","o que vale a pena","o que pedir","o que devo pedir",
    "me ajuda a escolher","me ajuda escolher","uma dica","alguma dica","alguma sugestão",
    "qual o melhor","qual é o melhor","quais os melhores","o que você indica","o que voce indica"
  ].some(g => txt.includes(g));
}

// Quem está falando é FORNECEDOR ou ENTREGADOR (não é cliente do bar).
// Obs.: usa "entregador" e termos de fornecimento — NÃO usa só "entrega"
// (pra não confundir com cliente perguntando sobre delivery/iFood).
function ehFornecedorOuEntregador(t) {
  if (!t) return false;
  const txt = t.toLowerCase();
  return [
    "fornecedor","fornecedora","fornecimento","fornecer",
    "entregador","entregadora","motoboy","motoqueiro",
    "transportadora","transportador","distribuidora","distribuidor",
    "representante comercial","sou representante","mercadoria","mercadorias",
    "vim entregar","vim fazer entrega","trazer a entrega","entrega de mercadoria",
    "cheguei com a entrega","na portaria","pedido de compra","abastecimento",
    "reposição","reposicao","descarregar"
  ].some(g => txt.includes(g));
}

// Mensagem fala de COMIDA (pra não responder com pergunta de drink).
function falaDeComida(t) {
  if (!t) return false;
  const txt = t.toLowerCase();
  return ["comida","comer","petisco","petiscos","prato","pratos","lanche","lanches",
    "proteína","proteina","carne","carnes","sobremesa","beliscar","fome","jantar","almoç"].some(g => txt.includes(g));
}

// Cliente NÃO CONSEGUIU fazer a reserva pelo GetIn (link com erro / não abre).
// Precisa de PROBLEMA + CONTEXTO de reserva/link, pra não disparar à toa.
function naoConseguiuReservar(t) {
  if (!t) return false;
  const txt = t.toLowerCase();
  // Contexto OBRIGATÓRIO: precisa falar do LINK/GETIN/SITE (não basta "reserva",
  // senão "quero reservar" cairia aqui). Tolera variações de get in / get-in.
  const contexto = /\blink\b|get\s*-?\s*in|getin|widget|\bsite\b|p[áa]gina/.test(txt);
  if (!contexto) return false;
  // Sinal de PROBLEMA/dificuldade — tolerante a erros de digitação
  // (consigo/consego/consegu, reserva/reseva, etc.). Como o contexto já exige
  // link/getin, um "não" + link já indica que a reserva online falhou.
  const problema = /n[ãa]o|erro|trav|problema|ruim|caiu|fora do ar|cons[ei]g|dificuldade|complicad|deu pau|bug/.test(txt);
  return problema;
}

// Mensagem enviada quando o cliente não consegue reservar pelo GetIn.
const MSG_RESERVA_FALHOU = `Se você não está conseguindo fazer sua reserva pelo Get In, pode vir tranquilamente para o bar! Teremos vagas disponíveis para assistir ao jogo do Brasil.

Recomendamos apenas que chegue cedo para garantir seu lugar e aproveitar toda a emoção da partida com a gente.

Esperamos você para torcer pelo Brasil em um ambiente animado, com boa comida, bebidas geladas e muita energia positiva!`;

// ============================================================
// CORREÇÃO HORÁRIO (v2) — getStatusHorario()
// Lógica HONESTA: o bar fecha exatamente à meia-noite (00h).
// Removida a "extensão de madrugada" antiga (que dizia 'aberto até 4h'
// mas mandava mensagem 'fecha à meia-noite' — contradição que confundia
// o cliente e expunha que era bot).
//
// Comportamento agora:
//  - 00h–04h: bot diz "fechamos há pouco" (toque humano) + próxima abertura
//  - Restante do dia: comportamento padrão pelo dia da semana
// ============================================================
function getStatusHorario() {
  const agora = new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" });
  const data = new Date(agora);
  const dia = data.getDay();  // 0=dom, 1=seg, 2=ter ... 6=sab
  const h = data.getHours() + data.getMinutes() / 60;

  // Helper: monta resposta de fechado (com motivo opcional)
  const fechado = (proximaAbertura, motivo = null) => ({
    aberto: false,
    fechaAs: null,
    proximaAbertura,
    motivo
  });

  // Madrugada (0h–4h): trata o "fechamos há pouco" apenas quando o dia
  // anterior fechou À MEIA-NOITE (Ter, Qua, Qui, Sex, Sáb).
  // Segunda (fechada o dia todo) e Domingo (fecha às 21h) não geram "há pouco".
  if (h < 4) {
    const diaAnterior = (dia === 0) ? 6 : dia - 1;
    // "Há pouco" só se o dia anterior fechou recentemente (à meia-noite)
    const fechouMeiaNoite = diaAnterior >= 2 && diaAnterior <= 6;  // Ter-Sáb
    const motivoMadrugada = fechouMeiaNoite ? "fechamos há pouco (meia-noite)" : null;

    if (dia === 1) return fechado("terça-feira às 16h", motivoMadrugada);
    if (dia >= 2 && dia <= 4) return fechado("hoje às 16h", motivoMadrugada);
    if (dia === 5 || dia === 6) return fechado("hoje às 12h", motivoMadrugada);
    if (dia === 0) return fechado("hoje (domingo) às 12h", motivoMadrugada);
  }

  // Segunda: fechado o dia todo
  if (dia === 1) return fechado("terça-feira às 16h");

  // Terça, Quarta, Quinta: 16h até 00h (meia-noite)
  if (dia >= 2 && dia <= 4) {
    if (h >= 16) return { aberto: true, fechaAs: "00h (meia-noite)" };
    return fechado("hoje às 16h");
  }

  // Sexta e Sábado: 12h até 00h (meia-noite)
  if (dia === 5 || dia === 6) {
    if (h >= 12) return { aberto: true, fechaAs: "00h (meia-noite)" };
    return fechado("hoje às 12h");
  }

  // Domingo: 12h até 21h
  if (dia === 0) {
    if (h >= 12 && h < 21) return { aberto: true, fechaAs: "21h" };
    if (h >= 21) return fechado("terça-feira às 16h (segunda fechamos)");
    return fechado("hoje às 12h");
  }

  return fechado("em breve");
}

// ============================================================
// CORREÇÃO 3 — getTextoHorario()
// Agora inclui dia da semana e hora explícitos no texto,
// eliminando qualquer ambiguidade para o Claude.
// ============================================================
function getTextoHorario() {
  const s = getStatusHorario();
  const dataAtual = new Date().toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit"
  });
  if (s.aberto) {
    return `O bar está ABERTO agora (${dataAtual}) e fecha às ${s.fechaAs}.`;
  }
  const motivoTexto = s.motivo ? ` — ${s.motivo}` : "";
  return `O bar está FECHADO agora (${dataAtual})${motivoTexto}. Próxima abertura: ${s.proximaAbertura}. Convide o cliente para reservar: https://widget.getinapp.com.br/d6NZKJ6V`;
}

// ── DATA E HORA ATUAL ────────────────────────────────────────
function getDataAtual() {
  return new Date().toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

// ── SYSTEM PROMPT ────────────────────────────────────────────
function getSYSTEM_PROMPT() {
  return `Você é Luz, a atendente do Soul Botequim — botequim descolado no coração do Brooklin, SP.

IDENTIDADE:
- Seu nome é Luz, atendente humana do Soul Botequim
- NUNCA diga que é robô, IA ou chatbot
- Se perguntarem, diga que é a atendente Luz

TOM E VOCABULÁRIO:
- Linguagem simpática, acolhedora e profissional
- Evite gírias excessivas
- Respostas MUITO CURTAS: ideal 1 a 3 frases. Limite ABSOLUTO: 2 parágrafos.
- MÁXIMO 1 emoji na mensagem inteira (não 1 por parágrafo, não 1 por linha)
- NÃO repita saudação se já cumprimentou nesta conversa
- NUNCA diga que não tem informações — tudo está neste prompt

FORMATAÇÃO WHATSAPP (CRÍTICO — NÃO IGNORAR):
- Negrito: use UM asterisco *assim*. NUNCA use **dois** (vira markdown literal feio no app)
- Itálico: use UM underscore _assim_. NUNCA __dois__
- Riscado: ~assim~
- NUNCA use ###, **, __, [texto](link) — isso é Markdown padrão, NÃO funciona no WhatsApp
- Para links: cole a URL pura (https://...), sem colchetes, parênteses ou asteriscos ao redor

DATAS (REGRA INVIOLÁVEL):
- Quando o cliente mencionar uma data (ex: "12/06", "dia 15", "15 de junho"), o sistema injeta automaticamente no contexto qual dia da semana é essa data
- USE essa informação ao confirmar. Ex: "Perfeito, 12/06 cai numa sexta, anotei!"
- NUNCA, JAMAIS, EM NENHUMA HIPÓTESE pergunte ao cliente "em que dia da semana cai a data X?" — você JÁ TEM essa info do sistema
- Se a info do dia da semana NÃO aparecer no contexto pra uma data, é porque o cliente não citou data; pergunte só QUAL é a data, sem nunca perguntar dia da semana

ESCOPO:
- Você é atendente de bar, NÃO terapeuta ou conselheiro
- NUNCA invente informações que não estão neste prompt

DATA E HORA ATUAL:
A data/hora de HOJE e o status do bar (aberto/fechado) chegam SEMPRE no início
de cada conversa, na "INSTRUCAO OBRIGATORIA DO SISTEMA" (campos "HOJE E" e
"STATUS DO BAR AGORA"). Use SEMPRE esses valores; NUNCA invente data/hora.

HORÁRIOS DE FUNCIONAMENTO:
- Terça, Quarta, Quinta: 16h até meia-noite
- Sexta e Sábado: 12h até meia-noite
- Domingo: 12h até 21h
- Segunda-feira: FECHADO

EVENTO ESPECIAL — JOGO DA COPA (DOMINGO 05/07/2026):
- Domingo, 05/07/2026, vamos transmitir o jogo da Copa no projetor e na TV (domingo o bar abre normal, 12h às 21h).
- ⏰ RESERVAS pelo GetinApp só até as 14h, com 15 minutos de TOLERÂNCIA (a mesa fica guardada até no máximo 14h15).
- 👥 REGRA DA MESA: na hora, a mesa precisa ter MAIS DE 50% das pessoas do grupo presentes. Se não tiver mais da metade do grupo na mesa, ela será liberada para acomodar outros clientes. Avise isso com clareza e simpatia.
- 🚫 NÃO confirme reserva pelo bot: você (Luz) NUNCA diz que a reserva está confirmada para esse dia. A reserva só vale quando o cliente faz pelo GetinApp: https://widget.getinapp.com.br/d6NZKJ6V
- Se o cliente NÃO conseguir reservar pelo GetinApp, nesse domingo o atendimento é por ORDEM DE CHEGADA (sem reserva garantida) — oriente a chegar cedo pra garantir o lugar.
- Quando o cliente perguntar sobre o jogo da Copa de domingo (05/07), explique essas regras de forma curta e simpática: reserva pelo GetinApp até as 14h (tolerância de 15 min), precisa de mais de 50% do grupo na mesa, e quem não reservar entra por ordem de chegada.

INFORMAÇÕES DO BAR:
- Endereço: Av. Padre Antônio José dos Santos, 812 — Brooklin, SP
- *Telefone do bar* (atendimento geral, reservas pelo widget): (11) 95498-7240
- *WhatsApp do gerente Dourado* (apenas eventos pessoais e grupos ACIMA de 30 pessoas): (11) 95465-7178 — grupos de ATÉ 30 vão pelo GetinApp, não pro Dourado
- *Fornecedores e entregadores*: direcione SEMPRE para o Ítalo (11) 95358-0917 (responsável por compras/entregas)
- Instagram: @soulbotequim
- ATENÇÃO: o telefone do bar e o WhatsApp do Dourado são DIFERENTES. Nunca confunda. Quando precisar passar contato do Dourado, use SEMPRE (11) 95465-7178.
- Pet friendly | Área externa | Acesso para cadeirantes | Wi-Fi | Banheiro adaptado para cadeirantes
- Climatização: temos *aquecedores* para os dias frios. NÃO temos ar-condicionado, mas nosso ambiente é super fresco e arejado — fica gostoso o ano todo. Se perguntarem sobre ar-condicionado, diga isso com naturalidade e simpatia (sem ar-condicionado, porém ambiente fresquinho e aquecedores no frio).
- Sem couvert | Taxa de rolha R$70 | Sem happy hour | Comanda individual
- Música: Jazz, Blues e Brasilidades — programação no Instagram @soulbotequim
- Drink mais famoso: Fitzgerald ⭐
- Reservas: https://widget.getinapp.com.br/d6NZKJ6V
- IMPORTANTE CHEGAR CEDO: principalmente em dias cheios e de jogos, oriente sempre o cliente a chegar cedo. Se chegar muito tarde, NÃO garantimos que vamos conseguir atender/acomodar. Diga isso com simpatia, como um conselho pra ele não correr o risco de ficar sem lugar.
- Sem valet — estacionamentos no entorno
- Aniversariante do dia: 1 drink ou chopp de cortesia ANTES do pagamento da conta (somente para o aniversariante do dia, não para acompanhantes) | Pode trazer somente bolo
- Não disponibilizamos barril de chopp para aniversário ou comemorações — somente o chopp que está nos bicos
- Cervejas: somente chopp artesanal, latas e garrafas artesanais | Temos cerveja zero alcoólico e sem glúten
- Sem voucher/vale-alimentação
- Pagamento: crédito (sem parcelamento), débito, Pix, dinheiro, Amex
- Temos projetor e televisão | Transmitimos jogos de futebol e outros esportes
- COPA DO MUNDO: vamos transmitir TODOS os jogos da Copa (não só os do Brasil), no projetor e na TV! ⚽🌍 Quando o cliente perguntar sobre qualquer jogo da Copa (Brasil ou outras seleções), confirme com animação que vamos passar e convide a garantir a mesa/reserva (grupos até 30 pelo link do GetinApp).
- Temos opções veganas no cardápio
- Não temos petisco para animais (pet friendly apenas para a presença dos pets)
- DELIVERY/ENTREGA: fazemos entrega pelo iFood. Link do cardápio e pedidos: https://www.ifood.com.br/delivery/sao-paulo-sp/soul-botequim-cidade-moncoes/ea4f128a-d5a3-4105-b5e7-631fed695741

DRINKS AUTORAIS: Corsário, Dama da Noite, Carcarah, Amarelo Manga, Jacira, Caju Amigo, Macunaíma, Soul Punch, Bitter Giuseppe
DRINKS CLÁSSICOS: Fitzgerald, Negroni, Mojito, Caipirinha, El Diablo, Hibiscus Margarita, Aperol Spritz

RECOMENDAÇÕES:
- REFRESCANTE: Corsário, Mojito, Hibiscus Margarita, Aperol Spritz
- FORTE: Negroni, Macunaíma, Bitter Giuseppe
- CLÁSSICO: Fitzgerald (o mais pedido!), Caipirinha, Negroni
- TROPICAL: Caju Amigo, Carcarah, Amarelo Manga
- AUTORAL/DIFERENTE: Jacira, Dama da Noite, El Diablo

RECOMENDAÇÕES DE COMIDA (use para sugerir; indique 2-3 e converse, NUNCA mande o cardápio inteiro):
- PETISCOS MAIS PEDIDOS: Coxinha de Frango e Catupiry, Torresmo de Panceta, Croquete de Carne, Bolinho de Carne Seca, Cogumelos
- PRA DIVIDIR EM GRUPO: Costelinha de Porco, Frango Frito, Pastel Misto, Batata Frita
- PRATOS/CARNES: Oswaldo Aranha, Parmeggiana de Mignon, Picanha, Fraldinha
- LANCHES: Cheeseburger, Soul Crispy Chicken, Bauru a Moda
- DIFERENTE/SOFISTICADO: Crudo de Atum e Cítricos, Steak Tartare, Vinagrete Polvo, Palmito Pupunha na Brasa
- VEGGIE/LEVE: Cogumelos, Palmito Pupunha na Brasa, Legumes na Brasa, Quiabo na Brasa
- SOBREMESA: Crepe de Doce de Leite Caramelizado

COMO AGIR:
- SUGESTÃO/RECOMENDAÇÃO (de comida OU drink): NÃO mande o cardápio inteiro. Recomende 2-3 opções de forma simpática, diga rapidinho por que valem a pena, e pergunte a preferência (ex.: "prefere um petisco pra dividir ou um prato mais reforçado?", "algo leve ou mais encorpado?"). No fim, ofereça mandar o cardápio completo se ele quiser.
- Nunca invente preços ou itens fora do cardápio
- Programação musical: direcione para @soulbotequim
- Quando fechado, convide para reservar

FLUXO DE RESERVA (SEGUIR À RISCA):
- Se o cliente pede reserva mas NÃO informou ainda dia E quantidade de pessoas:
    NÃO mande o link de reserva ainda. Pergunte em UMA frase curta: "Pra quantas pessoas e qual dia?"
- Se o cliente já informou dia E quantidade (mesmo que aproximado):
    Confirme em 1 linha e mande o link puro: https://widget.getinapp.com.br/d6NZKJ6V
    Em seguida peça follow-up: "Me avisa aqui quando confirmar, beleza?"
- NUNCA mande o link de reserva mais de uma vez na mesma conversa
- O link deve sempre aparecer puro, SEM ** ao redor, SEM colchetes
- MESA ESPECÍFICA: se o cliente quiser uma mesa específica (ex.: na área externa, perto da TV, mesa do canto, mesa grande), oriente-o a escrever esse pedido no campo de *observação* na hora de fazer a reserva pelo link do GetinApp. Diga algo simpático como: "Pode pedir sim! É só colocar a mesa que você prefere no campo de observação quando fizer a reserva, que a gente já deixa reservadinha pra você 😊". Não garanta a mesa exata (depende da disponibilidade), mas deixe claro que a equipe vai tentar atender o pedido.

REGRA DO TAMANHO DO GRUPO (CRÍTICA — o limite é 30, siga à risca):
- ATÉ 30 pessoas (inclusive — ex.: 2, 10, 25, 30): SEMPRE mande o link do GetinApp (https://widget.getinapp.com.br/d6NZKJ6V). NÃO encaminhe pro Dourado. 25 ou 30 pessoas = GetinApp, NUNCA Dourado.
- ACIMA de 30 pessoas (31 ou mais): aí SIM encaminhe pro gerente Dourado no (11) 95465-7178.
- Eventos PESSOAIS (aniversário, casamento, formatura, despedida, chá de bebê/panela): encaminhe pro Dourado, independente do tamanho.
- "Happy hour", "encontro de amigos", "confraternização casual", grupo comum NÃO é evento pessoal — se for até 30, é GetinApp normal.
- Na dúvida sobre o tamanho, se for 30 ou menos, use o GetinApp.

FLUXO DE DELIVERY/ENTREGA (SEGUIR À RISCA):
- Se o cliente perguntar sobre delivery, entrega, "vocês entregam?", "fazem delivery?", "dá pra pedir pra viagem", "pedir em casa" ou similar:
    Responda de forma curta e simpática que SIM, fazemos entrega pelo iFood, e mande o link puro: https://www.ifood.com.br/delivery/sao-paulo-sp/soul-botequim-cidade-moncoes/ea4f128a-d5a3-4105-b5e7-631fed695741
- Mande o link puro, SEM ** ao redor, SEM colchetes, SEM parênteses
- Ex.: "Fazemos sim! 😊 É só pedir pelo nosso iFood aqui: https://www.ifood.com.br/delivery/sao-paulo-sp/soul-botequim-cidade-moncoes/ea4f128a-d5a3-4105-b5e7-631fed695741"

═══════════════════════════════════════════
CARDÁPIO COMPLETO COM PREÇOS — sua FONTE OFICIAL de preços e itens.
- Use para responder perguntas de preço/item de forma CONVERSADA e curta (ex.: "O Jameson é R$38 😊").
- NÃO cole o cardápio inteiro nessas respostas — responda só o que o cliente perguntou.
- Se o cliente quiser ver tudo, ele pede "cardápio" e o sistema envia os cards completos.
- NUNCA invente: se um item NÃO estiver na lista abaixo, diga com simpatia que não temos.
═══════════════════════════════════════════

${CARDAPIO_DRINKS}

${CARDAPIO_DOSES}

${CARDAPIO_VINHOS}

${CARDAPIO_COMIDAS}`;
}

// ============================================================
// CORREÇÃO 2 — chamarClaude()
// Problema original: o histórico de 20 mensagens no Redis tinha
// peso maior que o system prompt atualizado, fazendo o Claude
// usar contexto de data/hora de sessões anteriores.
// Solução: injeta uma âncora temporal fixada no início de cada
// chamada, antes do histórico, com data e horário atuais.
// ============================================================
async function chamarClaude(telefone, mensagemUsuario, tentativa = 1) {
  await adicionarMensagem(telefone, "user", mensagemUsuario);
  const historico = await getHistorico(telefone);

  // Ancora temporal blindada — injeta data/hora REAL antes de qualquer historico.
  // REGRA ABSOLUTA: o Claude DEVE ignorar qualquer data/dia/hora que apareca
  // no historico de mensagens anteriores e usar SOMENTE o valor abaixo.
  const dataAgora = getDataAtual();
  const statusAgora = getTextoHorario();
  // BLINDAGEM ADICIONAL: se o cliente mencionou alguma data na ultima mensagem,
  // calculamos deterministicamente o dia da semana e injetamos no contexto.
  const ancoraDatas = formatarContextoDatas(mensagemUsuario);
  const ancoraSemana = resolverDiasSemana(mensagemUsuario);
  const ancoraDelivery = instrucaoDelivery(mensagemUsuario);

  const mensagensComAncora = [
    {
      role: "user",
      content: "INSTRUCAO OBRIGATORIA DO SISTEMA (prioridade maxima, nao mencionar ao cliente):\nHOJE E: " + dataAgora + "\nSTATUS DO BAR AGORA: " + statusAgora + "\nREGRA ABSOLUTA: Ignore completamente qualquer referencia a data, dia da semana ou horario que apareca nas mensagens anteriores desta conversa. Use SOMENTE as informacoes acima ao falar sobre horario, data ou funcionamento do bar." + ancoraDatas + ancoraSemana + ancoraDelivery
    },
    {
      role: "assistant",
      content: "Confirmado. Hoje e " + dataAgora + ". " + statusAgora + " Vou usar exclusivamente estas informacoes em todas as respostas sobre data e horario. NUNCA vou perguntar ao cliente em que dia da semana uma data cai — o sistema sempre calcula por mim."
    },
    ...historico
  ];

  try {
    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        // Cache do prompt (cardápio + regras são fixos): a 1ª msg da conversa
        // "escreve" o cache e as seguintes (em ate 5 min) leem por ~10% do custo.
        system: [{ type: "text", text: getSYSTEM_PROMPT(), cache_control: { type: "ephemeral" } }],
        messages: mensagensComAncora
      },
      {
        headers: {
          "x-api-key": CONFIG.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
        },
        timeout: 60000
      }
    );
    const resposta = response.data.content[0].text;
    await adicionarMensagem(telefone, "assistant", resposta);
    return resposta;
  } catch (err) {
    if (tentativa < 3) {
      console.log("[RETRY " + tentativa + "] Tentando novamente para " + telefone);
      await new Promise(r => setTimeout(r, 2000 * tentativa));
      const h = await carregarMemoria(telefone);
      h.pop();
      await salvarMemoria(telefone, h);
      return chamarClaude(telefone, mensagemUsuario, tentativa + 1);
    }
    throw err;
  }
}

// ============================================================
// CORREÇÃO 4 — sanitizarParaWhatsApp()
// O Claude às vezes responde em Markdown padrão (**negrito**,
// ###, [texto](url), etc.) mas o WhatsApp usa formato próprio:
// *negrito*, _itálico_, ~riscado~. Este sanitizador converte
// automaticamente ANTES de enviar, garantindo que nada de
// markdown padrão chegue ao cliente formatado errado.
// ============================================================
function sanitizarParaWhatsApp(texto) {
  if (!texto) return texto;
  return texto
    .replace(/\*\*\*(.+?)\*\*\*/g, "*_$1_*")               // ***bold-italic*** → *_x_*
    .replace(/\*\*(.+?)\*\*/g, "*$1*")                      // **negrito** → *negrito*
    .replace(/__(.+?)__/g, "_$1_")                          // __itálico__ → _itálico_
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")                   // # / ## / ### Título → *Título*
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g, "$1: $2") // [texto](url) → texto: url
    .trim();
}

// ── ENVIO FRACIONADO ─────────────────────────────────────────
// Quebra a resposta em mensagens menores e envia em sequência com
// uma pequena pausa, deixando o atendimento mais humano (como uma
// pessoa digitando aos poucos). Mantém URLs sempre inteiras.
function dividirEmMensagens(texto) {
  if (!texto) return [];
  // 1) Quebra por parágrafos (linhas em branco / quebras de linha)
  const blocos = texto.split(/\n\s*\n|\n/).map(b => b.trim()).filter(Boolean);
  // 2) Blocos muito longos (e SEM link) são divididos por frase
  const LIMITE = 170;
  const partes = [];
  for (const bloco of blocos) {
    if (bloco.length <= LIMITE || /https?:\/\//.test(bloco)) { partes.push(bloco); continue; }
    const frases = bloco.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g) || [bloco];
    let buffer = "";
    for (const f of frases) {
      if (buffer && (buffer + f).length > LIMITE) { partes.push(buffer.trim()); buffer = f; }
      else buffer += f;
    }
    if (buffer.trim()) partes.push(buffer.trim());
  }
  return partes.length ? partes : [texto.trim()];
}

// ── ENVIAR MENSAGEM ──────────────────────────────────────────
async function enviarMensagem(telefone, texto, opts = {}) {
  const textoFinal = sanitizarParaWhatsApp(texto);
  // Conteúdos estruturados (cardápios, listas) devem ir INTEIROS numa única
  // mensagem: passe { fracionar: false }. O resto é fracionado normalmente.
  const partes = opts.fracionar === false ? [textoFinal] : dividirEmMensagens(textoFinal);
  const url = "https://api.z-api.io/instances/" + CONFIG.ZAPI_INSTANCE_ID + "/token/" + CONFIG.ZAPI_TOKEN + "/send-text";
  for (let i = 0; i < partes.length; i++) {
    // delayMessage: segundos que o WhatsApp mostra "digitando..." antes de enviar (mais humano).
    const digitando = Math.min(3, Math.max(1, Math.round(partes[i].length / 70)));
    await axios.post(url, { phone: telefone, message: partes[i], delayMessage: digitando },
      { headers: { "Client-Token": CONFIG.ZAPI_CLIENT_TOKEN, "Content-Type": "application/json" } });
    // Espaça as mensagens (mantém a ordem e um ritmo natural de digitação).
    if (i < partes.length - 1) {
      await new Promise(r => setTimeout(r, (digitando + 0.5) * 1000));
    }
  }
}

// ── WEBHOOK ──────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;
    if (body.fromMe) return res.status(200).json({ ok: true });
    if (body.isGroup) return res.status(200).json({ ok: true });
    // Ignora CANAIS / NEWSLETTERS / BROADCAST / STATUS — não são clientes reais.
    // (Ex.: "120363...@newsletter" estava virando lead-lixo e gastando IA à toa.)
    if (body.isNewsletter || body.isBroadcast || body.broadcast ||
        /@(newsletter|broadcast)|status@|@g\.us/i.test(String(body.phone || body.chatId || body.chatLid || ""))) {
      return res.status(200).json({ ok: true });
    }
    if (body.type && body.type !== "ReceivedCallback") return res.status(200).json({ ok: true });

    const msgId = body.messageId || body.id;
    if (await jaProcessou(msgId)) { console.log("[DUPLICADA] " + msgId); return res.status(200).json({ ok: true }); }

    const telefone = body.phone;

    // ── ÁUDIO: o bot ainda não transcreve. Em vez de ignorar, pede texto. ──
    if (telefone && body.audio && !(body.text && body.text.message)) {
      console.log("[AUDIO] de " + telefone + " — pedindo para mandar por texto");
      try { await enviarMensagem(telefone, "Oi! 😊 Por aqui ainda não consigo ouvir áudios. Pode me mandar sua mensagem por *texto*? Aí te ajudo rapidinho!"); } catch (e) {}
      return res.status(200).json({ ok: true });
    }

    const mensagem = body.text && body.text.message ? body.text.message : body.text;
    if (!telefone || !mensagem || typeof mensagem !== "string" || mensagem.trim() === "") return res.status(200).json({ ok: true });

    console.log("[" + new Date().toLocaleTimeString("pt-BR") + "] De " + telefone + ": " + mensagem);

    // ── FORNECEDOR / ENTREGADOR → encaminha para o Ítalo ──
    if (ehFornecedorOuEntregador(mensagem)) {
      console.log("[FORNECEDOR/ENTREGADOR] de " + telefone + " → Ítalo");
      await enviarMensagem(telefone, "Olá! 😊 Para *fornecedores e entregas*, por favor fale direto com o nosso responsável *Ítalo* no (11) 95358-0917. Ele cuida disso e vai te atender certinho!");
      try {
        await enviarMensagem(CONFIG.NUMERO_ITALO,
          "📦 *Fornecedor/Entregador entrou em contato*\n📱 " + telefone + "\n💬 \"" + String(mensagem).substring(0, 200) + "\"");
      } catch (e) { console.error("Erro ao avisar Ítalo:", e.message); }
      return res.status(200).json({ ok: true });
    }

    if (await estaNoFluxoEvento(telefone)) { await processarFluxoEvento(telefone, mensagem); return res.status(200).json({ ok: true }); }
    if (await estaNoFluxoLeadDourado(telefone)) { await processarFluxoLeadDourado(telefone, mensagem); return res.status(200).json({ ok: true }); }

    // ── CLIENTE NÃO CONSEGUIU RESERVAR PELO GETIN → convite pra vir ao bar ──
    if (naoConseguiuReservar(mensagem)) {
      console.log("[RESERVA-FALHOU] " + telefone + " — enviando convite pra vir ao bar");
      await enviarMensagem(telefone, MSG_RESERVA_FALHOU, { fracionar: false });
      return res.status(200).json({ ok: true });
    }

    // ── GRUPO GRANDE (acima de 30) OU EVENTO PESSOAL → encaminha pro Dourado ──
    // Regra: ATÉ 30 pessoas (inclusive) → fluxo normal pelo GetinApp.
    //        ACIMA de 30 pessoas (31+) → Dourado cuida pessoalmente.
    // Eventos pessoais (aniversário, casamento, etc.) sempre vão pro Dourado.
    // Manda lead PROATIVO pro Dourado com últimas 6 mensagens da conversa.
    {
      const qtdPessoas = extrairQuantidadePessoas(mensagem);
      const ehEventoPessoal = querEventoOuFestaPessoal(mensagem);
      const grupoGrande = qtdPessoas !== null && qtdPessoas > 30;
      const ehCorporativo = querEventoCorporativo(mensagem);
      // Evento corporativo continua indo pelo fluxo dedicado (com perguntas)
      if (!ehCorporativo && (grupoGrande || ehEventoPessoal)) {
        // SEMPRE inicia o fluxo de coleta quando detecta evento/grupo grande.
        // (Removida a regra anterior de "cooldown 6h" que bloqueava a coleta
        // de novas informações se houvesse lead recente. O cliente sempre tem
        // direito a fornecer info atualizada; o Dourado prefere receber lead
        // novo do que ficar sem dado.)
        {
          // Pré-popula dados que já conseguimos extrair da mensagem do cliente
          // (assim a Luz não pergunta o que já foi dito — fluxo mais natural)
          const datas = detectarDatasNaMensagem(mensagem);
          const dadosIniciais = {};
          if (qtdPessoas) dadosIniciais.pessoas = String(qtdPessoas);
          if (datas.length > 0) {
            const d = datas[0];
            const r = diaSemanaDeData(d.dia, d.mes, d.ano);
            dadosIniciais.dataEvento = r ? r.dataFormatada + " (" + r.nomeDia + ")" : d.dia + "/" + d.mes;
          }
          // Tenta inferir tipo de evento da mensagem
          const tiposDetectaveis = ["aniversário","aniversario","casamento","formatura","despedida","chá de panela","cha de panela","chá de bebê","cha de bebe"];
          for (const tipoT of tiposDetectaveis) {
            if (mensagem.toLowerCase().includes(tipoT)) {
              dadosIniciais.tipoEvento = tipoT.charAt(0).toUpperCase() + tipoT.slice(1);
              break;
            }
          }

          // 1) Avisa o cliente que vai coletar info pro Dourado
          await enviarMensagem(telefone,
            "Que legal! Pra " + (ehEventoPessoal ? "esse tipo de evento" : "grupos acima de 30 pessoas") +
            ", quem cuida pessoalmente é o *Dourado* (nosso gerente). 🍻\n\n" +
            "Antes de te passar pra ele, deixa eu só anotar uns detalhes pra ele já chegar com tudo na mão. Vai ser rapidinho!"
          );

          // 2) Inicia fluxo de coleta estruturada
          //    A primeira pergunta do fluxo é enviada automaticamente.
          //    Quando o fluxo completar, o lead COMPLETO vai pro Dourado.
          await iniciarFluxoLeadDourado(telefone, dadosIniciais);

          console.log("[FLUXO-LEAD] Iniciado para " + telefone + " com pre-dados: " + JSON.stringify(dadosIniciais));
          return res.status(200).json({ ok: true });
        }
      }
    }

    if (contemPalavroes(mensagem)) {
      await enviarMensagem(telefone, "Por favor, vamos manter a conversa respeitosa. Estou aqui para ajudar com cardápio, reservas ou qualquer dúvida sobre o Soul Botequim.");
      return res.status(200).json({ ok: true });
    }

    if (querFalarComHumano(mensagem)) {
      await enviarMensagem(telefone, "Claro! Vou acionar o Dourado para te atender pessoalmente. Um momento!");
      await enviarMensagem(CONFIG.NUMERO_DOURADO, "🔔 *Luz — Atendimento Humano*\n\nCliente " + telefone + " quer falar com atendente.\nMensagem: \"" + mensagem + "\"");
      return res.status(200).json({ ok: true });
    }

    if (querEventoCorporativo(mensagem)) {
      await iniciarFluxoEvento(telefone);
      await enviarMensagem(telefone, "Ótimo! Ficamos felizes em receber sua empresa no Soul Botequim!\n\nVou precisar de algumas informações para montar o melhor pacote para vocês.\n\n" + ETAPAS_EVENTO[0].pergunta);
      return res.status(200).json({ ok: true });
    }

    if (perguntaSobreHorario(mensagem)) {
      const s = getStatusHorario();
      const dataAtual = new Date().toLocaleString("pt-BR", {
        timeZone: "America/Sao_Paulo",
        weekday: "long",
        hour: "2-digit",
        minute: "2-digit"
      });
      const resp = s.aberto
        ? `Sim, estamos *ABERTOS* agora! 😊\n\nHoje é ${dataAtual} e funcionamos até às ${s.fechaAs}.\n\nVem pro Soul! Reserve: https://widget.getinapp.com.br/d6NZKJ6V`
        : `Agora estamos *FECHADOS*. 😔\n\nHoje é ${dataAtual}. Próxima abertura: ${s.proximaAbertura}.\n\nJá reserve sua mesa: https://widget.getinapp.com.br/d6NZKJ6V`;
      await enviarMensagem(telefone, resp);
      return res.status(200).json({ ok: true });
    }

    // ── CARDÁPIOS COMPLETOS ──
    // Se o cliente pede uma SUGESTÃO/RECOMENDAÇÃO, NÃO despeja o cardápio:
    // deixa a Luz conversar e indicar (cai no Claude / recomendação de drink).
    const tipoCardapio = querCardapio(mensagem);
    if (tipoCardapio && !pedeSugestao(mensagem)) {
      const inteiro = { fracionar: false };
      if (tipoCardapio === "drinks") {
        // Bebidas = drinks + doses (cachaças, rum, tequila...) juntos
        await enviarMensagem(telefone, CARDAPIO_DRINKS, inteiro);
        await enviarMensagem(telefone, CARDAPIO_DOSES, inteiro);
      } else if (tipoCardapio === "vinhos") {
        await enviarMensagem(telefone, CARDAPIO_VINHOS, inteiro);
      } else if (tipoCardapio === "doses") {
        await enviarMensagem(telefone, CARDAPIO_DOSES, inteiro);
      } else if (tipoCardapio === "comidas") {
        await enviarMensagem(telefone, CARDAPIO_COMIDAS, inteiro);
      } else if (tipoCardapio === "completo") {
        // Bebidas (drinks + doses) primeiro, depois vinhos e comidas
        await enviarMensagem(telefone, CARDAPIO_DRINKS, inteiro);
        await enviarMensagem(telefone, CARDAPIO_DOSES, inteiro);
        await enviarMensagem(telefone, CARDAPIO_VINHOS, inteiro);
        await enviarMensagem(telefone, CARDAPIO_COMIDAS, inteiro);
      }
      return res.status(200).json({ ok: true });
    }

    if (querVeganoVegetariano(mensagem)) {
      const txt = mensagem.toLowerCase();
      if (["vegano","vegana","plant based","plant-based"].some(g => txt.includes(g))) {
        await enviarMensagem(telefone, OPCOES_VEGANAS, { fracionar: false });
      } else {
        await enviarMensagem(telefone, OPCOES_VEGETARIANAS, { fracionar: false });
      }
      return res.status(200).json({ ok: true });
    }

    // Recomendação de DRINK (pergunta a preferência). Só quando NÃO fala de comida —
    // sugestão de comida vai pro Claude conversar com base nas recomendações do prompt.
    if (querRecomendacaoDrink(mensagem) && !falaDeComida(mensagem)) {
      await enviarMensagem(telefone, "Com prazer! Vou te ajudar a escolher o drink ideal.\n\nVocê prefere algo *refrescante*, *forte*, *clássico*, *tropical/brasileiro* ou algo *diferente e autoral*?");
      return res.status(200).json({ ok: true });
    }

    // ── CONFIRMAÇÃO DE RESERVA (atualiza lead pendente) ──
    if (pareceConfirmacao(mensagem)) {
      const lead = await obterLead(telefone);
      if (lead && lead.status === "pendente") {
        lead.status = "confirmado";
        lead.confirmadoEm = new Date().toISOString();
        await salvarLead(telefone, lead);
        await enviarMensagem(telefone, "Show! Reserva confirmada por aqui. Te esperamos! 🍻");
        await enviarMensagem(CONFIG.NUMERO_DOURADO,
          "✅ *Reserva CONFIRMADA*\n📱 " + telefone +
          "\n👥 " + (lead.pessoas || "?") + " pessoas" +
          "\n📅 " + (lead.dia || "?")
        );
        return res.status(200).json({ ok: true });
      }
      // sem lead pendente: deixa o Claude responder normal
    }

    const resposta = await chamarClaude(telefone, mensagem);
    console.log("[" + new Date().toLocaleTimeString("pt-BR") + "] Resposta: " + resposta.substring(0, 80) + "...");
    await enviarMensagem(telefone, resposta);

    // ── CAPTURA DE LEAD (se Claude mandou link de reserva) ──
    if (resposta && resposta.includes("widget.getinapp.com.br")) {
      try {
        const leadExistente = await obterLead(telefone);
        // evita duplicar lead se já tem um pendente recente
        const aindaPendente = leadExistente && leadExistente.status === "pendente";
        if (!aindaPendente) {
          const dadosExtraidos = extrairDadosReserva(mensagem);
          await salvarLead(telefone, { ...dadosExtraidos, status: "pendente" });
          console.log("[LEAD] Capturado para " + telefone + ": " + JSON.stringify(dadosExtraidos));
        }
      } catch (e) { console.error("[LEAD] Erro ao capturar:", e.message); }
    }

    res.status(200).json({ ok: true });

  } catch (error) {
    console.error("Erro no webhook:", error.response && error.response.data ? error.response.data : error.message);
    try {
      const tel = req.body && req.body.phone;
      if (tel) await enviarMensagem(tel, "Desculpe, tive um problema técnico. Por favor, tente novamente ou ligue: (11) 95498-7240.");
    } catch (e) {}
    res.status(500).json({ erro: error.message });
  }
});

// ── HEALTH CHECK ─────────────────────────────────────────────
app.get("/", async (req, res) => {
  res.json({ status: "Soul Botequim online!", horario: getStatusHorario(), dataAtual: getDataAtual(), textoHorario: getTextoHorario() });
});

// ============================================================
// SUÍTE DE TESTES DE HORÁRIO (blindagem anti-regressão)
// ============================================================
// Cada vez que alguém mexer em getStatusHorario() ou nos horários
// do bar, esta suíte vai apontar imediatamente se algum cenário
// quebrou. Roda no boot do servidor E sob demanda em /test-horarios.
//
// COMO MANTER:
// - Mudou horário do bar? Atualize os horários esperados aqui.
// - Adicionou novo dia/regra? Adicione casos de teste novos.
// - NUNCA delete casos sem entender o que eles cobrem.
// ============================================================
const TESTES_HORARIO = [
  // SEGUNDA — sempre fechado
  { iso: "2026-05-18T15:00:00-03:00", nome: "Segunda 15h (sempre fechada)",
    esperado: { aberto: false, proxima: /terça-feira às 16h/ } },
  { iso: "2026-05-18T20:00:00-03:00", nome: "Segunda 20h (sempre fechada)",
    esperado: { aberto: false, proxima: /terça-feira às 16h/ } },

  // TERÇA, QUARTA, QUINTA — 16h até meia-noite
  { iso: "2026-05-19T15:59:00-03:00", nome: "Terça 15:59 (1 min antes de abrir)",
    esperado: { aberto: false, proxima: /hoje às 16h/ } },
  { iso: "2026-05-19T16:00:00-03:00", nome: "Terça 16:00 (acabou de abrir)",
    esperado: { aberto: true, fechaAs: /meia-noite/ } },
  { iso: "2026-05-19T23:59:00-03:00", nome: "Terça 23:59 (último minuto aberto)",
    esperado: { aberto: true } },
  { iso: "2026-05-20T00:00:00-03:00", nome: "Qua 00:00 (acabou de fechar - madrugada)",
    esperado: { aberto: false, motivo: /fechamos há pouco/ } },
  { iso: "2026-05-20T02:30:00-03:00", nome: "Qua 02:30 (madrugada profunda)",
    esperado: { aberto: false, motivo: /fechamos há pouco/ } },
  { iso: "2026-05-20T10:00:00-03:00", nome: "Qua 10h (manhã, ainda fechado)",
    esperado: { aberto: false, proxima: /hoje às 16h/ } },
  { iso: "2026-05-21T15:00:00-03:00", nome: "Quinta 15h (antes de abrir - bug histórico)",
    esperado: { aberto: false, proxima: /hoje às 16h/ } },

  // SEXTA E SÁBADO — 12h até meia-noite
  { iso: "2026-05-22T11:59:00-03:00", nome: "Sexta 11:59 (1 min antes de abrir)",
    esperado: { aberto: false, proxima: /hoje às 12h/ } },
  { iso: "2026-05-22T12:00:00-03:00", nome: "Sexta 12:00 (acabou de abrir)",
    esperado: { aberto: true } },
  { iso: "2026-05-22T23:59:00-03:00", nome: "Sexta 23:59 (último minuto aberto)",
    esperado: { aberto: true } },
  { iso: "2026-05-23T00:00:00-03:00", nome: "Sab 00:00 (acabou de fechar - bug histórico)",
    esperado: { aberto: false, motivo: /fechamos há pouco/ } },
  { iso: "2026-05-23T00:30:00-03:00", nome: "Sab 00:30 (madrugada pós sexta)",
    esperado: { aberto: false, motivo: /fechamos há pouco/ } },
  { iso: "2026-05-23T15:00:00-03:00", nome: "Sábado 15h (tarde, aberto)",
    esperado: { aberto: true, fechaAs: /meia-noite/ } },
  { iso: "2026-05-24T01:00:00-03:00", nome: "Dom 01:00 (madrugada pós sábado)",
    esperado: { aberto: false, motivo: /fechamos há pouco/ } },

  // DOMINGO — 12h até 21h
  { iso: "2026-05-24T11:59:00-03:00", nome: "Domingo 11:59 (antes de abrir)",
    esperado: { aberto: false, proxima: /hoje às 12h/ } },
  { iso: "2026-05-24T13:00:00-03:00", nome: "Domingo 13h (aberto)",
    esperado: { aberto: true, fechaAs: /21h/ } },
  { iso: "2026-05-24T20:59:00-03:00", nome: "Domingo 20:59 (último minuto aberto)",
    esperado: { aberto: true } },
  { iso: "2026-05-24T21:00:00-03:00", nome: "Domingo 21:00 (acabou de fechar)",
    esperado: { aberto: false, proxima: /terça-feira/ } },
  { iso: "2026-05-25T02:00:00-03:00", nome: "Seg 02:00 (madrugada vinda de segunda fechada — NÃO deve dizer 'fechamos há pouco')",
    esperado: { aberto: false, motivoVazio: true } },
];

function rodarTestesHorario() {
  const origDate = global.Date;
  const resultados = [];
  try {
    for (const t of TESTES_HORARIO) {
      // Mock Date pra forçar uma data/hora específica
      const dataFixa = new origDate(t.iso);
      global.Date = class extends origDate {
        constructor(...args) {
          if (args.length === 0) return new origDate(dataFixa);
          return new origDate(...args);
        }
        static now() { return dataFixa.getTime(); }
      };
      let ok = true, motivoFalha = null, resultado = null;
      try {
        resultado = getStatusHorario();
        if (t.esperado.aberto !== undefined && resultado.aberto !== t.esperado.aberto) {
          ok = false; motivoFalha = `aberto=${resultado.aberto}, esperado=${t.esperado.aberto}`;
        }
        if (ok && t.esperado.fechaAs && !t.esperado.fechaAs.test(String(resultado.fechaAs || ""))) {
          ok = false; motivoFalha = `fechaAs="${resultado.fechaAs}" não casa com ${t.esperado.fechaAs}`;
        }
        if (ok && t.esperado.proxima && !t.esperado.proxima.test(String(resultado.proximaAbertura || ""))) {
          ok = false; motivoFalha = `proximaAbertura="${resultado.proximaAbertura}" não casa com ${t.esperado.proxima}`;
        }
        if (ok && t.esperado.motivo && !t.esperado.motivo.test(String(resultado.motivo || ""))) {
          ok = false; motivoFalha = `motivo="${resultado.motivo}" não casa com ${t.esperado.motivo}`;
        }
        if (ok && t.esperado.motivoVazio && resultado.motivo) {
          ok = false; motivoFalha = `motivo deveria ser vazio, veio "${resultado.motivo}"`;
        }
      } catch (e) {
        ok = false; motivoFalha = "EXCEÇÃO: " + e.message;
      }
      resultados.push({ nome: t.nome, ok, motivoFalha, resultado });
    }
  } finally {
    global.Date = origDate;  // SEMPRE restaura o Date original
  }
  return resultados;
}

// ── ENDPOINT DE AUDITORIA: /test-horarios?phone=NUMERO_DOURADO ──
app.get("/test-horarios", async (req, res) => {
  const { phone } = req.query;
  if (!painelAutorizado(req)) {
    return res.status(403).send("Acesso negado. Use ?phone=NUMERO_DO_GERENTE (ou ?token=SEGREDO se configurado).");
  }
  const resultados = rodarTestesHorario();
  const passou = resultados.filter(r => r.ok).length;
  const falhou = resultados.filter(r => !r.ok).length;
  const cor = falhou === 0 ? "#00cc66" : "#ff3344";
  const linhas = resultados.map(r => `
    <tr>
      <td>${r.ok ? "✅" : "❌"}</td>
      <td>${r.nome}</td>
      <td><code>${r.ok ? "OK" : (r.motivoFalha || "?")}</code></td>
      <td><code>${JSON.stringify(r.resultado || {})}</code></td>
    </tr>`).join("");
  res.send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
<title>Soul Botequim — Auditoria de Horário</title>
<style>
  body { font-family: -apple-system, sans-serif; padding: 24px; background: #1a1a1a; color: #eee; }
  h1 { color: ${cor}; }
  .resumo { background: ${cor}; color: #000; padding: 16px; border-radius: 8px; font-size: 20px; font-weight: bold; margin: 20px 0; }
  table { width: 100%; border-collapse: collapse; background: #2a2a2a; }
  th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #333; font-size: 13px; }
  th { background: #333; color: #f5b800; }
  code { background: #111; padding: 2px 6px; border-radius: 4px; font-size: 11px; color: #aaa; }
</style></head><body>
<h1>🛡️ Auditoria da Lógica de Horário</h1>
<div class="resumo">${falhou === 0 ? "✅ TODOS OS " + passou + " TESTES PASSARAM" : "❌ " + falhou + " DE " + resultados.length + " TESTE(S) FALHARAM — INVESTIGUE"}</div>
<table>
<thead><tr><th>✓</th><th>Cenário</th><th>Resultado</th><th>Output</th></tr></thead>
<tbody>${linhas}</tbody>
</table>
<p style="color:#666; margin-top:20px; font-size:12px;">Esta página roda a suíte de testes em tempo real. Cada vez que você recarrega, ela re-executa.</p>
</body></html>`);
});

app.listen(CONFIG.PORT, () => {
  console.log("\n🍺 Soul Botequim — Luz rodando na porta " + CONFIG.PORT);
  console.log("📡 Webhook: http://localhost:" + CONFIG.PORT + "/webhook");

  // ── BLINDAGEM: roda testes de horário no boot ──
  const res = rodarTestesHorario();
  const passou = res.filter(r => r.ok).length;
  const falhou = res.filter(r => !r.ok).length;
  console.log("\n📋 TESTES DE HORÁRIO: " + passou + "/" + res.length + " passaram");
  if (falhou > 0) {
    console.error("⚠️ ATENÇÃO: " + falhou + " teste(s) FALHOU(aram). Bot pode dar resposta errada!");
    for (const r of res.filter(r => !r.ok)) {
      console.error("  ✗ " + r.nome + " — " + r.motivoFalha);
    }
  } else {
    console.log("✅ Lógica de horário validada\n");
  }
});

// ── LEMBRETE AUTOMÁTICO DE RESERVA ───────────────────────────
// A cada 10 min, percorre os leads pendentes. Para os criados há
// mais de 30 min e menos de 4h sem lembrete enviado, manda 1 cutucada
// pedindo confirmação. Roda apenas uma vez por lead.
setInterval(async () => {
  try {
    const leads = await listarLeads();
    const agora = Date.now();
    for (const lead of leads) {
      if (lead.status !== "pendente") continue;
      if (lead.lembreteEnviado) continue;
      const criadoMs = new Date(lead.criadoEm).getTime();
      if (isNaN(criadoMs)) continue;
      const idadeMin = (agora - criadoMs) / 60000;
      if (idadeMin < 30 || idadeMin > 240) continue;
      try {
        await enviarMensagem(lead.telefone,
          "Oi! Conseguiu confirmar a reserva pelo link? Se precisar de qualquer ajuda, é só me chamar por aqui."
        );
        lead.lembreteEnviado = true;
        lead.lembreteEnviadoEm = new Date().toISOString();
        await salvarLead(lead.telefone, lead);
        console.log("[LEMBRETE] Enviado para " + lead.telefone);
      } catch (e) {
        console.error("[LEMBRETE] Falha ao enviar para " + lead.telefone + ":", e.message);
      }
    }
  } catch (e) { console.error("[LEMBRETE] Loop:", e.message); }
}, 10 * 60 * 1000);

// (Fluxos abandonados agora expiram sozinhos pelo TTL do Redis — ver FLUXO_TTL.)

// Marca leads pendentes "perdidos" após 24h (limpeza diária)
setInterval(async () => {
  try {
    const leads = await listarLeads();
    const agora = Date.now();
    for (const lead of leads) {
      if (lead.status !== "pendente") continue;
      const idadeH = (agora - new Date(lead.criadoEm).getTime()) / 3600000;
      if (idadeH >= 24) {
        lead.status = "perdido";
        await salvarLead(lead.telefone, lead);
        console.log("[LEAD] Marcado como perdido: " + lead.telefone);
      }
    }
  } catch (e) { console.error("[LEAD-EXPIRE]:", e.message); }
}, 60 * 60 * 1000); // 1x por hora

// ── DASHBOARD DE LEADS (acesso restrito ao gerente) ─────────
// Acesse: GET /dashboard?phone=5511954657178 (número do Dourado)
app.get("/dashboard", async (req, res) => {
  try {
    if (!painelAutorizado(req)) {
      return res.status(403).send("Acesso negado. Use ?phone=NUMERO_DO_GERENTE (ou ?token=SEGREDO se configurado).");
    }
    const leads = await listarLeads();
    const eventos = await carregarEventos();
    const pendentes = leads.filter(l => l.status === "pendente");
    const confirmados = leads.filter(l => l.status === "confirmado");
    const perdidos = leads.filter(l => l.status === "perdido");
    const taxa = leads.length > 0 ? (confirmados.length / leads.length * 100).toFixed(1) : "0";

    const fmt = (iso) => iso ? new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "—";
    const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

    const linhasLeads = leads.map(l => `
      <tr>
        <td>${esc(l.telefone)}</td>
        <td>${esc(l.pessoas || "?")}</td>
        <td>${esc(l.dia || "?")}</td>
        <td><span class="status status-${esc(l.status)}">${esc(l.status)}</span></td>
        <td>${fmt(l.criadoEm)}</td>
        <td>${l.lembreteEnviado ? "✓" : "—"}</td>
        <td>${fmt(l.confirmadoEm)}</td>
      </tr>`).join("");

    const linhasEventos = Object.entries(eventos).map(([id, e]) => `
      <tr>
        <td>${esc(e.nome)}</td>
        <td>${esc(e.empresa)}</td>
        <td>${esc(e.telefone)}</td>
        <td>${esc(e.pessoas)}</td>
        <td>${esc(e.data)}</td>
        <td>${esc(e.tipo)}</td>
        <td>${esc(e.orcamento)}</td>
        <td>${esc(e.criadoEm)}</td>
      </tr>`).join("");

    res.send(`<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8"><meta http-equiv="refresh" content="60">
<title>Soul Botequim — Painel</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; padding: 24px; background: #1a1a1a; color: #eee; margin: 0; }
  h1, h2 { color: #f5b800; }
  h1 { margin: 0 0 8px; }
  h2 { margin: 32px 0 12px; font-size: 18px; }
  .sub { color: #888; font-size: 13px; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin: 20px 0; }
  .card { background: #2a2a2a; padding: 18px; border-radius: 10px; border: 1px solid #333; }
  .card h3 { margin: 0 0 6px; color: #aaa; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
  .card .num { font-size: 32px; font-weight: 700; color: #f5b800; line-height: 1; }
  table { width: 100%; border-collapse: collapse; background: #2a2a2a; border-radius: 8px; overflow: hidden; font-size: 14px; }
  th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid #333; }
  th { background: #333; color: #f5b800; font-weight: 600; text-transform: uppercase; font-size: 11px; letter-spacing: 0.5px; }
  tr:last-child td { border-bottom: none; }
  .status { padding: 3px 10px; border-radius: 12px; font-size: 11px; font-weight: 600; text-transform: uppercase; }
  .status-pendente { background: #ff9900; color: #000; }
  .status-confirmado { background: #00cc66; color: #000; }
  .status-perdido { background: #555; color: #ccc; }
  .empty { padding: 30px; text-align: center; color: #666; }
  .footer { color: #666; font-size: 12px; margin-top: 40px; text-align: center; }
</style></head><body>
<h1>🍻 Soul Botequim — Painel</h1>
<div class="sub">Atualiza automaticamente a cada 60s · ${fmt(new Date().toISOString())}</div>
<div class="stats">
  <div class="card"><h3>Reservas pedidas</h3><div class="num">${leads.length}</div></div>
  <div class="card"><h3>Confirmadas</h3><div class="num">${confirmados.length}</div></div>
  <div class="card"><h3>Pendentes</h3><div class="num">${pendentes.length}</div></div>
  <div class="card"><h3>Perdidas</h3><div class="num">${perdidos.length}</div></div>
  <div class="card"><h3>Taxa de conversão</h3><div class="num">${taxa}%</div></div>
  <div class="card"><h3>Eventos corporativos</h3><div class="num">${Object.keys(eventos).length}</div></div>
</div>
<p style="color:#888;font-size:13px;margin:8px 0 16px">ℹ️ <b>Confirmadas</b> conta só quem avisou a confirmação aqui no chat. A maioria dos clientes confirma direto no widget do GetinApp (fora do bot), então esse número e a "taxa de conversão" ficam naturalmente baixos — não significa que as reservas não aconteceram.</p>
<h2>Reservas (últimos 7 dias)</h2>
${leads.length ? `<table><thead><tr><th>Telefone</th><th>Pessoas</th><th>Dia</th><th>Status</th><th>Pedido em</th><th>Lembrete</th><th>Confirmado em</th></tr></thead><tbody>${linhasLeads}</tbody></table>` : '<div class="empty">Nenhuma reserva ainda</div>'}
<h2>Eventos corporativos</h2>
${Object.keys(eventos).length ? `<table><thead><tr><th>Nome</th><th>Empresa</th><th>Telefone</th><th>Pessoas</th><th>Data</th><th>Tipo</th><th>Orçamento</th><th>Quando</th></tr></thead><tbody>${linhasEventos}</tbody></table>` : '<div class="empty">Nenhum evento ainda</div>'}
<div class="footer">Painel do gerente · Recarrega sozinho a cada 60s</div>
</body></html>`);
  } catch (e) {
    res.status(500).send("Erro: " + e.message);
  }
});

// ── TESTE DE NOTIFICAÇÃO AO DOURADO ─────────────────────────
// Envia mensagem de teste pro WhatsApp do Dourado pra você confirmar
// que a integração com o número dele está funcionando.
// Acesse: GET /test-dourado?phone=5511954657178
app.get("/test-dourado", async (req, res) => {
  if (!painelAutorizado(req)) {
    return res.status(403).send("Acesso negado. Use ?phone=NUMERO_DO_GERENTE (ou ?token=SEGREDO se configurado).");
  }
  try {
    const agora = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
    await enviarMensagem(CONFIG.NUMERO_DOURADO,
      "🧪 *Teste de notificação do bot Luz*\n\n" +
      "Se você está lendo esta mensagem, significa que a integração entre o bot e o seu WhatsApp está *funcionando perfeitamente*. ✅\n\n" +
      "Quando um cliente pedir evento ou reserva acima de 30 pessoas, você vai receber um lead automático aqui, parecido com este.\n\n" +
      "_Teste enviado em: " + agora + "_"
    );
    res.send(`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;background:#1a1a1a;color:#0c6;text-align:center">
      <h1>✅ Mensagem de teste enviada!</h1>
      <p>Verifique o WhatsApp do Dourado (${CONFIG.NUMERO_DOURADO}).</p>
      <p>Se a mensagem chegou, está tudo funcionando.</p>
      <p>Se NÃO chegou, abre os logs da Railway para ver o erro detalhado.</p>
    </body></html>`);
  } catch (e) {
    res.status(500).send(`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;background:#1a1a1a;color:#f33;text-align:center">
      <h1>❌ FALHA ao enviar pro Dourado</h1>
      <p>Erro: <code>${e.message}</code></p>
      <p>Provável causa: número errado, Dourado bloqueou o bot, ou Z-API com problema.</p>
    </body></html>`);
  }
});

// ── DISPARO: AVISO DO JOGO DO BRASIL (SEGUNDA 29/06) ─────────
// Envia UMA mensagem para clientes que JÁ conversaram com o bot e
// demonstraram interesse no jogo/Copa (mencionaram, em mensagens DELES,
// "jogo", "brasil", "copa", "assistir", "partida", "seleção", "futebol").
// Protegido por token. DRY-RUN por padrão: só LISTA quem receberia, sem enviar.
// Para ENVIAR DE VERDADE, acrescente &confirmar=ENVIAR na URL.
// Acesse: GET /disparar-jogo?phone=5511954657178
const MSG_AVISO_JOGO = `Oi! Aqui é a Luz, do Soul Botequim 🍺

Passando pra avisar: nesta *segunda-feira (29/06)* vamos abrir *exclusivamente* pra transmitir o *jogo do Brasil*! ⚽🇧🇷

🕐 Abertura especial: das *12h às 20h*
⏰ O jogo começa às *14h*

📌 Reservas só até as *12h30* desta segunda! Depois disso é por ordem de chegada, então garanta a sua: https://widget.getinapp.com.br/d6NZKJ6V

Chega cedo pra não perder o lugar e vem torcer com a gente! 🇧🇷`;

app.get("/disparar-jogo", async (req, res) => {
  if (!painelAutorizado(req)) {
    return res.status(403).json({ erro: "Acesso negado. Use ?phone=NUMERO_DO_GERENTE (ou ?token=SEGREDO)." });
  }
  try {
    const enviarDeVerdade = req.query.confirmar === "ENVIAR";
    const termos = ["jogo","brasil","copa","assistir","partida","seleção","selecao","futebol"];
    const keys = await redis.keys("memoria:*");
    const lista = [];
    for (const k of keys) {
      const tel = k.replace("memoria:", "");
      if (/@|status|newsletter|broadcast/i.test(tel)) continue; // ignora grupos/canais
      const v = await redis.get(k);
      if (!v) continue;
      let hist; try { hist = JSON.parse(v); } catch (e) { continue; }
      // Só olha as mensagens DO CLIENTE (role user), pra não dar falso-positivo
      // com respostas da Luz que mencionam Copa/jogo.
      const textoCliente = hist
        .filter(m => m.role === "user" && typeof m.content === "string")
        .map(m => m.content).join(" ").toLowerCase();
      if (termos.some(t => textoCliente.includes(t))) lista.push(tel);
    }
    const destinatarios = [...new Set(lista)];

    if (!enviarDeVerdade) {
      return res.json({
        modo: "PREVIEW (nada foi enviado)",
        totalDestinatarios: destinatarios.length,
        telefones: destinatarios,
        mensagemQueSeraEnviada: MSG_AVISO_JOGO,
        comoEnviarDeVerdade: "Acrescente &confirmar=ENVIAR no final da URL."
      });
    }

    let enviados = 0; const falhas = [];
    for (const tel of destinatarios) {
      try {
        await enviarMensagem(tel, MSG_AVISO_JOGO, { fracionar: false });
        enviados++;
        await new Promise(r => setTimeout(r, 4000)); // 4s entre cada (reduz risco de bloqueio)
      } catch (e) { falhas.push({ tel, erro: e.message }); }
    }
    console.log("[DISPARO-JOGO] Enviados: " + enviados + "/" + destinatarios.length);
    res.json({ modo: "ENVIADO", enviados, totalDestinatarios: destinatarios.length, falhas });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ── LIMPAR HISTÓRICO (use quando histórico Redis estiver corrompido) ──
// Acesse: GET /limpar-historico?telefone=5511999999999
app.get("/limpar-historico", async (req, res) => {
  try {
    if (!painelAutorizado(req)) {
      return res.status(403).json({ erro: "Acesso negado. Use ?phone=NUMERO_DO_GERENTE (ou ?token=SEGREDO)." });
    }
    const { telefone } = req.query;
    if (!telefone) return res.status(400).json({ erro: "Informe o telefone" });
    await redis.del("memoria:" + telefone);
    console.log("[ADMIN] Historico limpo para " + telefone);
    res.json({ ok: true, mensagem: "Historico de " + telefone + " limpo com sucesso." });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});
