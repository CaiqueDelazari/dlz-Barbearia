import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { assertDentroDoEscopo, filtroDeProfissional } from '../src/server/services/escopo.service';

const NINGUEM = '00000000-0000-0000-0000-000000000000';
const EU = '11111111-1111-1111-1111-111111111111';
const COLEGA = '22222222-2222-2222-2222-222222222222';

/**
 * Um salao tem varios barbeiros com login proprio, e cada um deve ver so a
 * propria agenda -- a do colega traz nome, telefone e valores de cliente que
 * nao e' dele.
 */
describe('escopo de agenda por profissional', () => {
  it('dono e admin continuam vendo o salao inteiro', () => {
    assert.equal(filtroDeProfissional(null, undefined), undefined);
    assert.equal(filtroDeProfissional(null, COLEGA), COLEGA);
  });

  it('barbeiro ve a propria agenda', () => {
    assert.equal(filtroDeProfissional(EU, undefined), EU);
  });

  it('pedir a agenda do colega nao funciona', () => {
    // O ataque e' trivial: trocar o professionalId na URL. O escopo tem que
    // ganhar do que veio da tela, sempre.
    assert.equal(filtroDeProfissional(EU, COLEGA), EU);
  });

  it('barbeiro sem cadastro vinculado nao ve nada, em vez de ver tudo', () => {
    // O erro classico aqui e' devolver "sem filtro" para quem nao tem vinculo,
    // que abriria o salao inteiro justamente para o caso mal configurado.
    assert.equal(filtroDeProfissional('', undefined), NINGUEM);
    assert.equal(filtroDeProfissional('', COLEGA), NINGUEM);
  });
});

/**
 * O filtro acima protege a LISTAGEM. Quem chega com o id na mao passa por
 * fora dela -- e era assim que o painel entregava o atendimento do colega.
 */
describe('escopo em recurso aberto pelo id', () => {
  it('dono e admin abrem qualquer atendimento da casa', () => {
    assert.doesNotThrow(() => assertDentroDoEscopo(null, COLEGA));
    assert.doesNotThrow(() => assertDentroDoEscopo(null, null));
  });

  it('barbeiro abre o proprio', () => {
    assert.doesNotThrow(() => assertDentroDoEscopo(EU, EU));
  });

  it('o do colega responde 404, e nao 403', () => {
    // 403 confirmaria que o id existe; 404 nao conta nem isso.
    assert.throws(() => assertDentroDoEscopo(EU, COLEGA), { status: 404 });
  });

  it('atendimento sem profissional tambem nao e de ninguem com escopo', () => {
    assert.throws(() => assertDentroDoEscopo(EU, null), { status: 404 });
  });

  it('barbeiro sem vinculo nao abre nada', () => {
    assert.throws(() => assertDentroDoEscopo('', EU), { status: 404 });
  });
});
