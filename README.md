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
| `GERA_PASSWORD_PATH` | `/api/password` (PATCH da senha, se o POST não gravar) |
| `INDICO_API_BASE` | API do OTP Indico (staging: `https://lp-collector-api-670020683031.us-east1.run.app`) |
| `INDICO_DB_ID` | UUID do destino (`X-Db-ID`) |
| `INDICO_OTP_PURPOSE` | `registration` |
| `INDICO_ORIGIN` | origem enviada à Indico — use a URL pública, ex. `https://querorevender.loccitaneaubresil.com` |
| `RECAPTCHA_SITE_KEY` | chave de site do reCAPTCHA v3 |

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
6. `POST /api/cadastro` cria o revendedor na Gera, gera uma senha `Locci@` e mostra usuário/senha na tela de confirmação.

## Local

```bash
cd api
npm install
npm start
```

Abra `http://localhost:3000`. Não abra o `index.html` direto no arquivo.
