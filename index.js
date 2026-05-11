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
  } catch (e) { console.error("Erro ao carregar memória:", e.message); return []; }
}

async function salvarMemoria(telefone, historico) {
  try {
    await redis.set("memoria:" + telefone, JSON.stringify(historico));
  } catch (e) { console.error("Erro ao salvar memória:", e.message); }
}

async function carregarEventos() {
  try {
    const val = await redis.get("eventos");
    return val ? JSON.parse(val) : {};
  } catch (e) { return {}; }
}

async function salvarEventos(eventos) {
  try {
    await redis.set("eventos", JSON.stringify(eventos));
  } catch (e) { console.error("Erro ao salvar eventos:", e.message); }
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
    "📱 Contato: " + telefone + "\n" +
    "👤 Nome: " + d.nome + "\n" +
    "🏢 Empresa: " + d.empresa + "\n" +
    "📅 Data: " + d.data + "\n" +
    "👥 Pessoas: " + d.pessoas + "\n" +
    "🎊 Tipo: " + d.tipo + "\n" +
    "💰 Orçamento: " + d.orcamento
  );
}

// ── MEMÓRIA DE CONVERSAS ─────────────────────────────────────
async function getHistorico(telefone) {
  return await carregarMemoria(telefone);
}

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

// ── HORÁRIO INTELIGENTE ──────────────────────────────────────
function getStatusHorario() {
  const agora = new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" });
  const data = new Date(agora);
  const dia = data.getDay();
  const h = data.getHours() + data.getMinutes() / 60;

  if (dia === 1) return { aberto: false, fechaAs: null, proximaAbertura: "terça-feira às 16h" };
  if (dia >= 2 && dia <= 4) return h >= 16 && h < 24 ? { aberto: true, fechaAs: "00h (meia-noite)" } : { aberto: false, fechaAs: null, proximaAbertura: "hoje às 16h" };
  if (dia === 5 || dia === 6) return h >= 12 && h < 24 ? { aberto: true, fechaAs: "00h (meia-noite)" } : { aberto: false, fechaAs: null, proximaAbertura: "hoje às 12h" };
  if (dia === 0) return h >= 12 && h < 21 ? { aberto: true, fechaAs: "21h" } : { aberto: false, fechaAs: null, proximaAbertura: "próxima terça às 16h (segunda fechamos)" };
  return { aberto: false, fechaAs: null, proximaAbertura: "em breve" };
}

function getTextoHorario() {
  const s = getStatusHorario();
  if (s.aberto) return "O bar está ABERTO agora e fecha às " + s.fechaAs + ". NUNCA informe horário diferente deste. NUNCA afirme que tem música ao vivo agora.";
  return "O bar está FECHADO agora. Próxima abertura: " + s.proximaAbertura + ". Convide o cliente para reservar: https://widget.getinapp.com.br/d6NZKJ6V";
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
- Evite gírias excessivas como 'mano', 'brother', 'saca', 'tamo junto'
- Máximo 1 emoji por mensagem
- Respostas curtas — máximo 3 parágrafos

ESCOPO:
- Você é atendente de bar, NÃO terapeuta ou conselheiro
- Se o cliente falar de tristeza ou assuntos pessoais, responda com empatia BREVEMENTE e redirecione para o bar
- NUNCA invente informações que não estão neste prompt
- NUNCA diga que não tem informações — tudo está neste prompt

HORÁRIO ATUAL (USE SEMPRE ESTA INFORMAÇÃO):
${getTextoHorario()}

HORÁRIOS DE FUNCIONAMENTO:
- Terça, Quarta, Quinta: abre às 16h e fecha à meia-noite (00h)
- Sexta e Sábado: abre às 12h e fecha à meia-noite (00h)
- DOMINGO: abre às 12h e fecha às 21h — NUNCA diga meia-noite no domingo!
- Segunda-feira: FECHADO o dia todo

INFORMAÇÕES DO BAR:
- Endereço: Av. Padre Antônio José dos Santos, 812 — Brooklin, SP
- Tel: (11) 95498-7240 | Instagram: @soulbotequim | Gerente: Dourado
- Pet friendly | Área externa na calçada | Acesso para cadeirantes | Wi-Fi
- Sem couvert | Taxa de rolha R$70 | Sem happy hour | Comanda individual
- Grupos grandes com espaço reservado
- Música: Jazz, Blues e Brasilidades — programação semanal no Instagram @soulbotequim
- Drink mais famoso: Fitzgerald
- Reservas: https://widget.getinapp.com.br/d6NZKJ6V
- Sem valet — estacionamentos no entorno
- Aniversariantes: 1 drink ou chopp de cortesia | Pode trazer somente bolo
- Cervejas: somente chopp artesanal, latas e garrafas artesanais
- Sem voucher/vale-alimentação
- Pagamento: crédito (sem parcelamento), débito, Pix, dinheiro, Amex

RECOMENDAÇÃO DE DRINKS:
- REFRESCANTE: Corsário, Mojito, Hibiscus Margarita, Aperol Spritz
- FORTE: Negroni, Macunaíma, Bitter Giuseppe
- CLÁSSICO: Fitzgerald (o mais pedido!), Caipirinha, Negroni
- TROPICAL: Caju Amigo, Carcarah, Amarelo Manga
- AUTORAL/DIFERENTE: Jacira, Dama da Noite, El Diablo

CARDÁPIO — DRINKS (com ingredientes):
- CORSÁRIO R$38 — Rum, uvas, tomilho limão, suco de limão taiti e calda de agave
- NEGRONI R$42 — Gin, Campari e vermute rosso
- DAMA DA NOITE R$38 — Rum, xarope de capim santo com mel e suco de limão siciliano
- CARCARAH R$36 — Cachaça, suco de limão siciliano e xarope de abacaxi
- AMARELO MANGA R$42 — Rum, licor de banana, suco de manga, suco de limão taiti e mel defumado
- BITTER GIUSEPPE R$42 — Cynas, vermute rosso, suco de limão siciliano e orange aromatic bitters
- EL DIABLO R$38 — Tequila, licor de groselhas negras, suco de limão taiti e refrigerante de gengibre
- JACIRA R$38 — Tiquira, suco de melão cantaloupe, suco de limão siciliano e xarope de açúcar de coco
- CAJU AMIGO R$38 — Cachaça, suco e compota de caju, suco de limão taiti e xarope simples
- MOJITO R$36 — Rum, hortelã, suco de limão taiti, xarope simples e água com gás
- CAIPIRINHA R$34 (com Vodka R$46) — Cachaça, limão taiti e açúcar
- FITZGERALD R$39 ⭐ — Gin, suco de limão siciliano, xarope simples e aromatic bitters
- MACUNAÍMA R$35 — Cachaça, suco de limão taiti, xarope simples e Fernet
- SOUL PUNCH R$38 — Rum, spiced rum, licor de laranja, suco de limão, xarope de abacaxi e refrigerante de gengibre
- HIBISCUS MARGARITA R$39 — Tequila, licor de laranja, suco de limão taiti e xarope de hibisco
- APEROL SPRITZ R$38 — Aperol, espumante e água com gás

DRINKS NÃO ALCOÓLICOS:
- MATE DA CASA R$26 — Infusão de mate tostado, suco de manga, suco de limão taiti e xarope simples
- SHIRLEY TEMPLE R$26 — Xarope de frutas vermelhas, suco de limão siciliano e refrigerante de gengibre
- IRARÃ R$26 — Matcha, suco de abacaxi, xarope de frutas passas com especiarias e suco de limão siciliano

BEBIDAS:
- Água com ou sem gás R$9 | Água tônica R$10 | Guaraná R$10 | Coca-Cola R$10 | Suco Villa Piva R$16

DOSES:
CACHAÇAS: Salinéssima Prata R$24 | Maria Izabel Prata R$40 | Tié Prata R$28 | Salineira Bálsamo R$52 | Colombina Jatobá R$50 | Soledade Pau-Brasil R$36 | Porto Morretes R$36 | Weber Haus Amburana R$28 | Sebastiana Duas Barricas R$80 | Gogó de Ema Alquimia R$52 | Matriarca 4 Madeiras R$40
RUM: Havana 7 Anos R$42 | Havana 3 Anos R$38
TEQUILA: Spolón R$42 | Spolón Reposado R$44
WHISKY: Ardbeg R$80 | The Glenlivet Founder's R$50 | Jameson R$38 | Woodford Reserve R$46 | Jack Daniel's R$38
VODKA: Absolut R$40

CARTA DE VINHOS COMPLETA:

BOLHAS:
- Eu Borbulho Branco Brut — Morada Cia Etílica | Chardonnay | Bento Gonçalves RS Brasil R$130

JEREZ:
- Delgado Zuleta — Jerez Fino | Sanlúcar de Barrameda Espanha R$160

ROSÉS:
- Falernia Rosé — Viña Falernia | Viognier e Syrah | Vale do Elqui Chile R$140
- Le Loup Dans La Bergerie Rosé — Domaine de l'Hortus | Syrah, Cinsault | Languedoc França R$180

LARANJA:
- Lazy Winemaker — Echeverria | Sauvignon Blanc | Vale do Maule Chile R$150

BRANCOS:
- Lupi Reali Trebbiano d'Abruzzo — Passione Natura | Trebbiano | Abruzzo Itália R$130
- Lazy Winemaker — Echeverria | Chardonnay | Vale do Maule Chile R$140
- Durbanville Hills Chenin Blanc — Durbanville Hills | Chenin Blanc | Cidade do Cabo África do Sul R$180
- Sin — Amós Bañeres e Alex Ruiz | Xarel-lo | Catalunha Espanha R$190
- The Stump Jump — D'Arenberg | Riesling, Marsanne e Roussane | McLaren Vale Austrália R$220
- Pfaffmann Riesling Trocken (1 litro) — Weingut Heinz Pfaffmann | Riesling | Pfalz Alemanha R$230
- Je T'aime Mais J'ai Soif NV — Domaine Vincent Caillé | Melon de Bourgogne e Marsanne | Loire França R$240
- Les P'tits Gars Blanc — Domaine Oratoire Saint Martin | Grenache Blanc, Clairette, Vlognier e Roussaine | Rhône França R$260

TINTOS:
- Scorpio Malbec — Jasmine Monet | Malbec | Mendoza Argentina R$130
- Dominio Cassis Cabernet Franc Reserva — Dominio Cassis | Cabernet Franc | Lomas de la Paloma Uruguai R$140
- Aqui Estamos Todos Locos — Niven | Lambrusco Maestri | Mendoza Argentina R$150
- Regeneración Bonarda — Familia Kogan | Bonarda | Mendoza Argentina R$180
- De Lucca Tannat Reserva — Lucca Wines | Tannat | Canelones Uruguai R$190
- Sin Negre — Amós Bañeres e Alex Ruiz | Ull de Llebre | Catalunha Espanha R$190
- Cabernet Sauvignon Funckenhausen (1 litro) — Funckenhausen | Cab. Sauvignon Malbec Petit Verdot | San Rafael Mendoza Argentina R$220
- Un Air de la Réméjeanne — Domaine de la Réméjeanne | Grenache, Sirah | Rhône França R$230
- Cousin Oscar — Domaine Rimbert | Cinsault, Pinot Noir | Languedoc França R$240
- Unlitro Costa Toscana IGT — Ampeleia | Alicante Nero, Carignano, Sangiovese e Alicante Bouschet | Toscana Itália R$250
- Hunter's Stoneburn Pinot Noir — Hunter's Wines | Pinot Noir | Marlborough Nova Zelândia R$340

CARDÁPIO — COMIDAS:

PETISCOS:
- Caldinho de Feijão R$26 — Com linguiça defumada, jarofinha de torresmo, cebolinha e torrada de bom pão
- Coxinha de Frango e Catupiry R$36 — Crocante por fora e suculenta por dentro, recheada com frango e catupiry (4 unidades)
- Torresmo de Panceta R$68 — Barriga de porco marinada, assada e frita
- Vinagrete Polvo R$75 — Com picles de maçã-verde, tomates selecionados. Acompanha chips de batata-doce
- Croquete de Carne R$40 — Carne assada lentamente com cebola, tomate, pimentões, salsinha e azeitona verde
- Bolinho Carne Seca R$43 — Com muçarela e compota de abacaxi
- Frango Frito R$47 — Com nossa maionese de leite
- Cogumelos R$48 — Cogumelos salteados na manteiga de alho e ervas e ovo caipira frito. Acompanha focaccia
- Batata Frita R$42 — Com sal temperado da casa e maionese de leite
- Bolovo R$30 — Ovo empanado com a massa do nosso croquete
- Pastel Misto R$43 — Tem de carne e de queijo (porção com 6, vem 3 de cada ou um sabor só)
- Chips Batata Doce R$30 — Colorido, divertido, sequinho e bem feito
- Costelinha de Porco R$78 — Pro comer com a mão é se lambuzar
- Quiabo na Brasa com Coalhada Fresca R$46 — Quiabo grelhado, coalhado e páprica picante
- Tulipinha de Frango Picante R$67 — Tulipihas de frango fritas, molho de pimenta coreana e mel
- Milanesa Aperitivo com Creme de Parmesão R$67 — Milanesa de carne crocante, molho cremoso de parmesão
- Palmito Pupunha na Brasa, Ervas e Amêndoas R$65 — Palmito pupunha fresco na brasa, manteiga de alho e ervas e amêndoas torradas
- Bolinho de Mandioquinha e Carne de Panela R$27 — Mandioquinha cremosa, carne desfiada cozida na cerveja
- Crudo de Atum e Cítricos R$78 — Lâminas de atum cru, molho de cítricos e toque de wasabi e flor de sal

PROTEÍNAS:
- Steak Tartare R$76 — Carne crua picada na ponta da faca e temperada no capricho. Acompanha fritas da casa e salada verde
- Rosbife Salada de Batata R$58 — Delicioso e mal-passado, não negociamos o ponto da carne
- Parmeggiana de Mignon R$68 — Parmeggiana do nosso jeito. Acompanha batata da casa
- Oswaldo Aranha R$95 — Filé mignon grelhado, alho frito, arroz de brócolis, fritas e farofa de cebola
- Fraldinha R$140 — Todos os cortes acompanham nosso chimichurri e farofa de cebola
- Ancho R$135 — Corte nobre na brasa, aqui em forma de refeição. Acompanha nosso chimichurri e farofa de cebola
- Picanha R$165 — Todos os cortes acompanham chimichurri, farofa de cebola, tomate e cebola assados
- Linguiça Aperitivo R$92 — Todos os cortes acompanham nossa chimichurri e farofa de cebola
- Legumes na Brasa R$70 — Todos os cortes acompanham nosso chimichurri e farofa de cebola

LANCHES:
- Cheeseburger R$40 — Com um bom American cheese. Extras: salada, bacon, tomate, molho, nossa chimichurri, cogumelos R$8,00 cada
- Bauru a Moda R$47 — Rosbife caseiro da casa, queijo, tomate e uma leve pincelada de mostarda
- Choripan R$42 — Com salsa roxa
- Soul Crispy Chicken R$43 — Sanduíche de peito de frango empanado, molho tártaro e alface americana
- Fritas Acompanhamento R$22 — Meia porção da nossa batata

PARA AS CRIANÇAS:
- Steak de Filé Mignon, Arroz e Fritas R$65 — Filé mignon grelhado, arroz branco e fritas
- Espaguette com Molho Pomodoro R$48 — Espaguete e molho de tomate caseiro

PARA ADOÇAR:
- Crepe de Doce de Leite Caramelizado R$32 — Crepe artesanal recheado com doce de leite cremoso

COMO AGIR:
- Português brasileiro, tom profissional e acolhedor
- Nunca invente preços ou itens fora do cardápio
- Para reservas: https://widget.getinapp.com.br/d6NZKJ6V
- Programação musical: sempre direcione para @soulbotequim no Instagram
- Quando fechado, sempre convide para reservar pelo Getin
- Ao apresentar a carta de vinhos, informe o nome, uva, origem e preço
- NUNCA diga que não tem informações — tudo está neste prompt`;
}

// ── CHAMAR CLAUDE ────────────────────────────────────────────
async function chamarClaude(telefone, mensagemUsuario) {
  await adicionarMensagem(telefone, "user", mensagemUsuario);
  const historico = await getHistorico(telefone);
  const response = await axios.post(
    "https://api.anthropic.com/v1/messages",
    { model: "claude-sonnet-4-5", max_tokens: 1024, system: getSYSTEM_PROMPT(), messages: historico },
    { headers: { "x-api-key": CONFIG.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" }, timeout: 30000 }
  );
  const resposta = response.data.content[0].text;
  await adicionarMensagem(telefone, "assistant", resposta);
  return resposta;
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
      let respHorario = "";
      if (s.aberto) {
        respHorario = "Estamos abertos agora e fechamos às " + s.fechaAs + ". Pode vir! Se quiser garantir sua mesa, reserve pelo link: https://widget.getinapp.com.br/d6NZKJ6V";
      } else {
        respHorario = "Estamos fechados no momento. Próxima abertura: " + s.proximaAbertura + ". Aproveite para fazer sua reserva: https://widget.getinapp.com.br/d6NZKJ6V";
      }
      await enviarMensagem(telefone, respHorario);
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
