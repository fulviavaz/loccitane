# LP Revenda L'Occitane au Brésil

Landing page de cadastro de revendedora + proxy Node que fala com a API Gera Omni e com o OTP da Indico.

## Importante para quem for publicar

**Não publique só o `index.html`.**

O formulário chama rotas no mesmo domínio:

- `GET /api/health`
- `GET /api/config`
- `POST /api/verificar`
- `POST /api/otp/gerar`
- `POST /api/otp/validar`
- `POST /api/lead`
- `POST /api/cadastro`

Essas rotas existem apenas no servidor Node (`api/server.js`). Se o host servir só arquivo estático (Firebase Hosting, GCS, nginx só de HTML), o navegador recebe **404 HTML** em `/api/verificar` — isso **não** significa “cadastro não existe na Gera”.

Quando o proxy está no ar, “não existe” vem assim:

```json
{ "ok": true, "existe": false }
```

com **HTTP 200**.

## Como subir

Node 18+ no servidor.

```bash
cd api
cp .env.example .env
# preencher as variáveis (ver abaixo)
npm install
npm start
```

O Express serve a LP e a API na mesma porta (`PORT`, padrão `3000`).

O domínio público precisa apontar para **esse processo Node** (ou um reverse proxy na frente dele). Exemplos válidos:

- Cloud Run / VM / container rodando `node server.js`
- nginx/Caddy encaminhando `/` e `/api/*` para o Node

Exemplo inválido: upload só da pasta do HTML para hosting estático.

### Conferência rápida

Depois do deploy, abra:

`https://SEU-DOMINIO/api/health`

Resposta esperada:

```json
{
  "ok": true,
  "geraConfigurada": true,
  "indicoConfigurada": true,
  "recaptcha": true
}
```

Se isso der 404, a API não está no ar.

## Variáveis de ambiente

Copie `api/.env.example` para `api/.env` **no servidor**. Esse arquivo **não vai no Git**.

| Variável | Função |
|---|---|
| `PORT` | Porta do Node |
| `GERA_BASE_URL` | HML: `https://hmlapi.revendedorloccitaneaubresil.com` — produção: `https://api.revendedorloccitaneaubresil.com` |
| `GERA_TOKEN_PATH` | `/api/token` |
| `GERA_CLIENT_ID` | `IntegradorLOccitane` |
| `GERA_CLIENT_SECRET` | segredo do integrador |
| `GERA_USERNAME` | código da líder / indicante (`2315`) |
| `GERA_PASSWORD` | senha do integrador |
| `GERA_INDICATOR_CODE` | `2315` |
| `GERA_ZIPCODE_PATH` | `/api/Public/GeographicalStructures?postalCode={cep}` |
| `GERA_PASSWORD_PATH` | `PATCH /api/password` com o token da revendedora (nunca o do integrador) |
| `GERA_ESCRITORIO_URL` | HML: `https://hmlgeraad.revendedorloccitaneaubresil.com/` — produção: `https://revendedor.loccitaneaubresil.com/` |
| `INDICO_API_BASE` | API do OTP Indico (staging: `https://lp-collector-api-670020683031.us-east1.run.app`) |
| `INDICO_DB_ID` | UUID do destino (`X-Db-ID`) |
| `INDICO_OTP_PURPOSE` | `registration` |
| `INDICO_ORIGIN` | origem enviada à Indico — use a URL pública, ex. `https://querorevender.loccitaneaubresil.com` |
| `RECAPTCHA_SITE_KEY` | chave de site do reCAPTCHA v3 |
| `DINAMIZE_WEBHOOK_URL` | webhook de entrada da automação que envia o e-mail de acesso |
| `DINAMIZE_USER` / `DINAMIZE_PASSWORD` / `DINAMIZE_CLIENT_CODE` | autenticação da API (`POST /auth`) |
| `DINAMIZE_LIST_CODE` | lista de contatos com os campos `usuario`, `senha`, `codigo`, `escritorio_url` |

Não use `https://api.gera.com.br` como `GERA_BASE_URL`. Isso é só o catálogo da documentação.

## Origem na Indico

No destino Indico, a URL pública do site precisa estar em `allowed_origins`. Sem isso o generate do OTP falha mesmo com o `DB_ID` certo.

Em local: `http://localhost:3000`.  
Em produção: `https://querorevender.loccitaneaubresil.com` (ou o domínio final).

## Fluxo do cadastro

1. A LP valida CEP, e-mail e CPF.
2. `POST /api/verificar` consulta CPF/e-mail na Gera.
   - Já existe → pede para entrar no Escritório Virtual.
   - Não existe → segue.
3. `POST /api/otp/gerar` envia o código de 6 dígitos (Indico).
4. `POST /api/otp/validar` confere o PIN.
5. `POST /api/lead` grava o lead no destino Indico (`POST /api/v1/leads`).
6. `POST /api/cadastro` cria o revendedor na Gera (`POST /api/Public/Sellers`), lê o `accessKey` do retorno, troca por um token da revendedora (`grant_type=access_key`) e define a senha `Locci@` com `PATCH /api/password`. Depois mostra o acesso na tela e envia o mesmo pela Dinamize.

## Dinamize

No painel da Dinamize:

1. Crie uma lista com os campos `usuario`, `senha`, `codigo` e `escritorio_url` (ou informe os códigos `cmp*` no `.env`).
2. Crie a peça de e-mail usando esses campos.
3. Crie uma automação disparada por **webhook de entrada** ou por **contato adicionado/atualizado**.
4. Coloque `DINAMIZE_WEBHOOK_URL` e/ou usuário + senha + `client_code` + `list_code` no `.env` do servidor.

O proxy autentica em `POST https://api.dinamize.com/auth`, grava o contato em `/emkt/contact/add` e, se houver webhook, dispara a automação com `{ email, nome, usuario, senha, codigo, escritorio_url }`.

## Local

```bash
cd api
npm install
npm start
```

Abra `http://localhost:3000`. Não abra o `index.html` direto no arquivo.
