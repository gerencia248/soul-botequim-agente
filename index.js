// ============================================================
//  Soul Botequim — Agente Soul via WhatsApp (Z-API + Claude)
//  Servidor Node.js (Express) + Redis
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
  return ["que horas fecha","que horas abre","qual horario","qual o horário","horário de hoje",
    "fecha hoje","abre hoje","que horas","funcionamento","aberto agora","fechado agora"
  ].some(g => t.toLowerCase().includes(g));
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
// CORREÇÃO 1 — getStatusHorario()
// Problema original: madrugada (0h–4h) não era tratada como
// extensão operacional do dia anterior. Sexta às 00h47 retornava
// "fechado, abre hoje às 12h" mas o dia da semana ficava ambíguo
// para o Claude. Agora diaOp/hOp tratam a madrugada corretamente.
// ============================================================
function getStatusHorario() {
  const agora = new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" });
  const data = new Date(agora);
  const dia = data.getDay();  // 0=dom, 1=seg, 2=ter ... 6=sab
  const h = data.getHours() + data.getMinutes() / 60;

  // Madrugada (0h–4h): operacionalmente ainda é o dia anterior
  const diaOp = (h < 4) ? (dia === 0 ? 6 : dia - 1) : dia;
  const hOp   = (h < 4) ? h + 24 : h;  // ex: 0h47 → 24.78h

  // Segunda: fechado o dia todo
  if (diaOp === 1) return { aberto: false, fechaAs: null, proximaAbertura: "terça-feira às 16h" };

  // Terça, Quarta, Quinta: 16h–meia-noite
  if (diaOp >= 2 && diaOp <= 4) {
    if (hOp >= 16 && hOp < 28) return { aberto: true, fechaAs: "00h (meia-noite)" };
    if (diaOp === 4) return { aberto: false, fechaAs: null, proximaAbertura: "sexta-feira às 12h" };
    return { aberto: false, fechaAs: null, proximaAbertura: "hoje às 16h" };
  }

  // Sexta e Sábado: 12h–meia-noite
  if (diaOp === 5 || diaOp === 6) {
    if (hOp >= 12 && hOp < 28) return { aberto: true, fechaAs: "00h (meia-noite)" };
    return {
      aberto: false,
      fechaAs: null,
      proximaAbertura: diaOp === 6 ? "domingo às 12h" : "hoje às 12h"
    };
  }

  // Domingo: 12h–21h
  if (diaOp === 0) {
    if (hOp >= 12 && hOp < 21) return { aberto: true, fechaAs: "21h" };
    return { aberto: false, fechaAs: null, proximaAbertura: "terça-feira às 16h (segunda fechamos)" };
  }

  return { aberto: false, fechaAs: null, proximaAbertura: "em breve" };
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
  return `O bar está FECHADO agora (${dataAtual}). Próxima abertura: ${s.proximaAbertura}. Convide o cliente para reservar: https://widget.getinapp.com.br/d6NZKJ6V`;
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
  return `Você é Soul, o atendente do Soul Botequim — botequim descolado no coração do Brooklin, SP.

IDENTIDADE:
- Seu nome é Soul, atendente humano do Soul Botequim
- NUNCA diga que é robô, IA ou chatbot
- Se perguntarem, diga que é o atendente Soul

TOM E VOCABULÁRIO:
- Linguagem simpática, acolhedora e profissional
- Evite gírias excessivas
- Máximo 1 emoji por mensagem
- Respostas curtas — máximo 3 parágrafos
- NUNCA diga que não tem informações — tudo está neste prompt

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
- Tel: (11) 95498-7240 | Instagram: @soulbotequim | Gerente: Dourado
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
- Para reservas: https://widget.getinapp.com.br/d6NZKJ6V
- Programação musical: direcione para @soulbotequim
- Quando fechado, convide para reservar`;
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

  // Âncora temporal: par user/assistant pinado ANTES do histórico.
  // Garante que o Claude nunca use data/hora de contexto antigo do Redis.
  const mensagensComAncora = [
    {
      role: "user",
      content: `[CONTEXTO DO SISTEMA — NÃO MENCIONAR NA RESPOSTA] Data e hora exatas agora: ${getDataAtual()}. Status do bar agora: ${getTextoHorario()}. Use SEMPRE estas informações ao responder sobre dia da semana, data ou horário de funcionamento. Nunca use datas ou dias de mensagens anteriores desta conversa.`
    },
    {
      role: "assistant",
      content: "Entendido. Vou usar apenas as informações de data, hora e status do bar fornecidas acima em todas as minhas respostas."
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

// ── ENVIAR MENSAGEM ──────────────────────────────────────────
async function enviarMensagem(telefone, texto) {
  const url = "https://api.z-api.io/instances/" + CONFIG.ZAPI_INSTANCE_ID + "/token/" + CONFIG.ZAPI_TOKEN + "/send-text";
  await axios.post(url, { phone: telefone, message: texto },
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

    if (contemPalavroes(mensagem)) {
      await enviarMensagem(telefone, "Por favor, vamos manter a conversa respeitosa. Estou aqui para ajudar com cardápio, reservas ou qualquer dúvida sobre o Soul Botequim.");
      return res.status(200).json({ ok: true });
    }

    if (querFalarComHumano(mensagem)) {
      await enviarMensagem(telefone, "Claro! Vou acionar o Dourado para te atender pessoalmente. Um momento!");
      await enviarMensagem(CONFIG.NUMERO_DOURADO, "🔔 *Soul — Atendimento Humano*\n\nCliente " + telefone + " quer falar com atendente.\nMensagem: \"" + mensagem + "\"");
      return res.status(200).json({ ok: true });
    }

    if (querEventoCorporativo(mensagem)) {
      iniciarFluxoEvento(telefone);
      await enviarMensagem(telefone, "Ótimo! Ficamos felizes em receber sua empresa no Soul Botequim!\n\nVou precisar de algumas informações para montar o melhor pacote para vocês.\n\n" + ETAPAS_EVENTO[0].pergunta);
      return res.status(200).json({ ok: true });
    }

    if (perguntaSobreHorario(mensagem)) {
      const s = getStatusHorario();
      const resp = s.aberto
        ? "Estamos abertos agora e fechamos às " + s.fechaAs + ". Pode vir! Reserve pelo link: https://widget.getinapp.com.br/d6NZKJ6V"
        : "Estamos fechados no momento. Próxima abertura: " + s.proximaAbertura + ". Reserve: https://widget.getinapp.com.br/d6NZKJ6V";
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

    const resposta = await chamarClaude(telefone, mensagem);
    console.log("[" + new Date().toLocaleTimeString("pt-BR") + "] Resposta: " + resposta.substring(0, 80) + "...");
    await enviarMensagem(telefone, resposta);
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
  res.json({ status: "Soul Botequim online!", horario: getStatusHorario() });
});

app.listen(CONFIG.PORT, () => {
  console.log("\n🍺 Soul Botequim — Soul rodando na porta " + CONFIG.PORT);
  console.log("📡 Webhook: http://localhost:" + CONFIG.PORT + "/webhook\n");
});
