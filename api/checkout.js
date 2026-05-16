export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { total, descricao } = req.body;

  const preference = {
    items: [{
      title: descricao || 'Pedido Açaví',
      quantity: 1,
      currency_id: 'BRL',
      unit_price: parseFloat(total)
    }],
    back_urls: {
      success: process.env.SITE_URL + '?pagamento=aprovado',
      failure: process.env.SITE_URL + '?pagamento=falhou',
      pending: process.env.SITE_URL + '?pagamento=pendente'
    },
    auto_return: 'approved',
    statement_descriptor: 'ACAVI ACAI'
  };

  const response = await fetch('https://api.mercadopago.com/checkout/preferences', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}`
    },
    body: JSON.stringify(preference)
  });

  const data = await response.json();

  if (data.id) {
    res.status(200).json({ url: data.sandbox_init_point });
  } else {
    res.status(500).json({ error: 'Erro ao criar preferência', detail: data });
  }
}
