import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { filtroDeProfissional } from '../src/server/services/escopo.service';

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
