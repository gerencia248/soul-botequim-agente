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
};

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
  let anoUsar = ano;
  if (!anoUsar) {
    anoUsar = agora.getFullYear();
    const candidato = new Date(anoUsar, mes - 1, dia);
    if (candidato < agora) anoUsar++; // se data já passou este ano, assume próximo
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
  return [
    "aniversário","aniversario","casamento","bodas","formatura","despedida de solteiro",
    "despedida de solteira","chá de bebê","cha de bebe","chá de panela","cha de panela",
    "festa","comemoração","comemoracao","celebração","celebracao","bate-papo de noivos",
    "evento privado","evento particular","reservar o bar","fechar o bar","fechamento do bar"
  ].some(g => txt.includes(g));
}

// ── FLUXO DE EVENTOS CORPORATIVOS ───────────────────────────
const fluxoEventos = {};
const ETAPAS_EVENTO = [
  { campo: "nome",      pergunta: "Qual é o seu nome?" },
  { campo: "empresa",   pergunta: "Qual é o nome da sua empresa?" },
  { campo: "data",      pergunta: "Qual data você tem em mente para o evento?" },
  { campo: "pessoas",   pergunta: "Quantas pessoas participarão?" },
  { campo: "tipo",      pergunta: "Que tipo de evento é? (confraternização, reunião, aniversário, happy hour, outro)" },
  { campo: "orcamento", pergunta: "Qual é o orçamento aproximado?" },
];

function iniciarFluxoEvento(telefone) {
  fluxoEventos[telefone] = { etapa: 0, dados: {} };
}
function estaNoFluxoEvento(telefone) {
  return fluxoEventos[telefone] !== undefined;
}
async function processarFluxoEvento(telefone, mensagem) {
  const fluxo = fluxoEventos[telefone];
  const etapaAtual = ETAPAS_EVENTO[fluxo.etapa];
  fluxo.dados[etapaAtual.campo] = mensagem;
  fluxo.etapa++;
  if (fluxo.etapa < ETAPAS_EVENTO.length) {
    await enviarMensagem(telefone, ETAPAS_EVENTO[fluxo.etapa].pergunta);
    return;
  }
  const d = fluxo.dados;
  const id = "evento_" + Date.now();
  const eventos = await carregarEventos();
  eventos[id] = { telefone, ...d, criadoEm: new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) };
  await salvarEventos(eventos);
  delete fluxoEventos[telefone];
  await enviarMensagem(telefone, "Perfeito! Recebi todas as informações. Nosso gerente Dourado entrará em contato em breve para montar o pacote ideal. Qualquer dúvida, estou à disposição!");
  await enviarMensagem(CONFIG.NUMERO_DOURADO,
    "🎉 *NOVO LEAD — Evento Corporativo*\n\n" +
    "📱 Contato: " + telefone + "\n👤 Nome: " + d.nome + "\n🏢 Empresa: " + d.empresa +
    "\n📅 Data: " + d.data + "\n👥 Pessoas: " + d.pessoas + "\n🎊 Tipo: " + d.tipo + "\n💰 Orçamento: " + d.orcamento
  );
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
  if (["cardápio","cardapio","menu","o que tem","o que vocês servem","o que voces servem","o que tem pra comer","o que tem pra beber"].some(g => txt.includes(g))) return "completo";
  if (["drink","drinque","drinks","cocktail","coquetél","coquetel","bebida","bebidas"].some(g => txt.includes(g)) && !["vinho","dose","cachaça"].some(g => txt.includes(g))) return "drinks";
  if (["vinho","vinhos","carta de vinho","carta de vinhos","wine"].some(g => txt.includes(g))) return "vinhos";
  if (["dose","doses","cachaça","cachaca","whisky","whiskey","rum","tequila","vodka"].some(g => txt.includes(g))) return "doses";
  if (["comida","comer","petisco","petiscos","lanche","lanches","food","prato","proteína"].some(g => txt.includes(g))) return "comidas";
  return null;
}

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

DATA E HORA ATUAL (use sempre que precisar informar dia da semana, data ou horário):
${getDataAtual()}

HORÁRIO ATUAL:
${getTextoHorario()}

HORÁRIOS DE FUNCIONAMENTO:
- Terça, Quarta, Quinta: 16h até meia-noite
- Sexta e Sábado: 12h até meia-noite
- Domingo: 12h até 21h
- Segunda-feira: FECHADO

INFORMAÇÕES DO BAR:
- Endereço: Av. Padre Antônio José dos Santos, 812 — Brooklin, SP
- *Telefone do bar* (atendimento geral, reservas pelo widget): (11) 95498-7240
- *WhatsApp do gerente Dourado* (eventos, grupos grandes, casos especiais): (11) 95465-7178
- Instagram: @soulbotequim
- ATENÇÃO: o telefone do bar e o WhatsApp do Dourado são DIFERENTES. Nunca confunda. Quando precisar passar contato do Dourado, use SEMPRE (11) 95465-7178.
- Pet friendly | Área externa | Acesso para cadeirantes | Wi-Fi | Banheiro adaptado para cadeirantes
- Sem couvert | Taxa de rolha R$70 | Sem happy hour | Comanda individual
- Música: Jazz, Blues e Brasilidades — programação no Instagram @soulbotequim
- Drink mais famoso: Fitzgerald ⭐
- Reservas: https://widget.getinapp.com.br/d6NZKJ6V
- Sem valet — estacionamentos no entorno
- Aniversariante do dia: 1 drink ou chopp de cortesia ANTES do pagamento da conta (somente para o aniversariante do dia, não para acompanhantes) | Pode trazer somente bolo
- Não disponibilizamos barril de chopp para aniversário ou comemorações — somente o chopp que está nos bicos
- Cervejas: somente chopp artesanal, latas e garrafas artesanais | Temos cerveja zero alcoólico e sem glúten
- Sem voucher/vale-alimentação
- Pagamento: crédito (sem parcelamento), débito, Pix, dinheiro, Amex
- Temos projetor e televisão | Transmitimos jogos de futebol e outros esportes
- Temos opções veganas no cardápio
- Não temos petisco para animais (pet friendly apenas para a presença dos pets)

DRINKS AUTORAIS: Corsário, Dama da Noite, Carcarah, Amarelo Manga, Jacira, Caju Amigo, Macunaíma, Soul Punch, Bitter Giuseppe
DRINKS CLÁSSICOS: Fitzgerald, Negroni, Mojito, Caipirinha, El Diablo, Hibiscus Margarita, Aperol Spritz

RECOMENDAÇÕES:
- REFRESCANTE: Corsário, Mojito, Hibiscus Margarita, Aperol Spritz
- FORTE: Negroni, Macunaíma, Bitter Giuseppe
- CLÁSSICO: Fitzgerald (o mais pedido!), Caipirinha, Negroni
- TROPICAL: Caju Amigo, Carcarah, Amarelo Manga
- AUTORAL/DIFERENTE: Jacira, Dama da Noite, El Diablo

COMO AGIR:
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
- O link deve sempre aparecer puro, SEM ** ao redor, SEM colchetes`;
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

  const mensagensComAncora = [
    {
      role: "user",
      content: "INSTRUCAO OBRIGATORIA DO SISTEMA (prioridade maxima, nao mencionar ao cliente):\nHOJE E: " + dataAgora + "\nSTATUS DO BAR AGORA: " + statusAgora + "\nREGRA ABSOLUTA: Ignore completamente qualquer referencia a data, dia da semana ou horario que apareca nas mensagens anteriores desta conversa. Use SOMENTE as informacoes acima ao falar sobre horario, data ou funcionamento do bar." + ancoraDatas
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
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
        system: getSYSTEM_PROMPT(),
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

// ── ENVIAR MENSAGEM ──────────────────────────────────────────
async function enviarMensagem(telefone, texto) {
  const textoFinal = sanitizarParaWhatsApp(texto);
  const url = "https://api.z-api.io/instances/" + CONFIG.ZAPI_INSTANCE_ID + "/token/" + CONFIG.ZAPI_TOKEN + "/send-text";
  await axios.post(url, { phone: telefone, message: textoFinal },
    { headers: { "Client-Token": CONFIG.ZAPI_CLIENT_TOKEN, "Content-Type": "application/json" } });
}

// ── WEBHOOK ──────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;
    if (body.fromMe) return res.status(200).json({ ok: true });
    if (body.isGroup) return res.status(200).json({ ok: true });
    if (body.type && body.type !== "ReceivedCallback") return res.status(200).json({ ok: true });

    const msgId = body.messageId || body.id;
    if (await jaProcessou(msgId)) { console.log("[DUPLICADA] " + msgId); return res.status(200).json({ ok: true }); }

    const telefone = body.phone;
    const mensagem = body.text && body.text.message ? body.text.message : body.text;
    if (!telefone || !mensagem || typeof mensagem !== "string" || mensagem.trim() === "") return res.status(200).json({ ok: true });

    console.log("[" + new Date().toLocaleTimeString("pt-BR") + "] De " + telefone + ": " + mensagem);

    if (estaNoFluxoEvento(telefone)) { await processarFluxoEvento(telefone, mensagem); return res.status(200).json({ ok: true }); }

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
        // Evita re-disparar se já encaminhou nas últimas 6h
        const leadExistente = await obterLead(telefone);
        const jaEncaminhou = leadExistente && leadExistente.status === "encaminhado_dourado";
        const horasDesdeEnc = jaEncaminhou
          ? (Date.now() - new Date(leadExistente.criadoEm).getTime()) / 3600000
          : 999;

        // COOLDOWN: já encaminhou recentemente. Responde com mensagem fixa
        // pra não deixar o Claude improvisar com número errado.
        if (jaEncaminhou && horasDesdeEnc <= 6) {
          await enviarMensagem(telefone,
            "Fica tranquilo que já passei seu contato pro *Dourado*! Ele vai te chamar aqui no WhatsApp em alguns minutos pra alinhar tudo direitinho. 🍻\n\n" +
            "Se for urgente, pode chamar ele direto: (11) 95465-7178"
          );
          return res.status(200).json({ ok: true });
        }

        if (!jaEncaminhou || horasDesdeEnc > 6) {
          // Pega contexto da conversa pra Dourado
          const historico = await getHistorico(telefone);
          const ultimasMsgs = historico.slice(-6).map(m => {
            const quem = m.role === "user" ? "Cliente" : "Luz";
            return quem + ": " + String(m.content).substring(0, 250);
          }).join("\n");

          // Extrai dia/data se houver
          const datas = detectarDatasNaMensagem(mensagem);
          let dataInfo = "não informada";
          if (datas.length > 0) {
            const d = datas[0];
            const r = diaSemanaDeData(d.dia, d.mes, d.ano);
            dataInfo = r ? `${r.dataFormatada} (${r.nomeDia})` : `${d.dia}/${d.mes}`;
          }
          const tipo = ehEventoPessoal && grupoGrande ? "Evento + grupo grande"
            : ehEventoPessoal ? "Evento pessoal"
            : "Grupo grande (>30 pessoas)";

          // 1) Avisa o cliente
          await enviarMensagem(telefone,
            "Que legal! Pra " + (ehEventoPessoal ? "esse tipo de evento" : "grupos acima de 30 pessoas") +
            ", quem cuida pessoalmente é o *Dourado*, nosso gerente — assim a gente garante que tudo vai sair certinho. 🍻\n\n" +
            "Já vou avisar ele agora. Ele vai te chamar aqui pelo WhatsApp em alguns minutos pra alinhar tudo. Combinado?"
          );

          // 2) Notifica Dourado com lead RICO (com log explícito de sucesso/falha)
          const mensagemDourado =
            "🎉 *LEAD URGENTE — " + tipo + "*\n\n" +
            "📱 Cliente: " + telefone + "\n" +
            "👥 Quantidade: " + (qtdPessoas ? qtdPessoas + " pessoas" : "não informada") + "\n" +
            "📅 Data mencionada: " + dataInfo + "\n\n" +
            "*Últimas mensagens da conversa:*\n" + (ultimasMsgs || "(sem histórico)") + "\n\n" +
            "_⚡ A Luz já avisou o cliente que você vai chamar. Toque o quanto antes._";
          try {
            await enviarMensagem(CONFIG.NUMERO_DOURADO, mensagemDourado);
            console.log("[DOURADO ✓] Lead enviado com sucesso para " + CONFIG.NUMERO_DOURADO + " sobre cliente " + telefone);
          } catch (errDourado) {
            console.error("[DOURADO ✗] FALHA ao notificar Dourado (" + CONFIG.NUMERO_DOURADO + "): " + errDourado.message);
            // Mesmo se falhar pro Dourado, não quebra o fluxo do cliente
          }

          // 3) Salva lead com status especial
          await salvarLead(telefone, {
            pessoas: qtdPessoas,
            dia: datas.length > 0 ? (datas[0].dia + "/" + datas[0].mes) : null,
            status: "encaminhado_dourado",
          });

          console.log("[ENCAMINHADO] " + telefone + " (" + tipo + ", " + (qtdPessoas || "?") + " pessoas) → Dourado");
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
      iniciarFluxoEvento(telefone);
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
    const tipoCardapio = querCardapio(mensagem);
    if (tipoCardapio) {
      if (tipoCardapio === "drinks") {
        await enviarMensagem(telefone, CARDAPIO_DRINKS);
      } else if (tipoCardapio === "vinhos") {
        await enviarMensagem(telefone, CARDAPIO_VINHOS);
      } else if (tipoCardapio === "doses") {
        await enviarMensagem(telefone, CARDAPIO_DOSES);
      } else if (tipoCardapio === "comidas") {
        await enviarMensagem(telefone, CARDAPIO_COMIDAS);
      } else if (tipoCardapio === "completo") {
        await enviarMensagem(telefone, CARDAPIO_DRINKS);
        await enviarMensagem(telefone, CARDAPIO_VINHOS);
        await enviarMensagem(telefone, CARDAPIO_DOSES);
        await enviarMensagem(telefone, CARDAPIO_COMIDAS);
      }
      return res.status(200).json({ ok: true });
    }

    if (querVeganoVegetariano(mensagem)) {
      const txt = mensagem.toLowerCase();
      if (["vegano","vegana","plant based","plant-based"].some(g => txt.includes(g))) {
        await enviarMensagem(telefone, OPCOES_VEGANAS);
      } else {
        await enviarMensagem(telefone, OPCOES_VEGETARIANAS);
      }
      return res.status(200).json({ ok: true });
    }

    if (querRecomendacaoDrink(mensagem)) {
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
  if (phone !== CONFIG.NUMERO_DOURADO) {
    return res.status(403).send("Acesso negado");
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
    const { phone } = req.query;
    if (phone !== CONFIG.NUMERO_DOURADO) {
      return res.status(403).send("Acesso negado. Use ?phone=NUMERO_DO_GERENTE");
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
  const { phone } = req.query;
  if (phone !== CONFIG.NUMERO_DOURADO) {
    return res.status(403).send("Acesso negado. Use ?phone=NUMERO_DO_GERENTE");
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

// ── LIMPAR HISTÓRICO (use quando histórico Redis estiver corrompido) ──
// Acesse: GET /limpar-historico?telefone=5511999999999
app.get("/limpar-historico", async (req, res) => {
  try {
    const { telefone } = req.query;
    if (!telefone) return res.status(400).json({ erro: "Informe o telefone" });
    await redis.del("memoria:" + telefone);
    console.log("[ADMIN] Historico limpo para " + telefone);
    res.json({ ok: true, mensagem: "Historico de " + telefone + " limpo com sucesso." });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});
