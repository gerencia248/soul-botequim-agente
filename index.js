// ============================================================
//  Soul Botequim — Agente IA para WhatsApp via Z-API + Claude
//  Servidor Node.js (Express)
// ============================================================

const express = require("express");
const axios = require("axios");
const app = express();
app.use(express.json());

// ──────────────────────────────────────────────
//  CONFIGURAÇÕES — lidas das variáveis de ambiente (Railway)
// ──────────────────────────────────────────────
const CONFIG = {
  ZAPI_INSTANCE_ID: process.env.ZAPI_INSTANCE_ID,
  ZAPI_TOKEN: process.env.ZAPI_TOKEN,
  ZAPI_CLIENT_TOKEN: process.env.ZAPI_CLIENT_TOKEN,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  PORT: process.env.PORT || 3000,
};

// ──────────────────────────────────────────────
//  SYSTEM PROMPT DO AGENTE SOUL BOTEQUIM
// ──────────────────────────────────────────────
const SYSTEM_PROMPT = `Você é o atendente virtual do Soul Botequim, um botequim descolado e acolhedor no Brooklin, São Paulo. Seu nome é Soul. Você fala de forma descontraída, usa emojis com moderação, gírias leves e tem o jeito simpático de um garçom que conhece cada cliente pelo nome.

INFORMAÇÕES DO BAR:
- Nome: Soul Botequim
- Endereço: Avenida Padre Antônio José dos Santos, 812 — Brooklin, São Paulo
- WhatsApp/Tel: (11) 95498-7240
- Instagram: @soulbotequim
- Horários: Ter a Qui 16h–00h | Sex e Sáb 12h–00h | Dom 12h–21h
- Pet friendly, havaianas liberadas, calçada friendly

CARDÁPIO — DRINKS AUTORAIS:
Corsário (Rum, uvas, tomilho limão, suco de limão taiti e calda de agave) R$38
Negroni (Gin, Campari e vermute rosso) R$42
Dama da Noite (Rum, xarope de capim santo com mel e suco de limão siciliano) R$38
Carcarah (Cachaça, suco de limão siciliano e xarope de abacaxi) R$36
Amarelo Manga (Rum, licor de banana, suco de manga, suco de limão taiti e mel) R$42
Bitter Giuseppe (Cynas, vermute rosso, suco de limão siciliano e orange aromatic bitters) R$42
El Diablo (Tequila, licor de groselhas negras, suco de limão taiti e refrigerante de gengibre) R$38
Jacira (Tiquira, suco de melão cantaloupe, suco de limão siciliano e xarope de açúcar de coco) R$38
Caju Amigo (Cachaça, suco e compota de caju, suco de limão taiti e xarope simples) R$38
Mojito (Rum, hortelã, suco de limão taiti, xarope simples e água com gás) R$36
Caipirinha (Cachaça, limão taiti e açúcar) R$34 — com Vodka R$46
Fitzgerald (Gin, suco de limão siciliano, xarope simples e aromatic bitters) R$39
Macunaíma (Cachaça, suco de limão taiti, xarope simples e Fernet) R$35
Soul Punch (Rum, spiced rum, licor de laranja, suco de limão, xarope de abacaxi e refrigerante de gengibre) R$38
Hibiscus Margarita (Tequila, licor de laranja, suco de limão taiti e xarope de hibisco) R$39
Aperol Spritz (Aperol, espumante e água com gás) R$38

DRINKS NÃO ALCOÓLICOS:
Mate da Casa R$26 | Shirley Temple R$26 | Irarã R$26

BEBIDAS NÃO ALCOÓLICAS:
Água com/sem gás R$9 | Água tônica R$10 | Guaraná R$10 | Coca-Cola R$10 | Suco Villa Piva R$16

DOSES:
Cachaças: Salinéssima Prata R$24, Maria Izabel Prata R$40, Tié Prata R$28, Salineira Bálsamo R$52, Colombina Jatobá R$50, Soledade Pau-Brasil R$36, Porto Morretes R$36, Weber Haus Amburana R$28, Sebastiana Duas Barricas R$80, Gogó de Ema Alquimia R$52, Matriarca 4 Madeiras R$40
Rum: Havana 7 Años R$42, Havana 3 Años R$38
Tequila: Spólon R$42, Spólon Reposado R$44
Whisky: Ardbeg R$80, The Glenlivet Founder's R$50, Jameson R$38, Woodford Reserve R$46, Jack Daniel's R$38
Vodka: Absolut R$40

CARTA DE VINHOS:
Bolhas: Eu Borbulho Branco Brut (Chardonnay, Brasil) R$130
Jerez: Delgado Zuleta Jerez Fino (Espanha) R$160
Rosés: Falernia Rosé R$140, Le Loup Dans La Bergerie Rosé R$180
Laranja: Lazy Winemaker Sauvignon Blanc R$150
Brancos: Lupi Reali Trebbiano D'Abruzzo R$130, Lazy Winemaker Chardonnay R$140, Durbanville Hills Chenin Blanc R$180, Sin (Xarel-lo) R$190, The Stump Jump R$220, Pfaffmann Riesling Trocken 1L R$230, Je T'Aime Mais J'Ai Soif R$240, Les P'tits Gars Blanc R$260
Tintos: Scorpio Malbec R$130, Dominio Cassis Cab. Franc Reserva R$140, Aqui Estamos Todos Locos (Lambrusco) R$150, Regeneración Bonarda R$180, De Lucca Tannat Reserva R$190, Sin Negre R$190, Cabernet Sauvignon Funckenhausen 1L R$220, Un Air de La Réméjeanne R$230, Cousin Oscar R$240, Unlitro Costa Toscana IGT R$250, Hunter's Stoneburn Pinot Noir R$340

COMIDAS:
Caldinho de Feijão R$26 | Coxinha de Frango e Catupiry (4un) R$36 | Torresmo de Panceta R$68 | Vinagrete Polvo R$75 | Croquete de Carne R$40 | Bolinho Carne Seca R$43 | Frango Frito R$47 | Cogumelos R$48 | Batata Frita R$42 | Bolovo R$30 | Pastel Misto R$43 | Chips Batata Doce R$30 | Costelinha de Porco R$78 | Quiabo na Brasa com Coalhada Fresca R$46 | Tulipinha de Frango Picante R$67 | Milanesa Aperitivo com Creme de Parmesão R$67 | Palmito Pupunha na Brasa, Ervas e Amêndoas R$65 | Bolinho de Mandioquinha e Carne de Panela R$27 | Crudo de Atum e Cítricos R$78 | Steak Tartare R$76 | Rosbife Salada de Batata R$58 | Parmeggiana de Mignon R$68 | Oswaldo Aranha R$95 | Fraldinha R$140 | Ancho R$135 | Picanha R$165 | Linguiça Aperitivo R$92 | Legumes na Brasa R$70
LANCHES: Cheeseburger R$40 | Bauru a Moda R$47 | Choripan R$42 | Soul Crispy Chicken R$43 | Fritas Acompanhamento R$22
PARA AS CRIANÇAS: Steak de Filé Mignon, Arroz e Fritas R$65 | Espaguette com Molho Pomodoro R$48
SOBREMESA: Crepe de Doce de Leite Caramelizado R$32

COMO AGIR:
- Responda sempre em português brasileiro
- Seja descontraído, use emojis com moderação
- Para reservas, peça: nome, data, horário e número de pessoas
- Se não souber algo ou a pergunta fugir do escopo do bar, oriente o cliente a ligar ou visitar: (11) 95498-7240 ou Av. Padre Antônio José dos Santos, 812
- Mantenha respostas curtas e objetivas no estilo WhatsApp (máximo 3-4 parágrafos curtos)
- Nunca invente preços ou itens fora do cardápio acima
- Quando o cliente quiser fazer reserva, confirme: nome, data, horário e quantidade de pessoas`;

// ──────────────────────────────────────────────
//  MEMÓRIA DE CONVERSAS (em memória, por sessão)
// ──────────────────────────────────────────────
const conversas = new Map();

function getHistorico(telefone) {
  if (!conversas.has(telefone)) {
    conversas.set(telefone, []);
  }
  return conversas.get(telefone);
}

function adicionarMensagem(telefone, role, content) {
  const historico = getHistorico(telefone);
  historico.push({ role, content });
  if (historico.length > 20) {
    historico.splice(0, historico.length - 20);
  }
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
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
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
    {
      phone: telefone,
      message: texto,
    },
    {
      headers: {
        "Client-Token": CONFIG.ZAPI_CLIENT_TOKEN,
        "Content-Type": "application/json",
      },
    }
  );
}

// ──────────────────────────────────────────────
//  WEBHOOK — recebe mensagens da Z-API
// ──────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;

    // Ignorar mensagens enviadas pelo próprio bot
    if (body.fromMe) {
      return res.status(200).json({ ok: true });
    }

    // Ignorar grupos
    if (body.isGroup) {
      return res.status(200).json({ ok: true });
    }

    const telefone = body.phone;
    const mensagem = body.text?.message || body.text;

    if (!telefone || !mensagem) {
      return res.status(200).json({ ok: true });
    }

    console.log(`[${new Date().toLocaleTimeString("pt-BR")}] Mensagem de ${telefone}: ${mensagem}`);

    const resposta = await chamarClaude(telefone, mensagem);

    console.log(`[${new Date().toLocaleTimeString("pt-BR")}] Resposta para ${telefone}: ${resposta.substring(0, 80)}...`);

    await enviarMensagem(telefone, resposta);

    res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Erro no webhook:", error.response?.data || error.message);
    res.status(500).json({ erro: error.message });
  }
});

// ──────────────────────────────────────────────
//  ROTA DE HEALTH CHECK
// ──────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status: "Soul Botequim Agente IA — online!",
    conversasAtivas: conversas.size,
  });
});

// ──────────────────────────────────────────────
//  INICIAR SERVIDOR
// ──────────────────────────────────────────────
app.listen(CONFIG.PORT, () => {
  console.log(`\n🍺 Soul Botequim Agente IA rodando na porta ${CONFIG.PORT}`);
  console.log(`📡 Webhook esperando em: http://localhost:${CONFIG.PORT}/webhook\n`);
});
