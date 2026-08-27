/**
 * Produtos: catálogo, venda dentro do atendimento, estoque e o efeito no
 * total que o cliente vai pagar.
 */
import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import {
  agendarPeloPainel, ajustarConfig, criarEmpresa, criarServico, diaUtil, dinheiro,
  fecharPool, horarios, type Empresa,
} from '../helpers/e2e';

let empresa: Empresa;
let corte: { id: string; price: number; durationMinutes: number };

let proximo = 40;
const diaExclusivo = () => diaUtil((proximo += 2));

async function novoAtendimento(nome: string) {
  const dia = diaExclusivo();
  const { slots } = await horarios(empresa, dia, [corte.id]);
  const criado = await agendarPeloPainel(empresa, {
    startsAt: slots[0].startsAt,
    serviceIds: [corte.id],
    professionalId: slots[0].professionalId,
    nome,
    telefone: '11933332222',
  });
  return criado.appointments[0].id;
}

async function criarProduto(data: {
  name: string;
  price: number;
  costPrice?: number;
  stockQuantity?: number;
  minStock?: number;
  trackStock?: boolean;
  category?: string;
}) {
  const r = await empresa.api.post('/products', data);
  assert.equal(r.status, 201, JSON.stringify(r.error));
  return r.data.product as {
    id: string; name: string; price: number; stockQuantity: number; trackStock: boolean;
  };
}

const buscarProduto = async (id: string) => {
  const r = await empresa.api.get(`/products/${id}`);
  return r.data.product as { stockQuantity: number; active: boolean; price: number };
};

before(async () => {
  empresa = await criarEmpresa('produtos');
  await ajustarConfig(empresa, { onlinePaymentRequired: false, minAdvanceMinutes: 0 });
  corte = await criarServico(empresa, { name: 'Corte', price: 100, durationMinutes: 30 });
});

after(async () => {
  await empresa.cleanup();
  await fecharPool();
});

describe('catálogo', () => {
  test('cadastra com preço, custo e estoque', async () => {
    const p = await criarProduto({
      name: 'Xampu 300ml', price: 145, costPrice: 92, stockQuantity: 10, minStock: 3, category: 'Cabelo',
    });
    assert.equal(dinheiro(p.price), 145);
    assert.equal(p.stockQuantity, 10);

    const lista = await empresa.api.get('/products');
    assert.equal(lista.status, 200);
    assert.ok(lista.data.products.some((x: any) => x.id === p.id));
  });

  test('estoque inicial vira movimento no histórico', async () => {
    const p = await criarProduto({ name: 'Condicionador', price: 120, stockQuantity: 5 });
    const detalhe = await empresa.api.get(`/products/${p.id}`);
    assert.equal(detalhe.data.movements.length, 1);
    assert.equal(detalhe.data.movements[0].reason, 'restock');
    assert.equal(detalhe.data.movements[0].quantity, 5);
  });

  test('conta os que precisam de reposição', async () => {
    await criarProduto({ name: 'Acabando', price: 50, stockQuantity: 1, minStock: 3 });
    const lista = await empresa.api.get('/products');
    assert.ok(lista.data.lowStock >= 1);
  });

  test('editar preço não mexe no estoque', async () => {
    const p = await criarProduto({ name: 'Óleo', price: 200, stockQuantity: 4 });
    await empresa.api.patch(`/products/${p.id}`, { price: 230, stockQuantity: 999 });
    const depois = await buscarProduto(p.id);
    assert.equal(dinheiro(depois.price), 230);
    assert.equal(depois.stockQuantity, 4, 'estoque só muda por movimento');
  });

  test('produto sem venda é apagado de verdade', async () => {
    const p = await criarProduto({ name: 'Errado', price: 10 });
    const r = await empresa.api.del(`/products/${p.id}`);
    assert.equal(r.data.softDeleted, false);
    const sumiu = await empresa.api.get(`/products/${p.id}`);
    assert.equal(sumiu.status, 404);
  });
});

describe('venda no atendimento', () => {
  test('soma no total e baixa o estoque', async () => {
    const produto = await criarProduto({ name: 'Máscara', price: 180, stockQuantity: 6 });
    const appointmentId = await novoAtendimento('Compra Produto');

    const venda = await empresa.api.post(`/appointments/${appointmentId}/products`, {
      productId: produto.id, quantity: 2,
    });

    assert.equal(venda.status, 201);
    assert.equal(dinheiro(venda.data.appointment.total_amount), 100 + 180 * 2);

    const depois = await buscarProduto(produto.id);
    assert.equal(depois.stockQuantity, 4);
  });

  test('recusa vender mais do que tem', async () => {
    const produto = await criarProduto({ name: 'Pouco', price: 90, stockQuantity: 2 });
    const appointmentId = await novoAtendimento('Sem Estoque');

    const r = await empresa.api.post(`/appointments/${appointmentId}/products`, {
      productId: produto.id, quantity: 5,
    });

    assert.equal(r.status, 409);
    assert.equal(r.error?.code, 'out_of_stock');
    assert.match(r.error!.message, /2/);

    const intacto = await buscarProduto(produto.id);
    assert.equal(intacto.stockQuantity, 2, 'a tentativa não pode consumir estoque');
  });

  test('produto sem controle de estoque vende sempre', async () => {
    const produto = await criarProduto({ name: 'Serviço avulso', price: 30, trackStock: false });
    const appointmentId = await novoAtendimento('Sem Controle');

    const r = await empresa.api.post(`/appointments/${appointmentId}/products`, {
      productId: produto.id, quantity: 50,
    });
    assert.equal(r.status, 201);
  });

  test('desfazer devolve ao estoque e tira do total', async () => {
    const produto = await criarProduto({ name: 'Leave-in', price: 95, stockQuantity: 8 });
    const appointmentId = await novoAtendimento('Desfaz');

    await empresa.api.post(`/appointments/${appointmentId}/products`, {
      productId: produto.id, quantity: 3,
    });
    const vendas = await empresa.api.get(`/appointments/${appointmentId}/products`);
    assert.equal(vendas.data.products.length, 1);

    const removido = await empresa.api.del(
      `/appointments/${appointmentId}/products?saleId=${vendas.data.products[0].id}`
    );

    assert.equal(dinheiro(removido.data.appointment.total_amount), 100, 'voltou ao valor do serviço');
    const depois = await buscarProduto(produto.id);
    assert.equal(depois.stockQuantity, 8);
  });

  test('o restante a pagar acompanha a venda', async () => {
    const produto = await criarProduto({ name: 'Kit', price: 250, stockQuantity: 5 });
    const appointmentId = await novoAtendimento('Restante');

    await empresa.api.post(`/appointments/${appointmentId}/payments`, { amount: 100, method: 'pix' });
    let extrato = await empresa.api.get(`/appointments/${appointmentId}/payments`);
    assert.equal(dinheiro(extrato.data.resumo.restante), 0, 'serviço quitado');

    await empresa.api.post(`/appointments/${appointmentId}/products`, { productId: produto.id, quantity: 1 });
    extrato = await empresa.api.get(`/appointments/${appointmentId}/payments`);

    assert.equal(dinheiro(extrato.data.resumo.total), 350);
    assert.equal(dinheiro(extrato.data.resumo.restante), 250, 'o produto virou saldo devedor');
    assert.equal(extrato.data.resumo.status, 'partially_paid');
  });

  test('produto vendido não é apagado, só desativado', async () => {
    const produto = await criarProduto({ name: 'Histórico', price: 60, stockQuantity: 3 });
    const appointmentId = await novoAtendimento('Guarda Histórico');
    await empresa.api.post(`/appointments/${appointmentId}/products`, { productId: produto.id, quantity: 1 });

    const r = await empresa.api.del(`/products/${produto.id}`);
    assert.equal(r.data.softDeleted, true);

    const ainda = await buscarProduto(produto.id);
    assert.equal(ainda.active, false);
  });

  test('agendamento cancelado não aceita venda', async () => {
    const produto = await criarProduto({ name: 'Tarde demais', price: 40, stockQuantity: 3 });
    const appointmentId = await novoAtendimento('Cancelado');
    await empresa.api.patch(`/appointments/${appointmentId}`, { status: 'cancelled' });

    const r = await empresa.api.post(`/appointments/${appointmentId}/products`, {
      productId: produto.id, quantity: 1,
    });
    assert.equal(r.status, 400);
  });
});

describe('estoque', () => {
  test('entrada soma e registra a nota', async () => {
    const produto = await criarProduto({ name: 'Entrada', price: 70, stockQuantity: 2 });
    const r = await empresa.api.post(`/products/${produto.id}/stock`, {
      quantity: 12, reason: 'restock', notes: 'NF 8842',
    });

    assert.equal(r.status, 201);
    assert.equal(r.data.product.stockQuantity, 14);

    const detalhe = await empresa.api.get(`/products/${produto.id}`);
    assert.ok(detalhe.data.movements.some((m: any) => m.notes === 'NF 8842'));
  });

  test('perda subtrai', async () => {
    const produto = await criarProduto({ name: 'Quebrou', price: 70, stockQuantity: 10 });
    await empresa.api.post(`/products/${produto.id}/stock`, { quantity: -3, reason: 'loss' });
    assert.equal((await buscarProduto(produto.id)).stockQuantity, 7);
  });

  test('contagem ajusta para o número contado', async () => {
    const produto = await criarProduto({ name: 'Contagem', price: 70, stockQuantity: 10 });
    // a tela manda a diferença: contou 6, tinha 10
    await empresa.api.post(`/products/${produto.id}/stock`, { quantity: -4, reason: 'adjustment' });
    assert.equal((await buscarProduto(produto.id)).stockQuantity, 6);
  });

  test('movimento zero é recusado', async () => {
    const produto = await criarProduto({ name: 'Zero', price: 70, stockQuantity: 1 });
    const r = await empresa.api.post(`/products/${produto.id}/stock`, { quantity: 0 });
    assert.equal(r.status, 400);
  });

  test('a venda também entra no histórico', async () => {
    const produto = await criarProduto({ name: 'Rastro', price: 70, stockQuantity: 5 });
    const appointmentId = await novoAtendimento('Rastro');
    await empresa.api.post(`/appointments/${appointmentId}/products`, { productId: produto.id, quantity: 1 });

    const detalhe = await empresa.api.get(`/products/${produto.id}`);
    const venda = detalhe.data.movements.find((m: any) => m.reason === 'sale');
    assert.ok(venda, 'a venda precisa deixar rastro');
    assert.equal(venda.quantity, -1);
    assert.equal(venda.clientName, 'Rastro', 'dá para saber para quem foi');
  });
});
