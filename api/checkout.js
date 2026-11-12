// api/checkout.js
// Cria o pagamento no Mercado Pago.
// O valor NÃO é confiado ao navegador: é recalculado aqui com os preços reais
// guardados no Firestore e só segue se bater com o valor mostrado no site.

const PROJECT_ID = 'acaavi-d8138';
const FS_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

// Mesmas zonas padrão do site (usadas quando o admin nunca salvou zonas)
const ZONAS_PADRAO = [
  { id: 'z1', nome: 'Vespasiano', taxa: 6.99 },
  { id: 'z2', nome: 'Santa Luzia', taxa: 8.99 },
  { id: 'z3', nome: 'Contagem', taxa: 10.99 },
  { id: 'z4', nome: 'Belo Horizonte', taxa: 12.99 },
];

class ErroPedido extends Error {
  constructor(codigo, mensagem, status = 400) {
    super(mensagem);
    this.codigo = codigo;
    this.status = status;
  }
}

// ── Leitura do Firestore (API REST, só leitura pública) ──────────────────────
function decodeValue(v) {
  if (v == null) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodeValue);
  if ('mapValue' in v) return decodeFields(v.mapValue.fields || {});
  return null;
}

function decodeFields(fields) {
  const out = {};
  for (const [k, val] of Object.entries(fields || {})) out[k] = decodeValue(val);
  return out;
}

const idDoDoc = (doc) => String(doc.name || '').split('/').pop();

async function fsFetch(caminho, params = '') {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(`${FS_URL}/${caminho}${params}`, { signal: ctrl.signal });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`Firestore ${caminho}: HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

async function lerDoc(caminho) {
  const doc = await fsFetch(caminho);
  return doc ? { id: idDoDoc(doc), ...decodeFields(doc.fields) } : null;
}

async function listarColecao(colecao) {
  const itens = [];
  let token = '';
  for (let i = 0; i < 5; i++) {
    const pagina = await fsFetch(colecao, `?pageSize=300${token ? '&pageToken=' + encodeURIComponent(token) : ''}`);
    if (!pagina) break;
    (pagina.documents || []).forEach((d) => itens.push({ id: idDoDoc(d), ...decodeFields(d.fields) }));
    if (!pagina.nextPageToken) break;
    token = pagina.nextPageToken;
  }
  return itens;
}

// ── Cálculo do total (espelha exatamente o cálculo do site) ──────────────────
function calcularPedido(pedido, { produto, complementos, config, cupons }) {
  if (produto.esgotado) {
    throw new ErroPedido('produto_esgotado', 'Este produto está esgotado no momento.');
  }

  // Preço base (variante escolhida ou preço do produto)
  let base;
  if (produto.tipo === 'variantes') {
    const v = (produto.variantes || []).find((x) => x.id === pedido.varianteId);
    if (!v) throw new ErroPedido('variante_invalida', 'Tamanho do açaí inválido. Atualize a página e tente de novo.');
    base = Number(v.preco);
  } else {
    base = Number(produto.preco);
  }
  if (!Number.isFinite(base) || base <= 0) {
    throw new ErroPedido('preco_invalido', 'Não foi possível calcular o valor do pedido.');
  }

  // Complementos
  const idsComps = [...new Set(Array.isArray(pedido.complementos) ? pedido.complementos : [])];
  let comps = 0;
  for (const id of idsComps) {
    const c = complementos.find((x) => x.id === id);
    if (!c) throw new ErroPedido('complemento_invalido', 'Um complemento do pedido não existe mais. Atualize a página.');
    comps += Number(c.preco) || 0;
  }

  // Adicionais (posição na lista do produto)
  const idxAdics = [...new Set(Array.isArray(pedido.adicionais) ? pedido.adicionais : [])];
  let adics = 0;
  for (const i of idxAdics) {
    const a = Number.isInteger(i) ? (produto.adicionais || [])[i] : null;
    if (!a) throw new ErroPedido('adicional_invalido', 'Um acréscimo do pedido não existe mais. Atualize a página.');
    adics += Number(a.preco) || 0;
  }

  // Entrega
  let taxa = 0;
  if (pedido.entrega === true) {
    const zonas = Array.isArray(config.zonas) ? config.zonas : ZONAS_PADRAO;
    const zona = zonas.find((z) => z.id === pedido.zonaId);
    if (zona) taxa = zona.gratis ? 0 : Number(zona.taxa) || 0;
    else taxa = zonas.length > 0 ? Number(zonas[0].taxa) || 0 : 6.99;
  }

  // Cupom
  const subtotal = base + comps + adics + taxa;
  let desconto = 0;
  if (pedido.cupom) {
    const codigo = String(pedido.cupom).trim().toUpperCase();
    const c = cupons.find((x) => x.codigo === codigo && x.ativo);
    if (!c) throw new ErroPedido('cupom_invalido', 'Cupom inválido ou expirado. Remova o cupom e tente de novo.');
    if (Number(c.minimo) > 0 && subtotal < Number(c.minimo)) {
      throw new ErroPedido('cupom_minimo', 'O pedido não atinge o valor mínimo do cupom. Remova o cupom e tente de novo.');
    }
    desconto = c.tipo === 'percent'
      ? Math.min(subtotal, (subtotal * Number(c.valor)) / 100)
      : Math.min(subtotal, Number(c.valor));
  }

  const total = Math.max(0, subtotal - desconto);
  return Math.round(total * 100) / 100;
}

async function carregarDados(pedido) {
  const temComps = Array.isArray(pedido.complementos) && pedido.complementos.length > 0;
  const [produto, complementos, config, cupons] = await Promise.all([
    lerDoc(`produtos/${pedido.produtoId}`),
    temComps ? listarColecao('complementos') : Promise.resolve([]),
    lerDoc('config/site'),
    pedido.cupom ? listarColecao('cupons') : Promise.resolve([]),
  ]);
  if (!produto) throw new ErroPedido('produto_invalido', 'Produto não encontrado. Atualize a página e tente de novo.');
  return { produto, complementos, config: config || {}, cupons };
}

// ── Handler ──────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // Teste rápido: abra /api/checkout?verificar=1 no navegador
  if (req.method === 'GET' && req.query && req.query.verificar !== undefined) {
    try {
      const [produtos, complementos, config] = await Promise.all([
        listarColecao('produtos'),
        listarColecao('complementos'),
        lerDoc('config/site'),
      ]);
      return res.status(200).json({
        leituraFirestore: 'ok',
        produtos: produtos.length,
        complementos: complementos.length,
        zonas: Array.isArray(config && config.zonas) ? config.zonas.length : 'padrão',
      });
    } catch (e) {
      return res.status(500).json({ leituraFirestore: 'falhou', detalhe: String((e && e.message) || e) });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const token = (process.env.MP_ACCESS_TOKEN || '').trim();
  if (!token) {
    return res.status(500).json({ error: 'MP_ACCESS_TOKEN não configurado no Vercel' });
  }

  const { total, descricao, pedido } = req.body || {};

  if (!pedido || typeof pedido !== 'object' || typeof pedido.produtoId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(pedido.produtoId)) {
    return res.status(400).json({
      error: 'pedido_ausente',
      mensagem: 'Atualize a página e tente novamente.',
    });
  }

  // Valor recalculado pelo servidor
  let valor;
  try {
    const dados = await carregarDados(pedido);
    valor = calcularPedido(pedido, dados);
  } catch (e) {
    if (e instanceof ErroPedido) {
      return res.status(e.status).json({ error: e.codigo, mensagem: e.message });
    }
    console.error('Falha ao validar o pedido:', e);
    return res.status(503).json({
      error: 'validacao_indisponivel',
      mensagem: 'Não foi possível confirmar o valor agora. Tente de novo ou pague pelo PIX.',
    });
  }

  if (!(valor > 0)) {
    return res.status(400).json({ error: 'valor_invalido', mensagem: 'Valor do pedido inválido.' });
  }

  // Compara com o que o site mostrou ao cliente (tolerância de 1 centavo)
  const valorCliente = Number(parseFloat(total).toFixed(2));
  if (!Number.isFinite(valorCliente) || Math.abs(Math.round(valorCliente * 100) - Math.round(valor * 100)) > 1) {
    console.warn('Valor divergente — cliente:', total, 'servidor:', valor);
    return res.status(409).json({
      error: 'valor_divergente',
      mensagem: 'O valor do pedido mudou. Atualize a página e tente de novo.',
    });
  }

  const site = process.env.SITE_URL || 'https://acaavi.vercel.app';

  const preference = {
    items: [{
      title: String(descricao || 'Pedido Açaví').slice(0, 250),
      quantity: 1,
      currency_id: 'BRL',
      unit_price: valor, // sempre o valor calculado pelo servidor
    }],
    back_urls: {
      success: site + '?pagamento=aprovado',
      failure: site + '?pagamento=falhou',
      pending: site + '?pagamento=pendente',
    },
    auto_return: 'approved',
    statement_descriptor: 'ACAVI ACAI',
  };

  try {
    const response = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(preference),
    });

    const data = await response.json();

    if (!data.id) {
      return res.status(500).json({ error: 'Erro ao criar preferência', detail: data });
    }

    // Credencial de teste (TEST-...) usa o checkout de teste;
    // credencial de produção (APP_USR-...) usa o checkout real.
    const url = token.startsWith('TEST-') ? data.sandbox_init_point : data.init_point;
    return res.status(200).json({ url });
  } catch (e) {
    return res.status(500).json({ error: 'Falha ao falar com o Mercado Pago', detail: String(e) });
  }
}
