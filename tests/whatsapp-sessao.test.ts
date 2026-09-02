import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { _safeSessionId as safeSessionId } from '../src/server/services/whatsapp.service';

/**
 * O bot Baileys e' compartilhado com os outros sistemas da casa, e o id da
 * sessao e' a unica coisa que separa um numero de WhatsApp do outro la dentro.
 *
 * `whatsapp_session_id` e' editavel por qualquer ADMIN nas Configuracoes, entao
 * ele e' entrada de usuario -- e nao pode conseguir apontar para a sessao de
 * outra empresa.
 */
describe('id de sessao do WhatsApp fica preso ao namespace', () => {
  it('nao alcanca a sessao de outro sistema da casa', () => {
    // Era o ataque: escrever a sessao da Espetaria nas proprias configuracoes e
    // passar a mandar mensagem saindo do WhatsApp dela.
    assert.equal(safeSessionId('espeto-na-brasa'), 'barb-espeto-na-brasa');
  });

  it('prefixo nao pode ser burlado pelo proprio valor', () => {
    assert.equal(safeSessionId('barb-'), 'barb-barb');
    assert.equal(safeSessionId('../espeto-na-brasa'), 'barb-espeto-na-brasa');
    assert.equal(safeSessionId('/../../espeto'), 'barb-espeto');
  });

  it('some com o que nao e letra, numero ou hifen', () => {
    assert.equal(safeSessionId('Barbearia do Zé!'), 'barb-barbearia-do-ze');
    assert.equal(safeSessionId('a/b?c=d&e'), 'barb-a-b-c-d-e');
  });

  it('valor vazio ou so simbolos nao vira sessao sem nome', () => {
    assert.equal(safeSessionId(''), 'barb-sem-nome');
    assert.equal(safeSessionId('///'), 'barb-sem-nome');
  });

  it('corta valor longo demais', () => {
    const id = safeSessionId('x'.repeat(200));
    assert.equal(id.length, 'barb-'.length + 50);
  });

  it('duas empresas com slugs diferentes nao colidem', () => {
    assert.notEqual(safeSessionId('barbearia-um'), safeSessionId('barbearia-dois'));
  });
});
