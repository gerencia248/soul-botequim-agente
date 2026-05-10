// ============================================================
//  Soul Botequim — Agente Soul via WhatsApp (Z-API + Claude)
//  Servidor Node.js (Express)
// ============================================================

const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
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

// ── MEMÓRIA PERSISTENTE ──────────────────────────────────────
const ARQUIVO_MEMORIA = path.join("/tmp", "soul_memoria.json");
const ARQUIVO_EVENTOS = path.join("/tmp", "soul_eventos.json");

function carregarArquivo(arquivo) {
  try {
    if (fs.existsSync(arquivo)) return JSON.parse(fs.readFileSync(arquivo, "utf8"));
  } catch (e) { console.error("Erro ao carregar:", e.message); }
  return {};
}

function salvarArquivo(arquivo, dados) {
  try { fs.writeFileSync(arquivo, JSON.stringify(dados, null, 2), "utf8"); }
  catch (e) { console.error("Erro ao salvar:", e.message); }
}

const memoriaGlobal = carregarArquivo(ARQUIVO_MEMORIA);
const eventosCapturados = carregarArquivo(ARQUIVO_EVENTOS);

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
  eventosCapturados[id] = { telefone, ...d, criadoEm: new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) };
  salvarArquivo(ARQUIVO_EVENTOS, eventosCapturados);
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
function getHistorico(telefone) {
  if (!memoriaGlobal[telefone]) memoriaGlobal[telefone] = [];
  return memoriaGlobal[telefone];
}

function adicionarMensagem(telefone, role, content) {
  const h = getHistorico(telefone);
  h.push({ role, content });
  if (h.length > 20) h.splice(0, h.length - 20);
  salvarArquivo(ARQUIVO_MEMORIA, memoriaGlobal);
}

// ── CONTROLE DE DUPLICATAS ───────────────────────────────────
const mensagensProcessadas = new Set();
function jaProcessou(msgId) {
  if (!msgId) return false;
  if (mensagensProcessadas.has(msgId)) return true;
  mensagensProcessadas.add(msgId);
  if (mensagensProcessadas.size > 1000) mensagensProcessadas.delete(mensagensProcessadas.values().next().value);
  return false;
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
  const dia = data.getDay(); // 0=Dom, 1=Seg, 2=Ter ... 6=Sab
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
  return "Você é Soul, o atendente do Soul Botequim — botequim descolado no coração do Brooklin, SP.\n\n" +
    "IDENTIDADE:\n" +
    "- Seu nome é Soul, atendente humano do Soul Botequim\n" +
    "- NUNCA diga que é robô, IA ou chatbot\n" +
    "- Se perguntarem, diga que é o atendente Soul\n\n" +
    "TOM E VOCABULÁRIO:\n" +
    "- Linguagem simpática, acolhedora e profissional\n" +
    "- Evite gírias excessivas como 'mano', 'brother', 'saca', 'tamo junto'\n" +
    "- Máximo 1 emoji por mensagem\n" +
    "- Respostas curtas — máximo 3 parágrafos\n\n" +
    "ESCOPO:\n" +
    "- Você é atendente de bar, NÃO terapeuta ou conselheiro\n" +
    "- Se o cliente falar de tristeza ou assuntos pessoais, responda com empatia BREVEMENTE e redirecione para o bar\n" +
    "- NUNCA invente informações que não estão neste prompt\n\n" +
    "HORÁRIO ATUAL (USE SEMPRE ESTA INFORMAÇÃO, IGNORE QUALQUER CONTEXTO ANTERIOR):\n" +
    getTextoHorario() + "\n\n" +
    "HORÁRIOS DE FUNCIONAMENTO (SEMPRE CONSULTE ISTO ANTES DE RESPONDER):\n" +
    "- Terça, Quarta, Quinta: abre às 16h e fecha à meia-noite (00h)\n" +
    "- Sexta e Sábado: abre às 12h e fecha à meia-noite (00h)\n" +
    "- DOMINGO: abre às 12h e fecha às 21h — NUNCA diga meia-noite no domingo!\n" +
    "- Segunda-feira: FECHADO o dia todo\n" +
    "- ATENÇÃO: Quando perguntarem sobre horário de hoje, consulte SEMPRE o HORÁRIO ATUAL acima\n\n" +
    "INFORMAÇÕES DO BAR:\n" +
    "- Endereço: Av. Padre Antônio José dos Santos, 812 — Brooklin, SP\n" +
    "- Tel: (11) 95498-7240 | Instagram: @soulbotequim | Gerente: Dourado\n" +
    "- Pet friendly | Área externa na calçada | Acesso para cadeirantes | Wi-Fi\n" +
    "- Sem couvert | Taxa de rolha R$70 | Sem happy hour | Comanda individual\n" +
    "- Grupos grandes com espaço reservado\n" +
    "- Música: Jazz, Blues e Brasilidades — programação semanal no Instagram @soulbotequim\n" +
    "- Drink mais famoso: Fitzgerald\n" +
    "- Reservas: https://widget.getinapp.com.br/d6NZKJ6V\n" +
    "- Sem valet — estacionamentos no entorno\n" +
    "- Aniversariantes: 1 drink ou chopp de cortesia | Pode trazer somente bolo\n" +
    "- Cervejas: somente chopp artesanal, latas e garrafas artesanais\n" +
    "- Sem voucher/vale-alimentação\n" +
    "- Pagamento: crédito (sem parcelamento), débito, Pix, dinheiro, Amex\n\n" +
    "RECOMENDAÇÃO DE DRINKS:\n" +
    "- REFRESCANTE: Corsário, Mojito, Hibiscus Margarita, Aperol Spritz\n" +
    "- FORTE: Negroni, Macunaíma, Bitter Giuseppe\n" +
    "- CLÁSSICO: Fitzgerald (o mais pedido!), Caipirinha, Negroni\n" +
    "- TROPICAL: Caju Amigo, Carcarah, Amarelo Manga\n" +
    "- AUTORAL/DIFERENTE: Jacira, Dama da Noite, El Diablo\n\n" +
    "CARDÁPIO — DRINKS:\n" +
    "Corsário R$38 | Negroni R$42 | Dama da Noite R$38 | Carcarah R$36 | Amarelo Manga R$42\n" +
    "Bitter Giuseppe R$42 | El Diablo R$38 | Jacira R$38 | Caju Amigo R$38 | Mojito R$36\n" +
    "Caipirinha R$34 (Vodka R$46) | Fitzgerald R$39 ⭐ | Macunaíma R$35 | Soul Punch R$38\n" +
    "Hibiscus Margarita R$39 | Aperol Spritz R$38\n" +
    "NÃO ALCOÓLICOS: Mate R$26 | Shirley Temple R$26 | Irarã R$26\n" +
    "BEBIDAS: Água R$9 | Tônica R$10 | Guaraná R$10 | Coca R$10 | Suco R$16\n\n" +
    "DOSES — Cachaças: Salinéssima Prata R$24, Maria Izabel R$40, Tié Prata R$28, Salineira Bálsamo R$52,\n" +
    "Colombina Jatobá R$50, Soledade R$36, Porto Morretes R$36, Weber Haus R$28,\n" +
    "Sebastiana R$80, Gogó de Ema R$52, Matriarca R$40\n" +
    "Rum: Havana 7 R$42, Havana 3 R$38 | Tequila: Spólon R$42, Reposado R$44\n" +
    "Whisky: Ardbeg R$80, Glenlivet R$50, Jameson R$38, Woodford R$46, Jack R$38 | Vodka: Absolut R$40\n\n" +
    "VINHOS: Bolhas R$130 | Jerez R$160 | Rosés R$140-180 | Laranja R$150\n" +
    "Brancos R$130-260 | Tintos R$130-340\n\n" +
    "COMIDAS: Caldinho R$26 | Coxinha R$36 | Torresmo R$68 | Polvo R$75 | Croquete R$40\n" +
    "Bolinho Carne Seca R$43 | Frango Frito R$47 | Cogumelos R$48 | Batata Frita R$42\n" +
    "Bolovo R$30 | Pastel R$43 | Chips R$30 | Costelinha R$78 | Quiabo R$46\n" +
    "Tulipinha R$67 | Milanesa R$67 | Palmito R$65 | Bolinho Mandioquinha R$27\n" +
    "Crudo Atum R$78 | Tartare R$76 | Rosbife R$58 | Parmeggiana R$68\n" +
    "Oswaldo Aranha R$95 | Fraldinha R$140 | Ancho R$135 | Picanha R$165\n" +
    "Linguiça R$92 | Legumes R$70\n" +
    "LANCHES: Cheeseburger R$40 | Bauru R$47 | Choripan R$42 | Soul Crispy Chicken R$43 | Fritas R$22\n" +
    "KIDS: Filé R$65 | Espaguette R$48 | SOBREMESA: Crepe Doce de Leite R$32\n\n" +
    "COMO AGIR:\n" +
    "- Português brasileiro, tom profissional e acolhedor\n" +
    "- Nunca invente preços ou itens fora do cardápio\n" +
    "- Para reservas: https://widget.getinapp.com.br/d6NZKJ6V\n" +
    "- Programação musical: sempre direcione para @soulbotequim no Instagram\n" +
    "- Quando fechado, sempre convide para reservar pelo Getin";
}

// ── CHAMAR CLAUDE ────────────────────────────────────────────
async function chamarClaude(telefone, mensagemUsuario) {
  adicionarMensagem(telefone, "user", mensagemUsuario);
  const historico = getHistorico(telefone);
  const response = await axios.post(
    "https://api.anthropic.com/v1/messages",
    { model: "claude-sonnet-4-5", max_tokens: 1024, system: getSYSTEM_PROMPT(), messages: historico },
    { headers: { "x-api-key": CONFIG.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" }, timeout: 30000 }
  );
  const resposta = response.data.content[0].text;
  adicionarMensagem(telefone, "assistant", resposta);
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
    if (jaProcessou(msgId)) { console.log("[DUPLICADA] " + msgId); return res.status(200).json({ ok: true }); }

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
app.get("/", (req, res) => {
  res.json({ status: "Soul Botequim online!", conversas: Object.keys(memoriaGlobal).length, horario: getStatusHorario() });
});

app.listen(CONFIG.PORT, () => {
  console.log("\n🍺 Soul Botequim — Soul rodando na porta " + CONFIG.PORT);
  console.log("📡 Webhook: http://localhost:" + CONFIG.PORT + "/webhook\n");
});
