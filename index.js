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
  NUMERO_DOURADO: "5511954657178", // WhatsApp do gerente Dourado
};

// ──────────────────────────────────────────────
//  MEMÓRIA PERSISTENTE (arquivo JSON local)
// ──────────────────────────────────────────────
const ARQUIVO_MEMORIA = path.join("/tmp", "soul_memoria.json");

function carregarMemoria() {
  try {
    if (fs.existsSync(ARQUIVO_MEMORIA)) {
      const dados = fs.readFileSync(ARQUIVO_MEMORIA, "utf8");
      return JSON.parse(dados);
    }
  } catch (e) {
    console.error("Erro ao carregar memória:", e.message);
  }
  return {};
}

function salvarMemoria(memoria) {
  try {
    fs.writeFileSync(ARQUIVO_MEMORIA, JSON.stringify(memoria), "utf8");
  } catch (e) {
    console.error("Erro ao salvar memória:", e.message);
  }
}

const memoriaGlobal = carregarMemoria();

function getHistorico(telefone) {
  if (!memoriaGlobal[telefone]) {
    memoriaGlobal[telefone] = [];
  }
  return memoriaGlobal[telefone];
}

function adicionarMensagem(telefone, role, content) {
  const historico = getHistorico(telefone);
  historico.push({ role, content });
  if (historico.length > 20) {
    historico.splice(0, historico.length - 20);
  }
  salvarMemoria(memoriaGlobal);
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
//  FILTRO DE PALAVRÕES E CONTEÚDO OFENSIVO
// ──────────────────────────────────────────────
const palavroesOfensivos = [
  "puta", "merda", "caralho", "porra", "viado", "idiota", "imbecil",
  "cretino", "otario", "otário", "fdp", "vai se foder", "seu lixo",
  "desgraça", "arrombado", "babaca"
];

function contemPalavroes(texto) {
  const textoLower = texto.toLowerCase();
  return palavroesOfensivos.some(p => textoLower.includes(p));
}

// ──────────────────────────────────────────────
//  VERIFICAR SE QUER FALAR COM HUMANO
// ──────────────────────────────────────────────
function querFalarComHumano(texto) {
  const textoLower = texto.toLowerCase();
  const gatilhos = [
    "falar com atendente", "falar com humano", "falar com pessoa",
    "atendente humano", "fala com alguém", "quero um humano",
    "não quero robô", "nao quero robo", "me passa pro dourado",
    "falar com dourado", "fala com o dourado", "gerente"
  ];
  return gatilhos.some(g => textoLower.includes(g));
}

// ──────────────────────────────────────────────
//  HORÁRIO INTELIGENTE
// ──────────────────────────────────────────────
function getStatusHorario() {
  const agora = new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" });
  const data = new Date(agora);
  const diaSemana = data.getDay();
  const hora = data.getHours();
  const minutos = data.getMinutes();
  const horaDecimal = hora + minutos / 60;

  if (diaSemana === 1) {
    return { aberto: false, proximaAbertura: "terça-feira às 16h" };
  }
  if (diaSemana >= 2 && diaSemana <= 4) {
    if (horaDecimal >= 16 && horaDecimal < 24) return { aberto: true };
    return { aberto: false, proximaAbertura: "hoje às 16h" };
  }
  if (diaSemana === 5 || diaSemana === 6) {
    if (horaDecimal >= 12 && horaDecimal < 24) return { aberto: true };
    return { aberto: false, proximaAbertura: "hoje às 12h" };
  }
  if (diaSemana === 0) {
    if (horaDecimal >= 12 && horaDecimal < 21) return { aberto: true };
    return { aberto: false, proximaAbertura: "segunda está fechado, mas abrimos terça às 16h" };
  }
  return { aberto: false, proximaAbertura: "em breve" };
}

// ──────────────────────────────────────────────
//  DELAY HUMANIZADO
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
    ? "O bar está ABERTO agora. Seja acolhedor e convide o cliente a vir!"
    : `O bar está FECHADO agora. Informe gentilmente o horário e convide para fazer reserva pelo link https://widget.getinapp.com.br/d6NZKJ6V. Próxima abertura: ${status.proximaAbertura}.`;

  return `Você é Soul, o atendente do Soul Botequim — um botequim descolado no coração do Brooklin, São Paulo. Fale de forma descontraída, com gírias leves e jeito de garçom que conhece cada cliente pelo nome.

IDENTIDADE:
- Seu nome é Soul
- Você é um atendente humano do Soul Botequim
- NUNCA diga que é robô, IA, assistente virtual ou chatbot
- Se perguntarem se é humano ou robô, diga naturalmente que é o atendente Soul
- Mantenha sempre o personagem de garçom humano

HORÁRIO ATUAL:
${horarioInfo}

HORÁRIOS DE FUNCIONAMENTO:
- Ter a Qui: 16h–00h | Sex e Sáb: 12h–00h | Dom: 12h–21h | Segunda: fechado

INFORMAÇÕES DO BAR:
- Endereço: Av. Padre Antônio José dos Santos, 812 — Brooklin, SP
- Tel: (11) 95498-7240 | Instagram: @soulbotequim
- Gerente: Dourado
- Pet friendly | Havaianas liberadas | Calçada friendly
- Área externa na calçada | Acesso para cadeirantes | Wi-Fi disponível
- Sem couvert artístico | Taxa de rolha: R$70
- Sem happy hour | Cardápio único (almoço = jantar)
- Grupos grandes com espaço reservado | Comanda individual
- Música: Jazz, Blues e Brasilidades — DJ e música ao vivo (programação no Instagram)
- Drink mais famoso: Fitzgerald 🍋
- Reservas: https://widget.getinapp.com.br/d6NZKJ6V
- Sem valet — mas tem estacionamentos no entorno
- Aniversariantes: 1 drink ou 1 chopp de cortesia | Pode trazer somente bolo
- Cervejas: somente chopp artesanal, latas e garrafas artesanais
- Sem voucher ou vale-alimentação
- Pagamento: crédito (sem parcelamento), débito, Pix, dinheiro, Amex

CARDÁPIO — DRINKS AUTORAIS:
Corsário R$38 | Negroni R$42 | Dama da Noite R$38 | Carcarah R$36 | Amarelo Manga R$42 | Bitter Giuseppe R$42 | El Diablo R$38 | Jacira R$38 | Caju Amigo R$38 | Mojito R$36 | Caipirinha R$34 (Vodka R$46) | Fitzgerald R$39 ⭐ mais pedido! | Macunaíma R$35 | Soul Punch R$38 | Hibiscus Margarita R$39 | Aperol Spritz R$38

NÃO ALCOÓLICOS: Mate da Casa R$26 | Shirley Temple R$26 | Irarã R$26
BEBIDAS: Água R$9 | Tônica R$10 | Guaraná R$10 | Coca R$10 | Suco Villa Piva R$16

DOSES — Cachaças: Salinéssima Prata R$24, Maria Izabel R$40, Tié Prata R$28, Salineira Bálsamo R$52, Colombina Jatobá R$50, Soledade Pau-Brasil R$36, Porto Morretes R$36, Weber Haus Amburana R$28, Sebastiana Duas Barricas R$80, Gogó de Ema R$52, Matriarca 4 Madeiras R$40 | Rum: Havana 7 R$42, Havana 3 R$38 | Tequila: Spólon R$42, Reposado R$44 | Whisky: Ardbeg R$80, Glenlivet R$50, Jameson R$38, Woodford R$46, Jack R$38 | Vodka: Absolut R$40

VINHOS — Bolhas: Eu Borbulho R$130 | Jerez: Delgado Zuleta R$160 | Rosés: Falernia R$140, Le Loup R$180 | Laranja: Lazy Winemaker SB R$150 | Brancos: Lupi Reali R$130, Lazy Chardonnay R$140, Durbanville R$180, Sin R$190, Stump Jump R$220, Pfaffmann R$230, Je T'Aime R$240, Les P'tits Gars R$260 | Tintos: Scorpio Malbec R$130, Dominio Cassis R$140, Lambrusco R$150, Bonarda R$180, De Lucca Tannat R$190, Sin Negre R$190, Funckenhausen R$220, Réméjeanne R$230, Cousin Oscar R$240, Unlitro R$250, Pinot Noir R$340

COMIDAS: Caldinho Feijão R$26 | Coxinha (4un) R$36 | Torresmo R$68 | Vinagrete Polvo R$75 | Croquete R$40 | Bolinho Carne Seca R$43 | Frango Frito R$47 | Cogumelos R$48 | Batata Frita R$42 | Bolovo R$30 | Pastel Misto R$43 | Chips Batata Doce R$30 | Costelinha R$78 | Quiabo Brasa R$46 | Tulipinha Picante R$67 | Milanesa Aperitivo R$67 | Palmito Pupunha R$65 | Bolinho Mandioquinha R$27 | Crudo Atum R$78 | Steak Tartare R$76 | Rosbife R$58 | Parmeggiana R$68 | Oswaldo Aranha R$95 | Fraldinha R$140 | Ancho R$135 | Picanha R$165 | Linguiça R$92 | Legumes Brasa R$70
LANCHES: Cheeseburger R$40 | Bauru R$47 | Choripan R$42 | Soul Crispy Chicken R$43 | Fritas R$22
KIDS: Filé Mignon R$65 | Espaguette R$48 | SOBREMESA: Crepe Doce de Leite R$32

COMO AGIR:
- Português brasileiro, descontraído, emojis com moderação
- Respostas curtas estilo WhatsApp (máximo 3-4 parágrafos)
- Nunca invente preços ou itens fora do cardápio
- Para reservas: https://widget.getinapp.com.br/d6NZKJ6V
- Programação musical: Instagram @soulbotequim`;
}

// ──────────────────────────────────────────────
//  FUNÇÃO: Chamar a API do Claude
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
    }
  );

  const resposta = response.data.content[0].text;
  adicionarMensagem(telefone, "assistant", resposta);
  return resposta;
}

// ──────────────────────────────────────────────
//  FUNÇÃO: Enviar mensagem via Z-API
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
//  FUNÇÃO: Simular digitação
// ──────────────────────────────────────────────
async function simularDigitando(telefone) {
  try {
    const url = `https://api.z-api.io/instances/${CONFIG.ZAPI_INSTANCE_ID}/token/${CONFIG.ZAPI_TOKEN}/send-text`;
    // Aguarda entre 2 e 4 segundos simulando digitação humana
    const tempoDelay = Math.floor(Math.random() * 2000) + 2000;
    await delay(tempoDelay);
  } catch (e) {
    // Ignora erro no delay
  }
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

    // Filtro de palavrões
    if (contemPalavroes(mensagem)) {
      await simularDigitando(telefone);
      await enviarMensagem(telefone, "Ei, vamos manter o papo na boa! 😊 Posso te ajudar com cardápio, reservas ou qualquer dúvida sobre o Soul Botequim.");
      return res.status(200).json({ ok: true });
    }

    // Encaminhar para humano
    if (querFalarComHumano(mensagem)) {
      await simularDigitando(telefone);
      await enviarMensagem(telefone, "Claro! Vou chamar o Dourado pra te atender pessoalmente. Um segundo! 🙌");
      await enviarMensagem(
        CONFIG.NUMERO_DOURADO,
        `🔔 *Soul Bot — Atendimento Humano*\n\nO cliente *${telefone}* quer falar com um atendente.\n\nÚltima mensagem: "${mensagem}"`
      );
      return res.status(200).json({ ok: true });
    }

    // Simular digitação antes de responder
    await simularDigitando(telefone);

    // Gerar resposta com Claude
    const resposta = await chamarClaude(telefone, mensagem);
    console.log(`[${new Date().toLocaleTimeString("pt-BR")}] Resposta: ${resposta.substring(0, 80)}...`);

    await enviarMensagem(telefone, resposta);
    res.status(200).json({ ok: true });

  } catch (error) {
    console.error("Erro no webhook:", error.response?.data || error.message);
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
    horario: getStatusHorario(),
  });
});

app.listen(CONFIG.PORT, () => {
  console.log(`\n🍺 Soul Botequim — Soul rodando na porta ${CONFIG.PORT}`);
  console.log(`📡 Webhook: http://localhost:${CONFIG.PORT}/webhook\n`);
});
