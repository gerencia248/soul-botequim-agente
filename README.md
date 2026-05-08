# 🍺 Soul Botequim — Agente IA para WhatsApp

Agente de atendimento automático via WhatsApp usando Z-API + Claude (Anthropic).

---

## Pré-requisitos

- Node.js 18+ instalado
- Conta na [Z-API](https://www.z-api.io) (plano pago)
- Chave de API da [Anthropic](https://console.anthropic.com)
- Um servidor com IP público (VPS, Railway, Render, etc.)

---

## Passo a passo

### 1. Instalar dependências

```bash
npm install
```

### 2. Configurar as variáveis no `index.js`

Abra o arquivo `index.js` e preencha o objeto `CONFIG`:

```js
const CONFIG = {
  ZAPI_INSTANCE_ID: "SEU_INSTANCE_ID",       // Painel Z-API > Instâncias
  ZAPI_TOKEN: "SEU_TOKEN_ZAPI",              // Painel Z-API > Instâncias > Token
  ZAPI_CLIENT_TOKEN: "SEU_CLIENT_TOKEN",     // Painel Z-API > Conta > Security
  ANTHROPIC_API_KEY: "SUA_CHAVE_ANTHROPIC",  // console.anthropic.com > API Keys
  PORT: 3000,
};
```

### 3. Iniciar o servidor

```bash
npm start
```

Para desenvolvimento com reinício automático:
```bash
npm run dev
```

### 4. Configurar o Webhook na Z-API

1. Acesse o painel da Z-API
2. Vá em **Instâncias > sua instância > Webhooks**
3. Configure o **Webhook de Mensagens Recebidas** com a URL:
   ```
   https://SEU_DOMINIO.com/webhook
   ```
4. Salve e ative

### 5. Conectar o WhatsApp

1. No painel da Z-API, vá em **Instâncias > sua instância**
2. Clique em **Conectar** e escaneie o QR Code com o celular do bar
3. Pronto! O agente já começa a responder automaticamente

---

## Hospedagem recomendada (gratuita/barata)

| Serviço | Custo | Link |
|---------|-------|------|
| Railway | ~R$15/mês | railway.app |
| Render | Gratuito (com limitações) | render.com |
| VPS DigitalOcean | ~R$30/mês | digitalocean.com |

### Deploy no Railway (mais fácil)

```bash
# 1. Instalar CLI do Railway
npm install -g @railway/cli

# 2. Login
railway login

# 3. Criar projeto e fazer deploy
railway init
railway up
```

Após o deploy, copie a URL gerada e cole no webhook da Z-API.

---

## Estrutura do projeto

```
soul-botequim-agente/
├── index.js       # Servidor principal
├── package.json   # Dependências
└── README.md      # Este arquivo
```

---

## Como funciona

1. Cliente manda mensagem no WhatsApp do bar
2. Z-API recebe e dispara um webhook para o seu servidor
3. O servidor chama a API do Claude com o histórico da conversa
4. Claude responde como o agente Soul Botequim
5. O servidor envia a resposta de volta via Z-API
6. Cliente recebe a resposta no WhatsApp

---

## Dúvidas?

Qualquer problema técnico, fale com quem configurou o sistema. 🍺
