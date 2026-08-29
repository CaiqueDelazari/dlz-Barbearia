/**
 * Venda avulsa: o cliente que entra só para comprar um xampu.
 *
 * O que precisa valer aqui: o dinheiro entra no caixa, o estoque baixa, e
 * nada disso cria agendamento — senão a agenda e o ticket médio por
 * atendimento passam a mentir.
 */
import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { query } from '@/lib/db';
import { criarEmpresa, dinheiro, fecharPool, hojeLocal, type Empresa } from '../helpers/e2e';

let empresa: Empresa;

async function criarProduto(data: {
  name: string;
  price: number;
  stockQuantity?: number;
  trackStock?: boolean;
}) {
  const r = await empresa.api.post('/products', data);
  assert.equal(r.status, 201, JSON.stringify(r.error));
  return r.data.product as { id: string; name: string; price: number; stockQuantity: number };
}

const estoqueDe = async (id: string) => {
  const r = await empresa.api.get(`/products/${id}`);
  return (r.data.product as { stockQuantity: number }).stockQuantity;
};

const caixaDeHoje = async () => {
  const hoje = hojeLocal();
  const r = await empresa.api.get(`/financial/summary?range=custom&from=${hoje}&to=${hoje}`);
  assert.equal(r.status, 200, JSON.stringify(r.error));
  return r.data as {
    entradas: number;
    pagamentosPorMetodo: { metodo: string; total: number }[];
    produtosVendidos: { produto: string; quantidade: number; total: number }[];
  };
};

before(async () => {
  empresa = await criarEmpresa('venda-avulsa');
});

after(async () => {
  await empresa.cleanup();
  await fecharPool();
});

describe('registrar', () => {
  test('baixa o estoque e devolve os itens da venda', async () => {
    const xampu = await criarProduto({ name: 'Xampu balcão', price: 145, stockQuantity: 10 });

    const r = await empresa.api.post('/sales', {
      items: [{ productId: xampu.id, quantity: 2 }],
      method: 'cash',
    });

    assert.equal(r.status, 201, JSON.stringify(r.error));
    assert.equal(dinheiro(r.data.sale.total), 290);
    assert.equal(r.data.sale.items.length, 1);
    assert.equal(r.data.sale.items[0].quantity, 2);
    assert.equal(r.data.sale.clientId, null, 'cliente é opcional');

    assert.equal(await estoqueDe(xampu.id), 8);
  });

  test('não cria agendamento nenhum', async () => {
    const oleo = await criarProduto({ name: 'Óleo balcão', price: 60, stockQuantity: 4 });
    await empresa.api.post('/sales', {
      items: [{ productId: oleo.id, quantity: 1 }],
      method: 'pix',
    });

    const agenda = await empresa.api.get('/appointments?limit=200');
    assert.equal(agenda.data.total, 0, 'venda de balcão não pode sujar a agenda');
  });

  test('a baixa de estoque fica no histórico do produto', async () => {
    const mascara = await criarProduto({ name: 'Máscara balcão', price: 180, stockQuantity: 5 });
    await empresa.api.post('/sales', {
      items: [{ productId: mascara.id, quantity: 3 }],
      method: 'card',
    });

    const detalhe = await empresa.api.get(`/products/${mascara.id}`);
    const venda = detalhe.data.movements.find((m: any) => m.reason === 'sale');
    assert.ok(venda, 'a saída precisa aparecer como movimento');
    assert.equal(venda.quantity, -3);
  });

  test('duas linhas do mesmo produto viram uma quantidade só', async () => {
    const kit = await criarProduto({ name: 'Kit balcão', price: 100, stockQuantity: 5 });

    const r = await empresa.api.post('/sales', {
      items: [
        { productId: kit.id, quantity: 1 },
        { productId: kit.id, quantity: 2 },
      ],
      method: 'cash',
    });

    assert.equal(r.status, 201, JSON.stringify(r.error));
    assert.equal(r.data.sale.items.length, 1);
    assert.equal(r.data.sale.items[0].quantity, 3);
    assert.equal(dinheiro(r.data.sale.total), 300);
    assert.equal(await estoqueDe(kit.id), 2);
  });

  test('recusa vender mais do que tem e não consome estoque', async () => {
    const pouco = await criarProduto({ name: 'Pouco balcão', price: 90, stockQuantity: 2 });

    const r = await empresa.api.post('/sales', {
      items: [{ productId: pouco.id, quantity: 5 }],
      method: 'cash',
    });

    assert.equal(r.status, 409);
    assert.equal(r.error?.code, 'out_of_stock');
    assert.equal(await estoqueDe(pouco.id), 2, 'a tentativa não pode consumir estoque');
  });

  test('uma linha inválida derruba a venda inteira', async () => {
    const bom = await criarProduto({ name: 'Bom balcão', price: 50, stockQuantity: 10 });
    const ruim = await criarProduto({ name: 'Ruim balcão', price: 50, stockQuantity: 1 });

    const r = await empresa.api.post('/sales', {
      items: [
        { productId: bom.id, quantity: 2 },
        { productId: ruim.id, quantity: 9 },
      ],
      method: 'cash',
    });

    assert.equal(r.status, 409);
    assert.equal(await estoqueDe(bom.id), 10, 'nada pode ser baixado pela metade');
  });

  test('produto sem controle de estoque vende sempre', async () => {
    const avulso = await criarProduto({ name: 'Sem controle balcão', price: 30, trackStock: false });
    const r = await empresa.api.post('/sales', {
      items: [{ productId: avulso.id, quantity: 40 }],
      method: 'other',
    });
    assert.equal(r.status, 201, JSON.stringify(r.error));
  });

  test('vincula o cliente quando ele é conhecido', async () => {
    const creme = await criarProduto({ name: 'Creme balcão', price: 70, stockQuantity: 6 });
    const cliente = await empresa.api.post('/clients', { name: 'Compradora', phone: '11955554444' });

    const r = await empresa.api.post('/sales', {
      clientId: cliente.data.client.id,
      items: [{ productId: creme.id, quantity: 1 }],
      method: 'pix',
    });

    assert.equal(r.status, 201, JSON.stringify(r.error));
    assert.equal(r.data.sale.clientId, cliente.data.client.id);
    assert.equal(r.data.sale.clientName, 'Compradora');
  });
});

describe('caixa', () => {
  test('a venda entra nas entradas do dia, pelo método usado', async () => {
    const antes = await caixaDeHoje();
    const pomada = await criarProduto({ name: 'Pomada caixa', price: 200, stockQuantity: 3 });

    await empresa.api.post('/sales', {
      items: [{ productId: pomada.id, quantity: 1 }],
      method: 'pix',
    });

    const depois = await caixaDeHoje();
    assert.equal(
      dinheiro(depois.entradas - antes.entradas),
      200,
      'venda de balcão é dinheiro que entrou hoje'
    );

    const pix = depois.pagamentosPorMetodo.find((m) => m.metodo === 'pix');
    const pixAntes = antes.pagamentosPorMetodo.find((m) => m.metodo === 'pix')?.total ?? 0;
    assert.equal(dinheiro((pix?.total ?? 0) - pixAntes), 200);
  });

  test('aparece na quebra de produtos vendidos', async () => {
    const talco = await criarProduto({ name: 'Talco quebra', price: 40, stockQuantity: 9 });
    await empresa.api.post('/sales', {
      items: [{ productId: talco.id, quantity: 2 }],
      method: 'cash',
    });

    const caixa = await caixaDeHoje();
    const linha = caixa.produtosVendidos.find((p) => p.produto === 'Talco quebra');
    assert.ok(linha, 'produto vendido no balcão precisa aparecer no financeiro');
    assert.equal(linha!.quantidade, 2);
    assert.equal(dinheiro(linha!.total), 80);
  });
});

describe('cancelar', () => {
  test('devolve o estoque, tira do caixa e mantém a venda no histórico', async () => {
    const sabonete = await criarProduto({ name: 'Sabonete cancelar', price: 25, stockQuantity: 12 });
    const antes = await caixaDeHoje();

    const criada = await empresa.api.post('/sales', {
      items: [{ productId: sabonete.id, quantity: 4 }],
      method: 'cash',
    });
    assert.equal(await estoqueDe(sabonete.id), 8);

    const cancelada = await empresa.api.del(`/sales/${criada.data.sale.id}?reason=erro de digitação`);
    assert.equal(cancelada.status, 200, JSON.stringify(cancelada.error));
    assert.ok(cancelada.data.sale.cancelledAt, 'a venda continua na lista, marcada');

    assert.equal(await estoqueDe(sabonete.id), 12, 'o estoque volta');

    const depois = await caixaDeHoje();
    assert.equal(dinheiro(depois.entradas), dinheiro(antes.entradas), 'o valor sai do caixa');

    const devolucao = await query(
      `SELECT quantity FROM product_movements
        WHERE tenant_id = $1 AND product_id = $2 AND reason = 'return'`,
      [empresa.tenantId, sabonete.id]
    );
    assert.equal(devolucao.length, 1, 'a devolução também vira movimento');
  });

  test('não cancela duas vezes', async () => {
    const cera = await criarProduto({ name: 'Cera dupla', price: 35, stockQuantity: 5 });
    const criada = await empresa.api.post('/sales', {
      items: [{ productId: cera.id, quantity: 1 }],
      method: 'cash',
    });

    await empresa.api.del(`/sales/${criada.data.sale.id}`);
    const outra = await empresa.api.del(`/sales/${criada.data.sale.id}`);

    assert.equal(outra.status, 400);
    assert.equal(await estoqueDe(cera.id), 5, 'o estoque não pode voltar duas vezes');
  });
});

describe('isolamento', () => {
  test('outra empresa não enxerga nem cancela a venda', async () => {
    const intrusa = await criarEmpresa('venda-intrusa');
    try {
      const produto = await criarProduto({ name: 'Privado', price: 80, stockQuantity: 4 });
      const criada = await empresa.api.post('/sales', {
        items: [{ productId: produto.id, quantity: 1 }],
        method: 'cash',
      });
      const saleId = criada.data.sale.id;

      const lista = await intrusa.api.get('/sales');
      assert.equal(lista.data.total, 0);

      assert.equal((await intrusa.api.get(`/sales/${saleId}`)).status, 404);
      assert.equal((await intrusa.api.del(`/sales/${saleId}`)).status, 404);

      assert.equal(await estoqueDe(produto.id), 3, 'nada pode ter sido devolvido');
    } finally {
      await intrusa.cleanup();
    }
  });

  test('exige sessão', async () => {
    const r = await empresa.anon.get('/sales');
    assert.equal(r.status, 401);
  });
});

describe('listagem', () => {
  test('pagina e conta o total', async () => {
    const pagina = await empresa.api.get('/sales?limit=2&offset=0');
    assert.equal(pagina.status, 200);
    assert.ok(pagina.data.items.length <= 2);
    assert.ok(pagina.data.total > 2, 'o total é o de verdade, não o da página');

    const segunda = await empresa.api.get('/sales?limit=2&offset=2');
    assert.notEqual(segunda.data.items[0]?.id, pagina.data.items[0]?.id);
  });
});
