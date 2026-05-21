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
  Jerez Fino | Sanlúcar de Barrame
