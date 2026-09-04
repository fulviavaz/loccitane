require("dotenv").config();
const crypto = require("crypto");
const path = require("path");
const express = require("express");

const PORT = Number(process.env.PORT) || 3000;
const BASE_URL = String(process.env.GERA_BASE_URL || "").replace(/\/$/, "");
const TOKEN_PATH = process.env.GERA_TOKEN_PATH || "/token";
const SELLERS_PATH = process.env.GERA_SELLERS_PATH || "/api/Public/Sellers";
const ZIPCODE_PATH = process.env.GERA_ZIPCODE_PATH || "/api/Public/GeographicalStructures?postalCode={cep}";
const DOCUMENT_TYPE_CPF = process.env.GERA_DOCUMENT_TYPE_CPF || "1";
const INDICATOR_CODE = process.env.GERA_INDICATOR_CODE || "2315";
const REGISTRATION_ORIGIN = process.env.GERA_REGISTRATION_ORIGIN || "";
const SENHA_PREFIXO = "Locci@";
const SENHA_ALFABETO = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789#$@";

const tokenCache = { token: "", expiresAt: 0 };

const soDigitos = (valor) => String(valor || "").replace(/\D/g, "");

const joinUrl = (base, pathname) => {
  const pathPart = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${base}${pathPart}`;
};

const lerJsonSeguro = async (resposta) => {
  const texto = await resposta.text();
  if (!texto) return {};
  try {
    return JSON.parse(texto);
  } catch {
    return { message: texto };
  }
};

const extrairMensagem = (corpo) => {
  if (!corpo || typeof corpo !== "object") return "";
  if (typeof corpo.message === "string" && corpo.message.trim()) return corpo.message;
  if (typeof corpo.exceptionMessage === "string") return corpo.exceptionMessage;
  if (typeof corpo.error_description === "string") return corpo.error_description;
  if (typeof corpo.error === "string") return corpo.error;
  if (Array.isArray(corpo.errors)) {
    return corpo.errors
      .map((item) => (typeof item === "string" ? item : item?.message || item?.errorMessage || ""))
      .filter(Boolean)
      .join(" ");
  }
  if (corpo.errors && typeof corpo.errors === "object") {
    return Object.values(corpo.errors).flat().filter(Boolean).join(" ");
  }
  return "";
};

const mensagemAmigavel = (bruta, status) => {
  const texto = String(bruta || "").toLowerCase();
  if (/already|exist|duplicate|já cadastr|ja cadastr|em uso|already registered/.test(texto)) {
    return "Este CPF ou e-mail já está cadastrado. Tente entrar no Escritório Virtual.";
  }
  if (/cep|zip\s*code|zipcode|postal/.test(texto)) {
    return "Não encontramos esse CEP. Confira os números e tente de novo.";
  }
  if (/logradouro/.test(texto) && /preench/.test(texto)) {
    return "Não encontramos esse logradouro na Gera. Confira o CEP e o nome da rua.";
  }
  if (/cpf|document|maindocument/.test(texto)) {
    return "Confira o CPF. Os números não foram aceitos.";
  }
  if (/e-?mail|email/.test(texto)) {
    return "Confira o e-mail. Esse endereço não foi aceito.";
  }
  if (/pend[eê]ncia|pending|document/.test(texto) && /rg|comprovante|resid/.test(texto)) {
    return "O cadastro foi criado, mas ainda há pendências. Complete os dados no Escritório Virtual.";
  }
  if (/token|unauthor|authent|credential|invalid_client|invalid_grant|usu[aá]rio ou senha|password/.test(texto) || status === 401) {
    return "Não foi possível conectar à API agora. Tente de novo em instantes.";
  }
  if (status >= 500) {
    return "A API está indisponível no momento. Tente de novo em instantes.";
  }
  return bruta && bruta.length < 180
    ? bruta
    : "Não foi possível concluir o cadastro. Confira os dados e tente de novo.";
};

const validarPayload = (body) => {
  const nome = String(body.nome || "").trim();
  const email = String(body.email || "").trim().toLowerCase();
  const cpf = soDigitos(body.cpf);
  const telefone = soDigitos(body.telefone);
  const zipCode = soDigitos(body.zipCode);
  const addressNumber = String(body.addressNumber || "").trim();
  const birthday = String(body.birthday || "").trim();
  const gender = Number(body.gender);
  const rua = String(body.rua || body.logradouro || "").trim();
  const complemento = String(body.complemento || "").trim();
  const referencia = String(body.referencia || "").trim();
  const bairro = String(body.bairro || "").trim();
  const cidade = String(body.cidade || "").trim();
  const uf = String(body.uf || "").trim().toUpperCase();
  const acceptTerms = Boolean(body.acceptTerms);

  if (!nome) return { erro: "Informe o nome completo." };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { erro: "Informe um e-mail válido." };
  if (cpf.length !== 11) return { erro: "Informe um CPF válido." };
  if (telefone.length < 10 || telefone.length > 11) return { erro: "Informe um WhatsApp válido." };
  if (zipCode.length !== 8) return { erro: "Informe um CEP válido." };
  if (!addressNumber) return { erro: "Informe o número do endereço." };
  if (!rua) return { erro: "Informe o logradouro." };
  if (!uf) return { erro: "Selecione a UF." };
  if (!birthday) return { erro: "Informe a data de nascimento." };
  if (!Number.isInteger(gender) || gender < 1) return { erro: "Selecione o gênero." };
  if (!cidade) return { erro: "Informe a cidade." };
  if (!referencia) return { erro: "Informe o ponto de referência." };
  if (!acceptTerms) return { erro: "É preciso aceitar os termos para se cadastrar." };

  const nascimento = new Date(birthday);
  if (Number.isNaN(nascimento.getTime())) return { erro: "Informe uma data de nascimento válida." };
  const hoje = new Date();
  const idade = hoje.getFullYear() - nascimento.getFullYear()
    - (hoje < new Date(hoje.getFullYear(), nascimento.getMonth(), nascimento.getDate()) ? 1 : 0);
  if (idade < 18) return { erro: "O cadastro é para pessoas com 18 anos ou mais." };

  return {
    dados: {
      nome,
      email,
      cpf,
      telefone,
      zipCode,
      addressNumber,
      birthday: nascimento.toISOString(),
      gender,
      rua,
      complemento,
      referencia,
      bairro,
      cidade,
      uf,
      acceptTerms
    }
  };
};

const obterToken = async () => {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt - 30_000) {
    return tokenCache.token;
  }

  const resposta = await fetch(joinUrl(BASE_URL, TOKEN_PATH), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: process.env.GERA_GRANT_TYPE || "password",
      client_id: process.env.GERA_CLIENT_ID || "",
      client_secret: process.env.GERA_CLIENT_SECRET || "",
      username: process.env.GERA_USERNAME || "",
      password: process.env.GERA_PASSWORD || ""
    })
  });

  const corpo = await lerJsonSeguro(resposta);
  const token = corpo.access_token || corpo.accessToken || corpo.token;
  if (!resposta.ok || !token) {
    const erro = new Error(extrairMensagem(corpo) || "Falha ao obter token público.");
    erro.status = resposta.status || 502;
    throw erro;
  }

  tokenCache.token = token;
  tokenCache.expiresAt = Date.now() + Number(corpo.expires_in || 3600) * 1000;
  return token;
};

const normalizarTexto = (valor) => String(valor || "")
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .replace(/\./g, "")
  .replace(/\s+/g, " ")
  .trim();

const listarEstruturas = (corpo) => {
  if (Array.isArray(corpo)) return corpo;
  if (Array.isArray(corpo?.data)) return corpo.data;
  if (Array.isArray(corpo?.items)) return corpo.items;
  if (Array.isArray(corpo?.results)) return corpo.results;
  return corpo && typeof corpo === "object" ? [corpo] : [];
};

const escolherCodigoLogradouro = (corpo, logradouro) => {
  const itens = listarEstruturas(corpo);
  const folhas = itens.filter((item) => (
    item?.isLeaf
    || Number(item?.level?.code) === 4
    || /logradouro/i.test(String(item?.level?.name || ""))
  ));
  const candidatos = folhas.length ? folhas : itens;
  const alvo = normalizarTexto(logradouro);
  const porNome = alvo
    ? candidatos.find((item) => {
      const nome = normalizarTexto(item?.name);
      return nome && (nome === alvo || nome.includes(alvo) || alvo.includes(nome));
    })
    : null;
  const escolhido = porNome || folhas[0] || itens.find((item) => item?.isLeaf) || itens[itens.length - 1];
  const codigo = escolhido?.code ?? escolhido?.geographicStructureCode ?? escolhido?.id;
  return codigo === undefined || codigo === null || codigo === "" ? "" : String(codigo);
};

const resolverEstruturaGeografica = async (token, zipCode, logradouro) => {
  if (!ZIPCODE_PATH) return "";
  const caminho = ZIPCODE_PATH.includes("{cep}") || ZIPCODE_PATH.includes("{zipCode}")
    ? ZIPCODE_PATH.replace("{cep}", zipCode).replace("{zipCode}", zipCode)
    : `${ZIPCODE_PATH}${ZIPCODE_PATH.includes("?") ? "&" : "?"}postalCode=${zipCode}`;

  const resposta = await fetch(joinUrl(BASE_URL, caminho), {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!resposta.ok) return "";
  const corpo = await lerJsonSeguro(resposta);
  return escolherCodigoLogradouro(corpo, logradouro);
};

const gerarSenhaAleatoria = () => {
  const bytes = crypto.randomBytes(6);
  let sufixo = "";
  for (let i = 0; i < 6; i += 1) {
    sufixo += SENHA_ALFABETO[bytes[i] % SENHA_ALFABETO.length];
  }
  return `${SENHA_PREFIXO}${sufixo}`;
};

const cadastrarRevendedor = async (token, dados, geographicStructureCode, senha) => {
  const campos = {
    name: dados.nome,
    mainDocument: dados.cpf,
    mainDocumentTypeId: DOCUMENT_TYPE_CPF,
    email: dados.email,
    birthday: dados.birthday,
    gender: String(dados.gender),
    zipCode: dados.zipCode,
    addressNumber: dados.addressNumber,
    addressLevel1: dados.uf,
    addressLevel2: dados.cidade,
    addressLevel3: dados.bairro,
    addressLevel4: dados.rua,
    mobilePhone: dados.telefone,
    acceptTerms: String(dados.acceptTerms),
    indicatorCode: INDICATOR_CODE,
    password: senha
  };

  if (dados.complemento) campos.addressComplement = dados.complemento;
  campos.addressReference = dados.referencia;
  if (geographicStructureCode) campos.geographicStructureCode = geographicStructureCode;
  if (REGISTRATION_ORIGIN) campos.registrationOrigin = REGISTRATION_ORIGIN;

  const resposta = await fetch(joinUrl(BASE_URL, SELLERS_PATH), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams(campos)
  });

  const corpo = await lerJsonSeguro(resposta);
  return { resposta, corpo };
};

const INDICO_API_BASE = String(process.env.INDICO_API_BASE || "").replace(/\/$/, "");
const INDICO_DB_ID = process.env.INDICO_DB_ID || "";
const INDICO_OTP_PURPOSE = process.env.INDICO_OTP_PURPOSE || "registration";
const INDICO_ORIGIN = process.env.INDICO_ORIGIN || "http://localhost:3000";
const RECAPTCHA_SITE_KEY = process.env.RECAPTCHA_SITE_KEY || "";
const LOOKUP_PATHS = String(process.env.GERA_LOOKUP_PATHS || [
  "/api/Public/People?mainDocument={cpf}",
  "/api/Public/People?email={email}",
  "/api/Public/Sellers?mainDocument={cpf}",
  "/api/Public/Sellers?email={email}"
].join(",")).split(",").map((item) => item.trim()).filter(Boolean);
const SELLER_GET_PATH = process.env.GERA_SELLER_GET_PATH || "/api/Public/Sellers/{code}";
const emailsVerificados = new Map();

const marcarEmailVerificado = (email) => {
  emailsVerificados.set(email, Date.now() + 15 * 60 * 1000);
};

const emailFoiVerificado = (email) => {
  const expira = emailsVerificados.get(email);
  if (!expira || Date.now() > expira) {
    emailsVerificados.delete(email);
    return false;
  }
  return true;
};

const temRegistro = (corpo) => {
  if (!corpo || typeof corpo !== "object") return false;
  if (Array.isArray(corpo)) return corpo.length > 0;
  if (Array.isArray(corpo.items)) return corpo.items.length > 0;
  if (Array.isArray(corpo.data)) return corpo.data.length > 0;
  if (Array.isArray(corpo.results)) return corpo.results.length > 0;
  return Boolean(
    corpo.id
    || corpo.code
    || corpo.personCode
    || corpo.sellerCode
    || corpo.mainDocument
    || corpo.email
  );
};

const consultarExistencia = async (token, { cpf, email }) => {
  for (const modelo of LOOKUP_PATHS) {
    const caminho = modelo
      .replace("{cpf}", encodeURIComponent(cpf))
      .replace("{email}", encodeURIComponent(email));
    try {
      const resposta = await fetch(joinUrl(BASE_URL, caminho), {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (resposta.status === 404) continue;
      const corpo = await lerJsonSeguro(resposta);
      if (resposta.ok && temRegistro(corpo)) {
        const porCpf = /document|cpf/i.test(modelo);
        return { existe: true, campo: porCpf ? "CPF" : "e-mail" };
      }
    } catch {
      continue;
    }
  }
  return { existe: false };
};

const extrairCodigoRevendedora = (corpo) => {
  if (!corpo || typeof corpo !== "object") return "";
  const primeiro = Array.isArray(corpo) ? corpo[0] : corpo.data || corpo;
  const fonte = Array.isArray(primeiro) ? primeiro[0] : primeiro;
  if (!fonte || typeof fonte !== "object") return "";
  return String(
    fonte.code
    || fonte.sellerCode
    || fonte.personCode
    || fonte.personId
    || fonte.id
    || ""
  );
};

const extrairCredenciais = (corpo, email) => {
  const fonte = Array.isArray(corpo) ? corpo[0] : corpo?.data || corpo || {};
  const registro = Array.isArray(fonte) ? fonte[0] : fonte;
  if (!registro || typeof registro !== "object") {
    return { login: email, senha: "", codigo: "" };
  }
  return {
    login: String(registro.login || registro.userName || registro.username || registro.email || registro.code || email),
    senha: String(registro.password || registro.temporaryPassword || registro.generatedPassword || ""),
    codigo: extrairCodigoRevendedora(registro)
  };
};

const obterRevendedor = async (token, codigo) => {
  if (!codigo) return {};
  const caminho = SELLER_GET_PATH.replace("{code}", encodeURIComponent(codigo));
  const resposta = await fetch(joinUrl(BASE_URL, caminho), {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!resposta.ok) return {};
  return lerJsonSeguro(resposta);
};

const origemIndico = (req) => req.get("origin") || INDICO_ORIGIN;

const chamarIndico = async (req, pathname, payload) => {
  if (!INDICO_API_BASE) {
    const erro = new Error("A API da Indico ainda não foi configurada.");
    erro.status = 503;
    throw erro;
  }
  if (!INDICO_DB_ID) {
    const erro = new Error("Falta o X-Db-ID do destino Indico (INDICO_DB_ID).");
    erro.status = 503;
    throw erro;
  }
  const resposta = await fetch(`${INDICO_API_BASE}${pathname}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Db-ID": INDICO_DB_ID,
      Origin: origemIndico(req)
    },
    body: JSON.stringify(payload)
  });
  const corpo = await lerJsonSeguro(resposta);
  return { resposta, corpo };
};

const mensagemOtp = (corpo, status) => {
  const erro = String(corpo?.error || "").toLowerCase();
  if (erro.includes("invalid captcha")) return "Não foi possível validar o captcha. Recarregue a página e tente de novo.";
  if (erro.includes("otp sender not configured")) return "O envio de e-mail ainda não está configurado neste destino. Avise a Indico.";
  if (erro.includes("origin is not allowed")) return "Esta página ainda não está liberada no destino da Indico.";
  if (erro.includes("destination not found")) return "Destino da Indico não encontrado. Confira o X-Db-ID.";
  if (erro.includes("otp generate limit reached")) return "Muitas tentativas. Aguarde um minuto e peça um código novo.";
  if (erro.includes("error sending otp")) return "Não foi possível enviar o e-mail com o código. Tente de novo.";
  if (erro.includes("invalid otp")) return "Código inválido ou expirado. Confira os 6 dígitos ou peça um novo.";
  if (status === 429) return "Muitas tentativas. Aguarde um minuto e peça um código novo.";
  return corpo?.error || "Não foi possível validar o código agora.";
};

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  return next();
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    geraConfigurada: Boolean(BASE_URL),
    indicoConfigurada: Boolean(INDICO_API_BASE && INDICO_DB_ID),
    recaptcha: Boolean(RECAPTCHA_SITE_KEY)
  });
});

app.get("/api/config", (_req, res) => {
  res.json({
    recaptchaSiteKey: RECAPTCHA_SITE_KEY,
    escritorioUrl: "https://revendedor.loccitaneaubresil.com/"
  });
});

app.post("/api/verificar", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const cpf = soDigitos(req.body?.cpf);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || cpf.length !== 11) {
    return res.status(400).json({ ok: false, message: "Informe um CPF e um e-mail válidos." });
  }
  if (!BASE_URL) {
    return res.status(503).json({ ok: false, message: "A URL da API Gera ainda não foi configurada." });
  }
  try {
    const token = await obterToken();
    const consulta = await consultarExistencia(token, { cpf, email });
    if (consulta.existe) {
      return res.json({
        ok: false,
        existe: true,
        campo: consulta.campo,
        message: `Já existe um cadastro com este ${consulta.campo}. Entre no Escritório Virtual.`
      });
    }
    return res.json({ ok: true, existe: false });
  } catch (erro) {
    return res.status(502).json({
      ok: false,
      message: mensagemAmigavel(erro.message, erro.status || 502)
    });
  }
});

app.post("/api/otp/gerar", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const captchaToken = String(req.body?.captcha_token || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, message: "Informe um e-mail válido." });
  }
  if (!captchaToken) {
    return res.status(400).json({ ok: false, message: "Faltou o captcha. Recarregue a página e tente de novo." });
  }
  try {
    const { resposta, corpo } = await chamarIndico(req, "/api/v1/otp/generate", {
      email,
      captcha_token: captchaToken,
      purpose: INDICO_OTP_PURPOSE
    });
    if (!resposta.ok) {
      return res.status(resposta.status).json({
        ok: false,
        message: mensagemOtp(corpo, resposta.status)
      });
    }
    return res.status(201).json({
      ok: true,
      expiresAt: corpo.expires_at || null,
      message: "Enviamos um código de 6 dígitos para o seu e-mail."
    });
  } catch (erro) {
    return res.status(erro.status || 502).json({
      ok: false,
      message: erro.message || "Não foi possível enviar o código."
    });
  }
});

app.post("/api/otp/validar", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const code = soDigitos(req.body?.code);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || code.length !== 6) {
    return res.status(400).json({ ok: false, message: "Informe o código de 6 dígitos enviado por e-mail." });
  }
  try {
    const { resposta, corpo } = await chamarIndico(req, "/api/v1/otp/validate", {
      email,
      code,
      purpose: INDICO_OTP_PURPOSE
    });
    if (!resposta.ok) {
      return res.status(resposta.status).json({
        ok: false,
        message: mensagemOtp(corpo, resposta.status)
      });
    }
    marcarEmailVerificado(email);
    return res.json({ ok: true, message: "E-mail confirmado." });
  } catch (erro) {
    return res.status(erro.status || 502).json({
      ok: false,
      message: erro.message || "Não foi possível validar o código."
    });
  }
});

app.post("/api/cadastro", async (req, res) => {
  const validacao = validarPayload(req.body || {});
  if (validacao.erro) {
    return res.status(400).json({ ok: false, message: validacao.erro });
  }

  if (!emailFoiVerificado(validacao.dados.email)) {
    return res.status(403).json({
      ok: false,
      message: "Confirme o código enviado por e-mail antes de concluir o cadastro."
    });
  }

  if (!BASE_URL) {
    return res.status(503).json({
      ok: false,
      message: "A URL da API Gera ainda não foi configurada (GERA_BASE_URL)."
    });
  }

  try {
    const token = await obterToken();
    const consulta = await consultarExistencia(token, validacao.dados);
    if (consulta.existe) {
      return res.status(409).json({
        ok: false,
        existe: true,
        campo: consulta.campo,
        message: `Já existe um cadastro com este ${consulta.campo}. Entre no Escritório Virtual.`
      });
    }

    let geographicStructureCode = "";
    try {
      geographicStructureCode = await resolverEstruturaGeografica(
        token,
        validacao.dados.zipCode,
        validacao.dados.rua
      );
    } catch {
      geographicStructureCode = "";
    }

    const senha = gerarSenhaAleatoria();
    const { resposta, corpo } = await cadastrarRevendedor(
      token,
      validacao.dados,
      geographicStructureCode,
      senha
    );
    if (!resposta.ok) {
      const bruta = extrairMensagem(corpo);
      const existe = /already|exist|duplicate|já cadastr|ja cadastr|em uso/i.test(bruta);
      return res.status(existe ? 409 : (resposta.status === 401 ? 502 : resposta.status)).json({
        ok: false,
        existe,
        message: mensagemAmigavel(bruta, resposta.status)
      });
    }

    const codigo = extrairCodigoRevendedora(corpo);
    let detalhe = {};
    try {
      detalhe = await obterRevendedor(token, codigo);
    } catch {
      detalhe = {};
    }
    const codigoFinal = extrairCodigoRevendedora(detalhe) || codigo;
    emailsVerificados.delete(validacao.dados.email);

    return res.json({
      ok: true,
      login: validacao.dados.email,
      senha,
      codigo: codigoFinal,
      message: "Cadastro criado. Guarde seu usuário e senha agora."
    });
  } catch (erro) {
    return res.status(502).json({
      ok: false,
      message: mensagemAmigavel(erro.message, erro.status || 502)
    });
  }
});

app.use(express.static(path.join(__dirname, "..")));

app.listen(PORT, () => {
  if (!BASE_URL) {
    console.warn("GERA_BASE_URL vazia: o site sobe, mas o cadastro fica indisponível até preencher o .env.");
  }
  console.log(`LP + proxy em http://localhost:${PORT}`);
});
