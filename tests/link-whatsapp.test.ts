/**
 * O telefone da loja é digitado à mão em Configurações, e cada dono digita de
 * um jeito. O `wa.me` só entende dígitos com o código do país na frente: errar
 * a normalização não quebra a página — abre uma conversa com o número errado,
 * ou com ninguém, e quem descobre é o cliente que queria comprar a pomada.
 */
import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { linkWhatsapp } from '@/lib/format';

describe('cada jeito de digitar o telefone chega no mesmo numero', () => {
  const esperado = 'https://wa.me/5511912345678';

  test('formatado como o painel mostra', () => {
    assert.equal(linkWhatsapp('(11) 91234-5678'), esperado);
  });

  test('só os dígitos', () => {
    assert.equal(linkWhatsapp('11912345678'), esperado);
  });

  test('já com o código do país', () => {
    assert.equal(linkWhatsapp('55 11 91234-5678'), esperado);
    assert.equal(linkWhatsapp('+55 (11) 91234-5678'), esperado);
  });

  test('fixo de oito dígitos também vale', () => {
    assert.equal(linkWhatsapp('(11) 3456-7890'), 'https://wa.me/551134567890');
  });
});

describe('sem numero, sem link', () => {
  test('vazio, nulo ou pela metade não viram link', () => {
    assert.equal(linkWhatsapp(null), null);
    assert.equal(linkWhatsapp(''), null);
    assert.equal(linkWhatsapp('   '), null);
    // menos de dez dígitos é engano de digitação, não telefone
    assert.equal(linkWhatsapp('91234-567'), null);
  });
});

describe('a mensagem vai pronta', () => {
  test('o texto entra escapado, sem quebrar a URL', () => {
    const link = linkWhatsapp('11912345678', 'Oi! Ainda tem a Pomada Uva (R$ 25)?');
    assert.equal(
      link,
      'https://wa.me/5511912345678?text=Oi!%20Ainda%20tem%20a%20Pomada%20Uva%20(R%24%2025)%3F'
    );
  });

  test('sem mensagem, sem `?text=` sobrando', () => {
    assert.equal(linkWhatsapp('11912345678'), 'https://wa.me/5511912345678');
  });
});
