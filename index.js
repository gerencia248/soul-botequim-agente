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

// ──────────────────────────────────────────────
//  CONFIGURAÇÕES
// ──────────────────────────────────────────────
const CONFIG = {
  ZAPI_INSTANCE_ID: process.env.ZAPI_INSTANCE_ID,
  ZAPI_TOKEN: process.env.ZAPI_TOKEN,
  ZAPI_CLIENT_TOKEN: process.env.ZAPI_CLIENT_TOKEN,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  PORT: process.env.PORT || 3000,
  NUMERO_DOURADO: "5511954657178",
};

// ──────────────────────────────────────────────
//  MEMÓRIA PERSISTENTE
// ──────────────────────────────────────────────
const ARQUIVO_MEMORIA = path.join("/tmp", "soul_memoria.json");
const ARQUIVO_EVENTOS = path.join("/tmp", "soul_eventos.json");

function carregarArquivo(arquivo) {
  try {
    if (fs.existsSync(arquivo)) {
      return JSON.parse(fs.readFileSync(arquivo, "utf8"));
    }
  } catch (e) {
    console.error("Erro ao carregar arquivo:", e.message);
  }
  return {};
}

function salvarArquivo(arquivo, dados) {
  try {
    fs.writeFileSync(arquivo, JSON.stringify(dados, null, 2), "utf8");
  } catch (e) {
    console.error("Erro ao salvar arquivo:", e.message);
  }
}

const memoriaGlobal = carregarArquivo(ARQUIVO_MEMORIA);
const eventosCapturados = carregarArquivo(ARQUIVO_EVENTOS);

// ──────────────────────────────────────────────
//  CONTROLE DE FLUXO DE EVENTOS CORPORATIVOS
//  Guarda em qual etapa da coleta cada cliente está
// ──────────────────────────────────────────────
const fluxoEventos = {};

const ETAPAS_EVENTO = [
  { campo: "nome", pergunta: "Qual é o seu nome? 😊" },
  { campo: "empresa", pergunta: "Qual é o nome da sua empresa ou organização?" },
  { campo: "data", pergunta: "Qual data você tem em mente para o evento? 📅" },
  { campo: "pessoas", pergunta: "Quantas pessoas participarão? 👥" },
  { campo: "tipo", pergunta: "Que tipo de evento é? (confraternização, reunião, aniversário, happy hour corporativo, outro)" },
  { campo: "orcamento", pergunta: "Qual é o orçamento aproximado por pessoa ou total? 💰" },
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

  // Salva a resposta da etapa atual
  fluxo.dados[etapaAtual.campo] = mensagem;
  fluxo.etapa++;

  // Se ainda tem etapas, faz a próxima pergunta
  if (fluxo.etapa < ETAPAS_EVENTO.length) {
    const proximaEtapa = ETAPAS_EVENTO[fluxo.etapa];
    await enviarMensagem(telefone, proximaEtapa.pergunta);
    return;
  }

  // Fluxo completo — salva e notifica o Dourado
  const dadosEvento = fluxo.dados;
  const id = `evento_${Date.now()}`;
  eventosCapturados[id] = { telefone, ...dadosEvento, criadoEm: new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) };
  salvarArquivo(ARQUIVO_EVENTOS, eventosCapturados);
  delete fluxoEventos[telefone];

  // Mensagem de confirmação para o cliente
  await enviarMensagem(telefone,
    `Perfeito! Recebi todas as informações do seu evento! 🎉\n\nNosso gerente Dourado vai entrar em contato em breve para montar o pacote ideal pra vocês.\n\nQualquer dúvida é só chamar aqui! 🍺`
  );

  // Notificação para o Dourado
  const resumo = `🎉 *NOVO LEAD — Evento Corporativo*\n\n` +
    `📱 Contato: ${telefone}\n` +
    `👤 Nome: ${dadosEvento.nome}\n` +
    `🏢 Empresa: ${dadosEvento.empresa}\n` +
    `📅 Data: ${dadosEvento.data}\n` +
    `👥 Pessoas: ${dadosEvento.pessoas}\n` +
    `🎊 Tipo: ${dadosEvento.tipo}\n` +
    `💰 Orçamento: ${dadosEvento.orcamento}`;

  await enviarMensagem(CONFIG.NUMERO_DOURADO, resumo);
}

// ──────────────────────────────────────────────
//  MEMÓRIA DE CONVERSAS
// ──────────────────────────────────────────────
function getHistorico(telefone) {
  if (!memoriaGlobal[telefone]) memoriaGlobal[telefone] = [];
  return memoriaGlobal[telefone];
}

function adicionarMensagem(telefone, role, content) {
  const historico = getHistorico(telefone);
  historico.push({ role, content });
  if (historico.length > 20) historico.splice(0, historico.length - 20);
  salvarArquivo(ARQUIVO_MEMORIA, memoriaGlobal);
}

// ──────────────────────────────────────────────
//  CONTROLE DE MENSAGENS DUPLICADAS
// ──────────────────────────────────────────────
const mensagensProcessadas = new Set();

function jaProcessou(msgId) {
  if (!msgId) return false;
  if (mensagensProcessadas.has(msgId)) return true;
  mensagensProcessadas.add(msgId);
  if (mensagensProcessadas.size > 1000) {
    const primeiro = mensagensProcessadas.values().next().value;
    mensagensProcessadas.delete(primeiro);
  }
  return false;
}

// ──────────────────────────────────────────────
//  FILTRO DE PALAVRÕES
// ──────────────────────────────────────────────
const palavroesOfensivos = [
  "puta", "merda", "caralho", "porra", "viado", "idiota", "imbecil",
  "cretino", "otario", "otário", "fdp", "vai se foder", "seu lixo",
  "desgraça", "arrombado", "babaca"
];

function contemPalavroes(texto) {
  const t = texto.toLowerCase();
  return palavroesOfensivos.some(p => t.includes(p));
}

// ──────────────────────────────────────────────
//  DETECTAR INTENÇÕES ESPECIAIS
// ──────────────────────────────────────────────
function querFalarComHumano(texto) {
  const t = texto.toLowerCase();
  return ["falar com atendente", "falar com humano", "falar com pessoa",
    "atendente humano", "quero um humano", "não quero robô", "nao quero robo",
    "me passa pro dourado", "falar com dourado", "fala com o dourado", "gerente"
  ].some(g => t.includes(g));
}

function querEventoCorporativo(texto) {
  const t = texto.toLowerCase();
  return ["evento corporativo", "confraternização", "confraternizacao", "evento empresa",
    "evento corporativo", "festa empresa", "reunião empresa", "happy hour empresa",
    "pacote evento", "evento para empresa", "aniversario empresa", "comemoração empresa",
    "evento para grupo", "reserva para empresa"
  ].some(g => t.includes(g));
}

function querRecomendacaoDrink(texto) {
  const t = texto.toLowerCase();
  return ["me indica", "me recomenda", "qual drink", "o que você sugere",
    "o que me recomenda", "não sei o que pedir", "nao sei o que pedir",
    "me sugere um drink", "qual é o melhor", "qual devo pedir",
    "algo refrescante", "algo forte", "drink leve", "drink especial"
  ].some(g => t.includes(g));
}

// ──────────────────────────────────────────────
//  HORÁRIO INTELIGENTE
// ──────────────────────────────────────────────
function getStatusHorario() {
  const agora = new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" });
  const data = new Date(agora);
  const dia = data.getDay();
  const h = data.getHours() + data.getMinutes() / 60;

  if (dia === 1) return { aberto: false, proximaAbertura: "terça-feira às 16h" };
  if (dia >= 2 && dia <= 4) {
    return h >= 16 && h < 24 ? { aberto: true } : { aberto: false, proximaAbertura: "hoje às 16h" };
  }
  if (dia === 5 || dia === 6) {
    return h >= 12 && h < 24 ? { aberto: true } : { aberto: false, proximaAbertura: "hoje às 12h" };
  }
  if (dia === 0) {
    return h >= 12 && h < 21 ? { aberto: true } : { aberto: false, proximaAbertura: "segunda fechamos, mas abrimos terça às 16h" };
  }
  return { aberto: false, proximaAbertura: "em breve" };
}

// ──────────────────────────────────────────────
//  DELAY
// ──────────────────────────────────────────────
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ──────────────────────────────────────────────
//  SYSTEM PROMPT
// ──────────────────────────────────────────────
function getSYSTEM_PROMPT() {
  const status = getStatusHorario();
  const horarioInfo = status.aberto
    ? "O bar está ABERTO agora. Seja acolhedor e convide o cliente a vir! NUNCA afirme que tem música ao vivo acontecendo agora — a programação muda toda semana, sempre direcione para o Instagram @soulbotequim para confirmar."
    : `O bar está FECHADO. Informe gentilmente e convide para fazer reserva: https://widget.getinapp.com.br/d6NZKJ6V. Próxima abertura: ${status.proximaAbertura}.`;

  return `Você é Soul, o atendente do Soul Botequim — botequim descolado no coração do Brooklin, SP. Fale de forma simpática, acolhedora e profissional, sem exagerar em gírias ou expressões muito informais.

IDENTIDADE:
- Seu nome é Soul, atendente humano do Soul Botequim
- NUNCA diga que é robô, IA ou chatbot
- Se perguntarem, diga que é o atendente Soul

VOCABULÁRIO E TOM:
- Use linguagem simpática e acolhedora, mas profissional
- Evite exagerar em gírias como "mano", "brother", "saca?", "tamo junto", "bora" — use com muita moderação
- Prefira: "Olá!", "Claro!", "Com prazer!", "Pode contar comigo!", "Fico feliz em ajudar!"
- Máximo 1 emoji por mensagem
- Respostas curtas e objetivas — máximo 3 parágrafos

ESCOPO — MUITO IMPORTANTE:
- Você é atendente de bar, NÃO terapeuta ou conselheiro emocional
- Se o cliente falar de tristeza, problemas pessoais ou assuntos fora do bar, responda com empatia BREVEMENTE e redirecione para o bar
- Exemplo: "Espero que fique melhor! Se quiser dar uma pausa e relaxar, o Soul Botequim está de portas abertas. 🍺"
- NUNCA entre em conversa emocional prolongada — mantenha o foco no atendimento do bar

HORÁRIO ATUAL: ${horarioInfo}

HORÁRIOS DE FUNCIONAMENTO (NUNCA invente horários diferentes destes!):
- Terça, Quarta, Quinta: abre às 16h e fecha à meia-noite (00h)
- Sexta e Sábado: abre às 12h e fecha à meia-noite (00h)
- DOMINGO: abre às 12h e fecha às 21h — NÃO vai até meia-noite, fecha às 21h!
- Segunda-feira: FECHADO o dia todo

INFORMAÇÕES:
- Endereço: Av. Padre Antônio José dos Santos, 812 — Brooklin, SP
- Tel: (11) 95498-7240 | Instagram: @soulbotequim | Gerente: Dourado
- Pet friendly | Calçada friendly | Área externa | Acesso cadeirantes | Wi-Fi
- Sem couvert | Taxa de rolha R$70 | Sem happy hour | Comanda individual
- Grupos grandes com espaço reservado
- Música: Jazz, Blues e Brasilidades — programação semanal no Instagram @soulbotequim
- Drink mais famoso: Fitzgerald 🍋
- Reservas: https://widget.getinapp.com.br/d6NZKJ6V
- Sem valet — estacionamentos no entorno
- Aniversariantes: 1 drink ou chopp de cortesia | Pode trazer somente bolo
- Cervejas: somente chopp artesanal, latas e garrafas artesanais
- Sem voucher/vale-alimentação
- Pagamento: crédito (sem parcelamento), débito, Pix, dinheiro, Amex
- Eventos corporativos: temos pacotes especiais — o cliente deve solicitar para iniciar o processo

RECOMENDAÇÃO DE DRINKS POR HUMOR:
- Cliente quer algo REFRESCANTE: sugira Corsário, Mojito, Hibiscus Margarita ou Aperol Spritz
- Cliente quer algo FORTE: sugira Negroni, Macunaíma ou Bitter Giuseppe
- Cliente quer algo CLÁSSICO: sugira Fitzgerald (o queridinho da casa!), Caipirinha ou Negroni
- Cliente quer algo TROPICAL/BRASILEIRO: sugira Caju Amigo, Carcarah ou Amarelo Manga
- Cliente quer algo DIFERENTE/AUTORAL: sugira Jacira, Dama da Noite ou El Diablo
- Sempre descreva brevemente os ingredientes e o sabor ao recomendar

CARDÁPIO — DRINKS AUTORAIS:
Corsário (Rum, uvas, tomilho limão, limão taiti, agave) R$38
Negroni (Gin, Campari, vermute rosso) R$42
Dama da Noite (Rum, capim santo, mel, limão siciliano) R$38
Carcarah (Cachaça, limão siciliano, abacaxi) R$36
Amarelo Manga (Rum, banana, manga, limão taiti, mel) R$42
Bitter Giuseppe (Cynas, vermute rosso, limão siciliano, bitters) R$42
El Diablo (Tequila, groselha negra, limão taiti, gengibre) R$38
Jacira (Tiquira, melão, limão siciliano, açúcar de coco) R$38
Caju Amigo (Cachaça, caju, limão taiti) R$38
Mojito (Rum, hortelã, limão taiti, água com gás) R$36
Caipirinha R$34 | com Vodka R$46
Fitzgerald (Gin, limão siciliano, xarope, bitters) R$39 ⭐ O mais pedido!
Macunaíma (Cachaça, limão taiti, Fernet) R$35
Soul Punch (Rum, spiced rum, laranja, abacaxi, gengibre) R$38
Hibiscus Margarita (Tequila, laranja, limão taiti, hibisco) R$39
Aperol Spritz (Aperol, espumante, água com gás) R$38
NÃO ALCOÓLICOS: Mate R$26 | Shirley Temple R$26 | Irarã R$26
BEBIDAS: Água R$9 | Tônica R$10 | Guaraná R$10 | Coca R$10 | Suco R$16

DOSES — Cachaças: Salinéssima Prata R$24, Maria Izabel R$40, Tié Prata R$28, Salineira Bálsamo R$52, Colombina Jatobá R$50, Soledade R$36, Porto Morretes R$36, Weber Haus R$28, Sebastiana R$80, Gogó de Ema R$52, Matriarca R$40
Rum: Havana 7 R$42, Havana 3 R$38 | Tequila: Spólon R$42, Reposado R$44
Whisky: Ardbeg R$80, Glenlivet R$50, Jameson R$38, Woodford R$46, Jack R$38 | Vodka: Absolut R$40

VINHOS: Bolhas R$130 | Jerez R$160 | Rosés R$140–180 | Laranja R$150 | Brancos R$130–260 | Tintos R$130–340

COMIDAS: Caldinho R$26 | Coxinha R$36 | Torresmo R$68 | Polvo R$75 | Croquete R$40 | Bolinho Carne Seca R$43 | Frango Frito R$47 | Cogumelos R$48 | Batata Frita R$42 | Bolovo R$30 | Pastel R$43 | Chips R$30 | Costelinha R$78 | Quiabo R$46 | Tulipinha R$67 | Milanesa R$67 | Palmito R$65 | Bolinho Mandioquinha R$27 | Crudo Atum R$78 | Tartare R$76 | Rosbife R$58 | Parmeggiana R$68 | Oswaldo Aranha R$95 | Fraldinha R$140 | Ancho R$135 | Picanha R$165 | Linguiça R$92 | Legumes R$70
LANCHES: Cheeseburger R$40 | Bauru R$47 | Choripan R$42 | Soul Crispy Chicken R$43 | Fritas R$22
KIDS: Filé R$65 | Espaguette R$48 | SOBREMESA: Crepe Doce de Leite R$32

COMO AGIR:
- Português brasileiro, descontraído, emojis com moderação
- Respostas curtas estilo WhatsApp (máximo 3-4 parágrafos)
- Nunca invente preços ou itens fora do cardápio
- Para reservas: https://widget.getinapp.com.br/d6NZKJ6V
- Programação musical: sempre direcione para @soulbotequim no Instagram
- Quando o bar estiver fechado, além do horário sempre convide para reservar pelo Getin`;
}

// ──────────────────────────────────────────────
//  FUNÇÃO: Chamar Claude
// ──────────────────────────────────────────────
async function chamarClaude(telefone, mensagemUsuario) {
  adicionarMensagem(telefone, "user", mensagemUsuario);
  const historico = getHistorico(telefone);

  const response = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      system: getSYSTEM_PROMPT(),
      messages: historico,
    },
    {
      headers: {
        "x-api-key": CONFIG.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      timeout: 30000, // 30 segundos de timeout
    }
  );

  const resposta = response.data.content[0].text;
  adicionarMensagem(telefone, "assistant", resposta);
  return resposta;
}

// ──────────────────────────────────────────────
//  FUNÇÃO: Enviar mensagem
// ──────────────────────────────────────────────
async function enviarMensagem(telefone, texto) {
  const url = `https://api.z-api.io/instances/${CONFIG.ZAPI_INSTANCE_ID}/token/${CONFIG.ZAPI_TOKEN}/send-text`;
  await axios.post(
    url,
    { phone: telefone, message: texto },
    { headers: { "Client-Token": CONFIG.ZAPI_CLIENT_TOKEN, "Content-Type": "application/json" } }
  );
}

// ──────────────────────────────────────────────
//  WEBHOOK
// ──────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;

    if (body.fromMe) return res.status(200).json({ ok: true });
    if (body.isGroup) return res.status(200).json({ ok: true });
    if (body.type && body.type !== "ReceivedCallback") return res.status(200).json({ ok: true });

    const msgId = body.messageId || body.id;
    if (jaProcessou(msgId)) {
      console.log(`[DUPLICADA] ${msgId} ignorada.`);
      return res.status(200).json({ ok: true });
    }

    const telefone = body.phone;
    const mensagem = body.text?.message || body.text;

    if (!telefone || !mensagem || typeof mensagem !== "string" || mensagem.trim() === "") {
      return res.status(200).json({ ok: true });
    }

    console.log(`[${new Date().toLocaleTimeString("pt-BR")}] De ${telefone}: ${mensagem}`);

    // 1. Cliente está no fluxo de evento corporativo?
    if (estaNoFluxoEvento(telefone)) {
      await processarFluxoEvento(telefone, mensagem);
      return res.status(200).json({ ok: true });
    }

    // 2. Filtro de palavrões
    if (contemPalavroes(mensagem)) {
      await enviarMensagem(telefone, "Por favor, vamos manter a conversa respeitosa. 😊 Estou aqui para ajudar com cardápio, reservas ou qualquer dúvida sobre o Soul Botequim.");
      return res.status(200).json({ ok: true });
    }

    // 3. Quer falar com humano?
    if (querFalarComHumano(mensagem)) {
      await enviarMensagem(telefone, "Claro! Vou acionar o Dourado para te atender pessoalmente. Um momento! 🙌");
      await enviarMensagem(CONFIG.NUMERO_DOURADO,
        `🔔 *Soul Bot — Atendimento Humano*\n\nCliente *${telefone}* quer falar com atendente.\n\nÚltima mensagem: "${mensagem}"`
      );
      return res.status(200).json({ ok: true });
    }

    // 4. Quer evento corporativo?
    if (querEventoCorporativo(mensagem)) {
      iniciarFluxoEvento(telefone);
      await enviarMensagem(telefone,
        `Ótimo! Ficamos felizes em receber sua empresa no Soul Botequim! 🎉\n\nVou precisar de algumas informações para montar o melhor pacote para vocês.\n\n${ETAPAS_EVENTO[0].pergunta}`
      );
      return res.status(200).json({ ok: true });
    }

    // 5. Quer recomendação de drink?
    if (querRecomendacaoDrink(mensagem)) {
      await enviarMensagem(telefone, "Com prazer! Vou te ajudar a escolher o drink ideal. 🍹\n\nMe conta: você prefere algo *refrescante*, *forte*, *clássico*, *tropical/brasileiro* ou algo *diferente e autoral*?");
      return res.status(200).json({ ok: true });
    }

    // 6. Resposta padrão com Claude
    const resposta = await chamarClaude(telefone, mensagem);
    console.log(`[${new Date().toLocaleTimeString("pt-BR")}] Resposta: ${resposta.substring(0, 80)}...`);
    await enviarMensagem(telefone, resposta);

    res.status(200).json({ ok: true });

  } catch (error) {
    console.error("Erro no webhook:", error.response?.data || error.message);
    // Tenta avisar o cliente que houve um problema
    try {
      const tel = req.body?.phone;
      if (tel) await enviarMensagem(tel, "Desculpe, tive um problema técnico. Por favor, tente novamente em instantes ou ligue: (11) 95498-7240.");
    } catch (e) { /* ignora */ }
    res.status(500).json({ erro: error.message });
  }
});

// ──────────────────────────────────────────────
//  HEALTH CHECK
// ──────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status: "🍺 Soul Botequim — Soul online!",
    conversasAtivas: Object.keys(memoriaGlobal).length,
    eventosCapturados: Object.keys(eventosCapturados).length,
    horario: getStatusHorario(),
  });
});

app.listen(CONFIG.PORT, () => {
  console.log(`\n🍺 Soul Botequim — Soul rodando na porta ${CONFIG.PORT}`);
  console.log(`📡 Webhook: http://localhost:${CONFIG.PORT}/webhook\n`);
});
