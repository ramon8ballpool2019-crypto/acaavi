// api/frete.js
// Recebe um CEP (?cep=33202506), descobre o endereço, mede a distância até a loja
// e devolve o frete por faixa de distância, já ASSINADO pelo servidor.
// O checkout só aceita frete assinado aqui, então o valor não pode ser inventado pelo navegador.

import { createHmac } from 'node:crypto';

const PROJECT_ID = 'acaavi-d8138';
const FS_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

// Valores usados quando o admin ainda não configurou nada (config/site.frete)
const FRETE_PADRAO = {
  ativo: true,
  lojaCep: '33202506', // Rua Osmar da Silva Araújo — Vespasiano/MG (confirme no teste do link)
  faixas: [
    { ate: 1, valor: 4.99 },
    { ate: 2, valor: 5.99 },
    { ate: 3, valor: 6.99 },
  ],
};

const FATOR_ESTIMATIVA = 1.3;            // usado só se o serviço de rotas falhar (linha reta x 1,3)
const VALIDADE_COTACAO_MS = 60 * 60 * 1000; // 1 hora
const CACHE_MS = 6 * 60 * 60 * 1000;     // guarda consultas de CEP por 6 horas
const cacheCep = new Map();

// ── Utilidades ───────────────────────────────────────────────────────────────
async function getJson(url, ms = 3500, headers = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json', ...headers } });
    let json = null;
    try { json = await r.json(); } catch (e) { /* sem JSON */ }
    return { ok: r.ok, status: r.status, json };
  } finally {
    clearTimeout(timer);
  }
}

function coordenadaValida(lat, lng) {
  // limites aproximados do Brasil; descarta 0,0 e valores quebrados
  return Number.isFinite(lat) && Number.isFinite(lng) && lat > -34 && lat < 6 && lng > -74 && lng < -33;
}

const semAcento = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

// Aceita "-19.69, -43.92" (como o Google Maps copia) e devolve {lat, lng}
function lerCoord(texto) {
  if (typeof texto !== 'string') return null;
  const m = texto.match(/(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  return coordenadaValida(lat, lng) ? { lat, lng } : null;
}

function haversineKm(a, b) {
  const R = 6371;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ── Leitura da configuração salva no Firestore (leitura pública) ─────────────
function decodeValue(v) {
  if (v == null) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodeValue);
  if ('mapValue' in v) return decodeFields(v.mapValue.fields || {});
  return null;
}

function decodeFields(fields) {
  const out = {};
  for (const [k, val] of Object.entries(fields || {})) out[k] = decodeValue(val);
  return out;
}

async function lerConfigSite() {
  const r = await getJson(`${FS_URL}/config/site`, 4000);
  if (r.status === 404) return {};
  if (!r.ok) throw new Error(`Firestore config/site: HTTP ${r.status}`);
  return decodeFields((r.json && r.json.fields) || {});
}

function configFrete(site) {
  const f = (site && site.frete) || {};
  const cepLoja = String(f.lojaCep || '').replace(/\D/g, '');
  let faixas = Array.isArray(f.faixas)
    ? f.faixas
        .map((x) => ({ ate: Number(x && x.ate), valor: Number(x && x.valor) }))
        .filter((x) => x.ate > 0 && Number.isFinite(x.valor) && x.valor >= 0)
    : [];
  if (!faixas.length) faixas = FRETE_PADRAO.faixas;
  faixas.sort((a, b) => a.ate - b.ate);
  return {
    ativo: f.ativo !== false,
    lojaCep: cepLoja.length === 8 ? cepLoja : FRETE_PADRAO.lojaCep,
    lojaCoord: lerCoord(f.lojaCoord), // opcional: ponto exato da loja (copiado do Google Maps)
    faixas,
  };
}

// ── Localização da rua pelo nome (OpenStreetMap / Nominatim) ──────────────────
// Só vale se achar uma RUA (não bairro nem cidade), na mesma cidade, e curta o bastante
// para o ponto representar bem o endereço. Rua muito longa vira "aproximado".
async function geocodificarRua(endereco) {
  if (!endereco || !endereco.rua || !endereco.cidade) return { diag: { tentou: false } };
  const q = [endereco.rua, endereco.bairro, endereco.cidade, endereco.uf, 'Brasil'].filter(Boolean).join(', ');
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=br&q=${encodeURIComponent(q)}`;
  const diag = { tentou: true };
  try {
    const r = await getJson(url, 4000, { 'User-Agent': 'AcaviFrete/1.0 (https://acaavi.vercel.app)', 'Accept-Language': 'pt-BR' });
    diag.status = r.status;
    const item = Array.isArray(r.json) ? r.json[0] : null;
    if (!r.ok || !item) return { diag };
    const lat = Number(item.lat);
    const lng = Number(item.lon);
    diag.rank = item.place_rank;
    diag.tipo = item.addresstype || item.type;
    if (!coordenadaValida(lat, lng)) return { diag };
    if (!(Number(item.place_rank) >= 26)) { diag.motivo = 'resultado_generico'; return { diag }; }
    if (!semAcento(item.display_name).includes(semAcento(endereco.cidade))) { diag.motivo = 'outra_cidade'; return { diag }; }
    let aproximado = true;
    if (Array.isArray(item.boundingbox) && item.boundingbox.length === 4) {
      const [s, n, w, e] = item.boundingbox.map(Number);
      if ([s, n, w, e].every(Number.isFinite)) {
        const extensao = haversineKm({ lat: s, lng: w }, { lat: n, lng: e });
        diag.extensaoKm = Math.round(extensao * 100) / 100;
        aproximado = extensao > 1.5;
      }
    }
    return { lat, lng, aproximado, diag };
  } catch (e) {
    diag.erro = String((e && e.message) || e);
    return { diag };
  }
}

// ── Consulta de CEP: endereço + coordenadas ──────────────────────────────────
async function buscarCep(cep) {
  let endereco = null;
  let lat = null;
  let lng = null;
  let aproximado = false;
  let fonte = null;
  let respondeu = false; // algum serviço deu uma resposta definitiva (achou ou "não existe")
  const diag = {};

  // 1) AwesomeAPI: endereço + coordenadas do CEP
  try {
    const r = await getJson(`https://cep.awesomeapi.com.br/json/${cep}`);
    diag.awesomeapi = { status: r.status };
    if (r.ok && r.json && r.json.cep) {
      respondeu = true;
      endereco = {
        rua: r.json.address || '',
        bairro: r.json.district || r.json.neighborhood || '',
        cidade: r.json.city || '',
        uf: r.json.state || '',
      };
      const la = Number(r.json.lat);
      const lo = Number(r.json.lng);
      diag.awesomeapi.coordenadas = coordenadaValida(la, lo);
      if (coordenadaValida(la, lo)) { lat = la; lng = lo; fonte = 'awesomeapi'; }
    } else if (r.status === 404 || r.status === 400) {
      respondeu = true;
    }
  } catch (e) { diag.awesomeapi = { erro: String((e && e.message) || e) }; }

  // 2) ViaCEP: endereço (se a primeira fonte não deu)
  if (!endereco) {
    try {
      const r = await getJson(`https://viacep.com.br/ws/${cep}/json/`);
      diag.viacep = { status: r.status };
      if (r.ok && r.json) {
        respondeu = true;
        if (!r.json.erro) {
          endereco = {
            rua: r.json.logradouro || '',
            bairro: r.json.bairro || '',
            cidade: r.json.localidade || '',
            uf: r.json.uf || '',
          };
        }
      } else if (r.status === 400 || r.status === 404) {
        respondeu = true;
      }
    } catch (e) { diag.viacep = { erro: String((e && e.message) || e) }; }
  }

  // 3) Sem coordenadas do CEP: localiza a RUA pelo nome (OpenStreetMap)
  if (lat == null && endereco) {
    const g = await geocodificarRua(endereco);
    diag.nominatim = g.diag;
    if (g.lat != null) { lat = g.lat; lng = g.lng; aproximado = g.aproximado; fonte = 'nominatim'; }
  }

  // 4) Última reserva: BrasilAPI. As coordenadas podem ser aproximadas, então o frete vira "a confirmar"
  if (lat == null) {
    try {
      const r = await getJson(`https://brasilapi.com.br/api/cep/v2/${cep}`);
      diag.brasilapi = { status: r.status };
      if (r.ok && r.json) {
        respondeu = true;
        if (!endereco && r.json.cep) {
          endereco = {
            rua: r.json.street || '',
            bairro: r.json.neighborhood || '',
            cidade: r.json.city || '',
            uf: r.json.state || '',
          };
        }
        const c = r.json.location && r.json.location.coordinates;
        const la = Number(c && c.latitude);
        const lo = Number(c && c.longitude);
        diag.brasilapi.coordenadas = coordenadaValida(la, lo);
        if (coordenadaValida(la, lo)) { lat = la; lng = lo; aproximado = true; fonte = 'brasilapi'; }
      } else if (r.status === 404) {
        respondeu = true;
      }
    } catch (e) { diag.brasilapi = { erro: String((e && e.message) || e) }; }
  }

  diag.fonte = fonte;
  diag.aproximado = aproximado;
  return { encontrado: !!endereco, indisponivel: !respondeu, endereco, lat, lng, aproximado, diag };
}

async function consultarCep(cep) {
  const guardado = cacheCep.get(cep);
  if (guardado && Date.now() - guardado.t < CACHE_MS) return guardado.dados;
  const dados = await buscarCep(cep);
  if (dados.encontrado) cacheCep.set(cep, { t: Date.now(), dados });
  return dados;
}

// ── Distância por rota (OSRM) com plano B de linha reta ──────────────────────
async function distanciaKm(a, b) {
  try {
    const r = await getJson(
      `https://router.project-osrm.org/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=false`,
      3000
    );
    const metros = r.json && r.json.routes && r.json.routes[0] && r.json.routes[0].distance;
    if (r.ok && r.json.code === 'Ok' && Number.isFinite(metros)) {
      return { km: metros / 1000, metodo: 'rota' };
    }
  } catch (e) { /* cai no plano B */ }
  return { km: haversineKm(a, b) * FATOR_ESTIMATIVA, metodo: 'estimativa' };
}

// ── Assinatura da cotação (o checkout confere a mesma conta) ─────────────────
function assinar(segredo, { cep, km, valor, aConfirmar, exp }) {
  const v = aConfirmar ? 'A' : Number(valor).toFixed(2);
  const k = km == null ? '-' : String(km);
  return createHmac('sha256', segredo).update(`${cep}|${k}|${v}|${exp}`).digest('hex');
}

// ── Handler ──────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, erro: 'metodo_nao_permitido' });
  }

  const segredo = (process.env.MP_ACCESS_TOKEN || '').trim();
  if (!segredo) {
    return res.status(500).json({ ok: false, erro: 'servidor_sem_chave' });
  }

  const cep = String((req.query && req.query.cep) || '').replace(/\D/g, '');
  if (cep.length !== 8) {
    return res.status(400).json({ ok: false, erro: 'cep_invalido' });
  }

  let site;
  try {
    site = await lerConfigSite();
  } catch (e) {
    console.error('Falha ao ler a configuração do frete:', e);
    return res.status(503).json({ ok: false, erro: 'config_indisponivel' });
  }

  const conf = configFrete(site);
  if (!conf.ativo) {
    return res.status(200).json({ ok: false, erro: 'desativado' });
  }

  // Loja primeiro (fica em cache) e depois o destino: respeita o limite de 1 consulta por segundo do OpenStreetMap
  const loja = conf.lojaCoord
    ? { encontrado: true, lat: conf.lojaCoord.lat, lng: conf.lojaCoord.lng, aproximado: false, endereco: null, diag: { fonte: 'admin' } }
    : await consultarCep(conf.lojaCep);
  const dest = await consultarCep(cep);

  if (!dest.encontrado) {
    if (dest.indisponivel) return res.status(503).json({ ok: false, erro: 'servico_indisponivel' });
    return res.status(404).json({ ok: false, erro: 'cep_nao_encontrado' });
  }

  let km = null;
  let metodo = null;
  let valor = null;
  let aConfirmar = false;
  let motivo = null;

  const semCoordenadas = dest.lat == null || loja.lat == null || dest.aproximado || loja.aproximado;
  if (semCoordenadas) {
    aConfirmar = true;
    motivo = 'distancia_indisponivel';
  } else {
    const d = await distanciaKm({ lat: loja.lat, lng: loja.lng }, { lat: dest.lat, lng: dest.lng });
    km = Math.round(d.km * 10) / 10; // 1 casa decimal: é o que o cliente vê e o que define a faixa
    metodo = d.metodo;
    const faixa = conf.faixas.find((f) => km <= f.ate);
    if (faixa) {
      valor = Number(faixa.valor.toFixed(2));
    } else {
      aConfirmar = true;
      motivo = 'acima_da_faixa';
    }
  }

  const exp = Date.now() + VALIDADE_COTACAO_MS;
  const cotacao = {
    cep,
    km,
    valor: aConfirmar ? null : valor,
    aConfirmar,
    exp,
    assinatura: assinar(segredo, { cep, km, valor, aConfirmar, exp }),
  };

  const resposta = {
    ok: true,
    cep,
    endereco: dest.endereco,
    distanciaKm: km,
    metodo,
    valor: aConfirmar ? null : valor,
    aConfirmar,
    motivo,
    ateKm: conf.faixas[conf.faixas.length - 1].ate,
    cotacao,
  };
  // Modo diagnóstico (?debug=1): mostra de onde veio cada informação, sem dados sensíveis
  if (req.query && req.query.debug !== undefined) {
    resposta.diagnostico = {
      destino: dest.diag,
      loja: { cep: conf.lojaCep, usandoCoordenadasDoAdmin: !!conf.lojaCoord, endereco: loja.endereco || null, ...loja.diag },
    };
  }
  return res.status(200).json(resposta);
}
