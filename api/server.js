require("dotenv").config();
const crypto = require("crypto");
const path = require("path");
const express = require("express");

const PORT = Number(process.env.PORT) || 3000;
const BASE_URL = String(process.env.GERA_BASE_URL || "").replace(/\/$/, "");
const TOKEN_PATH = process.env.GERA_TOKEN_PATH || "/token";
const SELLERS_PATH = process.env.GERA_SELLERS_PATH || "/api/Public/Sellers";
const ZIPCODE_PATH = process.env.GERA_ZIPCODE_PATH || "/api/Public/GeographicalStructures?postalCode={cep}";
const DOCUMENT_TYPE_CPF = process.env.GERA_DOCUMENT_TYPE_CPF || "2";
const INDICATOR_CODE = process.env.GERA_INDICATOR_CODE || "2315";
const REGISTRATION_ORIGIN = process.env.GERA_REGISTRATION_ORIGIN || "";
const passwordPathEnv = String(process.env.GERA_PASSWORD_PATH || "").trim();
const PASSWORD_PATH = !passwordPathEnv || /\/api\/password\/?$/i.test(passwordPathEnv)
  ? "/api/people/{id}"
  : passwordPathEnv;
const ESCRITORIO_URL = process.env.GERA_ESCRITORIO_URL
  || (BASE_URL.includes("hml")
    ? "https://hmlgeraad.revendedorloccitaneaubresil.com/"
    : "https://revendedor.loccitaneaubresil.com/");
const SENHA_PREFIXO = "Locci@";
const SENHA_LETRAS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz";
const SENHA_NUMEROS = "23456789";
const SENHA_EXTRA = `${SENHA_LETRAS}${SENHA_NUMEROS}`;

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
  if (Array.isArray(corpo)) {
    return corpo
      .map((item) => (typeof item === "string" ? item : item?.message || item?.errorMessage || item?.exceptionMessage || ""))
      .filter(Boolean)
      .join(" ");
  }
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
  if (/invalid_grant|usu[aá]rio ou senha/.test(texto)) {
    return "As credenciais da API Gera foram recusadas. Peça o reset da senha do integrador HML.";
  }
  if (/invalid_client/.test(texto)) {
    return "O client da API Gera foi recusado. Confira o clientId e o clientSecret.";
  }
  if (/unauthor|authent|credential|access.?token|bearer/.test(texto) || status === 401) {
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
  const allowsRegisterDivulgation = Boolean(body.allowsRegisterDivulgation);
  const acceptsMessages = Boolean(body.acceptsMessages);

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
      acceptTerms,
      allowsRegisterDivulgation,
      acceptsMessages
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

const escolherChar = (alfabeto) => alfabeto[crypto.randomBytes(1)[0] % alfabeto.length];

const gerarSenhaAleatoria = () => {
  const sufixo = [
    escolherChar(SENHA_LETRAS),
    escolherChar(SENHA_LETRAS),
    escolherChar(SENHA_NUMEROS),
    escolherChar(SENHA_EXTRA),
    escolherChar(SENHA_EXTRA),
    escolherChar(SENHA_EXTRA)
  ];
  for (let i = sufixo.length - 1; i > 0; i -= 1) {
    const j = crypto.randomBytes(1)[0] % (i + 1);
    [sufixo[i], sufixo[j]] = [sufixo[j], sufixo[i]];
  }
  return `${SENHA_PREFIXO}${sufixo.join("")}`;
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
    allowsRegisterDivulgation: String(dados.allowsRegisterDivulgation),
    acceptsMessages: String(dados.acceptsMessages),
    indicatorCode: INDICATOR_CODE
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
  "/api/public/validateNewRegisterDocument?value={cpf}&type=2",
  "/api/public/validateNewRegisterDocument?value={cpf}&type=1",
  "/api/public/people?document={cpf}&typeDocument=2",
  "/api/public/people?document={cpf}&typeDocument=1",
  "/api/public/people?email={email}",
  "/api/people?document={cpf}&includeOptions=documents&includeOptions=emails",
  "/api/sellers?functionCode=1&document={cpf}&includeOptions=documents&includeOptions=emails",
  "/api/sellers?functionCode=1&email={email}&includeOptions=emails"
].join(",")).split(",").map((item) => item.trim()).filter(Boolean);
const SELLER_GET_PATH = process.env.GERA_SELLER_GET_PATH || "/api/Public/Sellers/{code}";
const OTP_DEV_REVEAL = String(process.env.OTP_DEV_REVEAL || "") === "1";
const emailsVerificados = new Map();
const otpLocais = new Map();

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

const deveRevelarOtp = () => OTP_DEV_REVEAL;

const gerarOtpLocal = (email) => {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  otpLocais.set(email, {
    hash: crypto.createHash("sha256").update(code).digest("hex"),
    expires: Date.now() + 10 * 60 * 1000,
    tentativas: 0
  });
  return code;
};

const validarOtpLocal = (email, code) => {
  const item = otpLocais.get(email);
  if (!item) return false;
  if (Date.now() > item.expires || item.tentativas >= 5) {
    otpLocais.delete(email);
    return false;
  }
  item.tentativas += 1;
  const hash = crypto.createHash("sha256").update(soDigitos(code)).digest("hex");
  if (hash !== item.hash) return false;
  otpLocais.delete(email);
  return true;
};

const MENSAGEM_JA_EXISTE = /already registered|already exists|já cadastr|ja cadastr|já existe|ja existe|duplicad|em uso|in use|already in use/;

const listarRegistros = (corpo) => {
  if (Array.isArray(corpo)) return corpo.filter((item) => item && typeof item === "object");
  if (!corpo || typeof corpo !== "object") return [];
  const listas = [corpo.items, corpo.data, corpo.results, corpo.value, corpo.result, corpo.people, corpo.sellers];
  for (const lista of listas) {
    if (Array.isArray(lista)) return lista.filter((item) => item && typeof item === "object");
  }
  if (corpo.id || corpo.code || corpo.personCode || corpo.sellerCode || corpo.personId || corpo.mainDocument || corpo.name) {
    return [corpo];
  }
  return [];
};

const numeroDocumento = (item) => {
  if (!item || typeof item !== "object") return "";
  if (Array.isArray(item.document)) {
    const cpf = item.document.find((doc) => soDigitos(doc?.document || doc?.number || "").length === 11);
    return soDigitos((cpf || item.document[0])?.document || (cpf || item.document[0])?.number || "");
  }
  if (item.document && typeof item.document === "object") {
    return soDigitos(item.document.document || item.document.number || item.document.value || "");
  }
  return soDigitos(item.mainDocument || item.document || item.cpf || item.identification || "");
};

const emailRegistro = (item) => {
  if (!item || typeof item !== "object") return "";
  if (typeof item.email === "string") return item.email.trim().toLowerCase();
  if (Array.isArray(item.emails) && item.emails[0]) {
    const primeiro = item.emails[0];
    return String(primeiro.email || primeiro.address || primeiro).trim().toLowerCase();
  }
  return String(item.mail || "").trim().toLowerCase();
};

const registroBateConsulta = (item, { cpf, email }) => {
  if (!item || typeof item !== "object") return false;
  const doc = numeroDocumento(item);
  const mail = emailRegistro(item);
  if (cpf && doc === cpf) return true;
  if (email && mail && mail === email) return true;
  return false;
};

const corpoIndicaExistencia = (corpo, consulta = {}) => {
  if (corpo == null) return false;
  if (corpo === true) return true;
  if (corpo === false) return false;
  if (typeof corpo !== "object") return false;
  if (corpo.isValid === true || corpo.valid === true || corpo.canRegister === true || corpo.available === true) {
    return false;
  }
  if (corpo.isValid === false || corpo.valid === false || corpo.canRegister === false || corpo.available === false) {
    return true;
  }
  const flags = [
    corpo.exists,
    corpo.exist,
    corpo.alreadyExists,
    corpo.alreadyRegistered,
    corpo.isRegistered,
    corpo.registered,
    corpo.hasRegister,
    corpo.hasRegistration,
    corpo.documentExists,
    corpo.emailExists,
    corpo.personExists,
    corpo.isDuplicated,
    corpo.duplicated,
    corpo.inUse,
    corpo.found
  ];
  if (flags.some((flag) => flag === true)) return true;
  if (corpo.document === true || corpo.email === true) return true;
  const texto = String(corpo.message || corpo.exceptionMessage || corpo.error || "").toLowerCase();
  if (MENSAGEM_JA_EXISTE.test(texto)) return true;
  return listarRegistros(corpo).some((item) => registroBateConsulta(item, consulta));
};

const caminhosLookup = (tipo) => LOOKUP_PATHS.filter((modelo) => (
  tipo === "cpf" ? /\{cpf\}|document|cpf/i.test(modelo) : /\{email\}|email/i.test(modelo)
));

const buscarRegistro = async (token, caminho, consulta = {}) => {
  try {
    const resposta = await fetch(joinUrl(BASE_URL, caminho), {
      headers: { Authorization: `Bearer ${token}` }
    });
    const corpo = await lerJsonSeguro(resposta);
    const texto = extrairMensagem(corpo);
    if (resposta.status === 404 || resposta.status === 204) {
      return { ok: true, encontrado: false, status: resposta.status };
    }
    if (resposta.status === 409) {
      return { ok: true, encontrado: true, status: resposta.status };
    }
    if (!resposta.ok) {
      if (MENSAGEM_JA_EXISTE.test(texto.toLowerCase())) {
        return { ok: true, encontrado: true, status: resposta.status };
      }
      console.warn("[verificar] falha", resposta.status, caminho.split("?")[0], texto.slice(0, 80));
      return { ok: false, encontrado: false, status: resposta.status };
    }
    const encontrado = corpoIndicaExistencia(corpo, consulta);
    const chaves = corpo && typeof corpo === "object" && !Array.isArray(corpo)
      ? Object.keys(corpo).slice(0, 12).join(",")
      : (Array.isArray(corpo) ? `array:${corpo.length}` : "");
    console.log("[verificar]", resposta.status, caminho.split("?")[0], encontrado ? "existe" : "livre", chaves, texto.slice(0, 80));
    return { ok: true, encontrado, status: resposta.status };
  } catch (erro) {
    console.warn("[verificar] erro", caminho.split("?")[0], erro.message);
    return { ok: false, encontrado: false, status: 0 };
  }
};

const consultarExistencia = async (token, { cpf, email }) => {
  const campos = [];
  let consultaOk = false;

  const tentar = async (tipo, valor) => {
    if (!valor) return;
    let achou = false;
    const consulta = tipo === "cpf" ? { cpf: valor } : { email: valor };
    for (const modelo of caminhosLookup(tipo)) {
      const caminho = modelo
        .replace("{cpf}", encodeURIComponent(tipo === "cpf" ? valor : ""))
        .replace("{email}", encodeURIComponent(tipo === "email" ? valor : ""));
      const resultado = await buscarRegistro(token, caminho, consulta);
      if (resultado.ok) consultaOk = true;
      if (resultado.encontrado) {
        achou = true;
        break;
      }
    }
    if (achou) campos.push(tipo === "cpf" ? "CPF" : "e-mail");
  };

  if (cpf && cpf.length === 11) await tentar("cpf", cpf);
  if (email) await tentar("email", email);
  if (!consultaOk) {
    const erro = new Error("Não foi possível consultar o CPF e o e-mail agora. Tente de novo em instantes.");
    erro.status = 502;
    throw erro;
  }
  if (!campos.length) return { existe: false, campos: [] };
  return { existe: true, campos, campo: campos.join(" e ") };
};

const extrairCodigoRevendedora = (corpo) => {
  if (!corpo || typeof corpo !== "object") return "";
  const primeiro = Array.isArray(corpo) ? corpo[0] : corpo.data || corpo;
  const fonte = Array.isArray(primeiro) ? primeiro[0] : primeiro;
  if (!fonte || typeof fonte !== "object") return "";
  return String(
    fonte.userCode
    || fonte.code
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

const obterRevendedorPorDocumento = async (token, { cpf, email }) => {
  const caminhos = [];
  if (cpf) {
    caminhos.push(`/api/sellers?functionCode=1&document=${encodeURIComponent(cpf)}&includeOptions=documents&includeOptions=emails`);
    caminhos.push(`/api/Public/Sellers?mainDocument=${encodeURIComponent(cpf)}`);
  }
  if (email) {
    caminhos.push(`/api/sellers?functionCode=1&email=${encodeURIComponent(email)}&includeOptions=emails`);
  }
  for (const caminho of caminhos) {
    const resposta = await fetch(joinUrl(BASE_URL, caminho), {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!resposta.ok) continue;
    const corpo = await lerJsonSeguro(resposta);
    const registros = listarRegistros(corpo);
    const bate = registros.find((item) => registroBateConsulta(item, { cpf, email }));
    if (bate) return bate;
    if (registros[0]) return registros[0];
  }
  return {};
};

const definirSenha = async (token, { senha, codigo }) => {
  const personCode = String(codigo || "").trim();
  if (!PASSWORD_PATH || !senha || !personCode) return { ok: false, status: 0 };
  if (!/^\d+$/.test(personCode) || Number(personCode) <= 0) return { ok: false, status: 0 };

  const caminho = PASSWORD_PATH.includes("{id}")
    ? PASSWORD_PATH.replace("{id}", encodeURIComponent(personCode))
    : `${PASSWORD_PATH.replace(/\/$/, "")}/${encodeURIComponent(personCode)}`;
  const resposta = await fetch(joinUrl(BASE_URL, caminho), {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify([{ password: senha }])
  });
  const corpo = await lerJsonSeguro(resposta);
  if (!resposta.ok) {
    console.warn("[senha] PUT people", resposta.status, extrairMensagem(corpo).slice(0, 120));
  }
  return { ok: resposta.ok, status: resposta.status };
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

const generoIndico = (gender) => {
  if (Number(gender) === 1) return "female";
  if (Number(gender) === 2) return "male";
  return "prefer_not_to_say";
};

const dataNascimentoIndico = (birthday) => {
  const texto = String(birthday || "");
  if (/^\d{4}-\d{2}-\d{2}/.test(texto)) return texto.slice(0, 10);
  const data = new Date(texto);
  if (Number.isNaN(data.getTime())) return "";
  return data.toISOString().slice(0, 10);
};

const montarLeadIndico = (dados, captchaToken, extras = {}) => {
  const lead = {
    captcha_token: captchaToken,
    full_name: dados.nome,
    email: dados.email,
    document: dados.cpf,
    document_type: "cpf",
    phone: dados.telefone,
    whatsapp: dados.telefone,
    zip_code: dados.zipCode,
    street: dados.rua,
    street_number: dados.addressNumber,
    neighborhood: dados.bairro,
    city: dados.cidade,
    state: dados.uf,
    country: "BR",
    accept_terms: Boolean(dados.acceptTerms),
    accept_privacy: Boolean(dados.acceptTerms),
    contact_authorization: Boolean(dados.acceptTerms)
  };
  const nascimento = dataNascimentoIndico(dados.birthday);
  if (nascimento) lead.birth_date = nascimento;
  if (dados.gender) lead.gender = generoIndico(dados.gender);
  if (dados.complemento) lead.complement = dados.complemento;
  if (dados.referencia) lead.message = dados.referencia;
  if (extras.landing_page_url) lead.landing_page_url = extras.landing_page_url;
  if (extras.referrer) lead.referrer = extras.referrer;
  ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"].forEach((campo) => {
    const valor = String(extras[campo] || "").trim();
    if (valor) lead[campo] = valor;
  });
  return lead;
};

const enviarLeadIndico = async (req, dados, captchaToken, extras = {}) => {
  if (!captchaToken) {
    const erro = new Error("Faltou o captcha para gravar o lead.");
    erro.status = 400;
    throw erro;
  }
  const { resposta, corpo } = await chamarIndico(
    req,
    "/api/v1/leads",
    montarLeadIndico(dados, captchaToken, extras)
  );
  const falhou = String(corpo?.status || corpo?.reason || corpo?.error || "").toLowerCase();
  console.log("[lead]", resposta.status, corpo?.id || "", falhou || "aceito");
  if ((!resposta.ok && resposta.status !== 202) || /no column mapping|failed/.test(falhou)) {
    const erro = new Error(
      /no column mapping/.test(falhou)
        ? "O destino Indico ainda não tem column_map. Sem isso o lead não entra no banco."
        : (mensagemOtp(corpo, resposta.status) || "Não foi possível gravar o lead.")
    );
    erro.status = resposta.status || 502;
    throw erro;
  }
  return corpo;
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
    escritorioUrl: ESCRITORIO_URL
  });
});

app.post("/api/verificar", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const cpf = soDigitos(req.body?.cpf);
  const emailOk = Boolean(email) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const cpfOk = cpf.length === 11;
  if (!emailOk && !cpfOk) {
    return res.status(400).json({ ok: false, message: "Informe um CPF ou um e-mail válidos." });
  }
  if (email && !emailOk) {
    return res.status(400).json({ ok: false, message: "Informe um e-mail válido." });
  }
  if (cpf && !cpfOk) {
    return res.status(400).json({ ok: false, message: "Informe um CPF válido." });
  }
  if (!BASE_URL) {
    return res.status(503).json({ ok: false, message: "A URL da API Gera ainda não foi configurada." });
  }
  try {
    const token = await obterToken();
    const consulta = await consultarExistencia(token, {
      cpf: cpfOk ? cpf : "",
      email: emailOk ? email : ""
    });
    if (consulta.existe) {
      return res.json({
        ok: false,
        existe: true,
        campo: consulta.campo,
        campos: consulta.campos,
        message: `Já existe um cadastro com este ${consulta.campo}. Entre no Escritório Virtual.`
      });
    }
    return res.json({ ok: true, existe: false, campos: [] });
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
  const revelar = deveRevelarOtp();
  const devCode = revelar ? gerarOtpLocal(email) : "";
  try {
    const { resposta, corpo } = await chamarIndico(req, "/api/v1/otp/generate", {
      email,
      captcha_token: captchaToken,
      purpose: INDICO_OTP_PURPOSE
    });
    if (!resposta.ok) {
      console.warn("[otp/gerar]", resposta.status, corpo?.error || mensagemOtp(corpo, resposta.status));
      if (devCode) {
        return res.status(201).json({
          ok: true,
          devCode,
          message: "A Indico não enviou o e-mail. Use o código de teste na tela."
        });
      }
      return res.status(resposta.status).json({
        ok: false,
        message: mensagemOtp(corpo, resposta.status)
      });
    }
    console.log("[otp/gerar]", resposta.status, "enviado", corpo?.expires_at || "");
    return res.status(201).json({
      ok: true,
      expiresAt: corpo.expires_at || null,
      ...(devCode ? { devCode } : {}),
      message: devCode
        ? "Se o e-mail não chegou, use o código de teste na tela."
        : "Enviamos um código de 6 dígitos para o seu e-mail. Confira também a caixa de spam."
    });
  } catch (erro) {
    if (devCode) {
      return res.status(201).json({
        ok: true,
        devCode,
        message: "A Indico não enviou o e-mail. Use o código de teste na tela."
      });
    }
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
    if (resposta.ok) {
      marcarEmailVerificado(email);
      return res.json({ ok: true, message: "E-mail confirmado." });
    }
    if (validarOtpLocal(email, code)) {
      marcarEmailVerificado(email);
      return res.json({ ok: true, message: "E-mail confirmado." });
    }
    return res.status(resposta.status).json({
      ok: false,
      message: mensagemOtp(corpo, resposta.status)
    });
  } catch (erro) {
    if (validarOtpLocal(email, code)) {
      marcarEmailVerificado(email);
      return res.json({ ok: true, message: "E-mail confirmado." });
    }
    return res.status(erro.status || 502).json({
      ok: false,
      message: erro.message || "Não foi possível validar o código."
    });
  }
});

app.post("/api/lead", async (req, res) => {
  const validacao = validarPayload(req.body || {});
  if (validacao.erro) {
    return res.status(400).json({ ok: false, message: validacao.erro });
  }
  if (!emailFoiVerificado(validacao.dados.email)) {
    return res.status(403).json({
      ok: false,
      message: "Confirme o código enviado por e-mail antes de gravar o lead."
    });
  }
  const captchaToken = String(req.body?.captcha_token || "").trim();
  if (!captchaToken) {
    return res.status(400).json({ ok: false, message: "Faltou o captcha. Recarregue a página e tente de novo." });
  }
  try {
    await enviarLeadIndico(req, validacao.dados, captchaToken, {
      landing_page_url: String(req.body?.landing_page_url || "").trim(),
      referrer: String(req.body?.referrer || "").trim(),
      utm_source: req.body?.utm_source,
      utm_medium: req.body?.utm_medium,
      utm_campaign: req.body?.utm_campaign,
      utm_term: req.body?.utm_term,
      utm_content: req.body?.utm_content
    });
    return res.status(202).json({ ok: true, message: "Lead gravado." });
  } catch (erro) {
    return res.status(erro.status || 502).json({
      ok: false,
      message: erro.message || "Não foi possível gravar o lead."
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
        campos: consulta.campos,
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
    let codigoFinal = extrairCodigoRevendedora(detalhe) || codigo;
    if (!codigoFinal) {
      try {
        detalhe = await obterRevendedorPorDocumento(token, validacao.dados);
        codigoFinal = extrairCodigoRevendedora(detalhe) || codigoFinal;
      } catch {
        codigoFinal = codigoFinal || "";
      }
    }

    let senhaGravada = false;
    try {
      const gravacao = await definirSenha(token, {
        senha,
        codigo: codigoFinal
      });
      senhaGravada = Boolean(gravacao.ok);
    } catch (erroSenha) {
      console.warn("[senha] PUT people erro", erroSenha.message);
    }
    emailsVerificados.delete(validacao.dados.email);

    return res.json({
      ok: true,
      login: validacao.dados.email,
      senha: senhaGravada ? senha : "",
      codigo: codigoFinal,
      message: senhaGravada
        ? "Cadastro criado. Guarde seu usuário e senha agora."
        : "Cadastro criado. A senha de acesso foi enviada para o seu e-mail."
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
