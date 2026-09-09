import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { normalizePhone, toWhatsappNumber } from '../src/server/repositories/client.repo';

/**
 * O numero sai daqui direto para o gateway. Errar aqui nao da erro em lugar
 * nenhum: a mensagem simplesmente nao chega, e o painel continua mostrando
 * tudo certo.
 */
describe('numero para o WhatsApp', () => {
  it('celular comum ganha o codigo do pais', () => {
    assert.equal(toWhatsappNumber('14991273691'), '5514991273691');
    assert.equal(toWhatsappNumber('(14) 99127-3691'), '5514991273691');
  });

  it('fixo de 10 digitos tambem', () => {
    assert.equal(toWhatsappNumber('1432223333'), '551432223333');
  });

  it('DDD 55 nao e codigo de pais', () => {
    // Santa Maria e Uruguaiana. Pelo prefixo, o 55 do DDD era confundido com o
    // do pais e a mensagem saia com 11 digitos -- numero que nao existe.
    assert.equal(toWhatsappNumber('55991234567'), '5555991234567');
  });

  it('numero que ja veio com o pais nao ganha outro', () => {
    assert.equal(toWhatsappNumber('5514991273691'), '5514991273691');
    assert.equal(toWhatsappNumber('+55 14 99127-3691'), '5514991273691');
  });

  it('o cadastro guarda sempre sem o pais', () => {
    assert.equal(normalizePhone('+55 (14) 99127-3691'), '14991273691');
    assert.equal(normalizePhone('14991273691'), '14991273691');
    // ida e volta: o que foi guardado volta inteiro para o gateway
    assert.equal(toWhatsappNumber(normalizePhone('55 14 991273691')), '5514991273691');
  });
});
