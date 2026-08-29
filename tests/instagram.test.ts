/**
 * O campo de Instagram é texto livre digitado pelo dono do estúdio em
 * Configurações — uns colam a URL do navegador, outros digitam `@perfil`,
 * outros só o nome. Se a normalização errar, o link do rodapé da página
 * pública quebra para todo mundo que visita, e ninguém do lado de dentro vê.
 */
import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { perfilInstagram } from '@/lib/format';

const url = (v: string | null) => perfilInstagram(v)?.url ?? null;
const handle = (v: string | null) => perfilInstagram(v)?.handle ?? null;

describe('cada jeito de digitar chega no mesmo lugar', () => {
  const esperado = 'https://instagram.com/dudamachado.studio';

  test('só o nome', () => {
    assert.equal(url('dudamachado.studio'), esperado);
  });

  test('com arroba', () => {
    assert.equal(url('@dudamachado.studio'), esperado);
  });

  test('URL colada do navegador', () => {
    assert.equal(url('https://instagram.com/dudamachado.studio'), esperado);
    assert.equal(url('https://www.instagram.com/dudamachado.studio'), esperado);
    assert.equal(url('http://instagram.com/dudamachado.studio'), esperado);
  });

  test('URL com barra no fim ou parâmetros de rastreio', () => {
    assert.equal(url('https://www.instagram.com/dudamachado.studio/'), esperado);
    assert.equal(url('https://www.instagram.com/dudamachado.studio?igshid=abc123'), esperado);
    assert.equal(url('https://www.instagram.com/dudamachado.studio/?hl=pt-br'), esperado);
  });

  test('espaço sobrando dos dois lados', () => {
    assert.equal(url('  @dudamachado.studio  '), esperado);
  });

  test('o rótulo mostrado sempre tem uma arroba, nunca duas', () => {
    for (const entrada of [
      'dudamachado.studio',
      '@dudamachado.studio',
      'https://www.instagram.com/dudamachado.studio/',
    ]) {
      assert.equal(handle(entrada), '@dudamachado.studio', entrada);
    }
  });
});

describe('sem Instagram, sem ícone', () => {
  test('vazio, nulo ou só espaço não vira link', () => {
    // o rodapé esconde o ícone nesses casos em vez de apontar para
    // instagram.com/ — que abriria a home do Instagram, não o perfil
    for (const entrada of [null, '', '   ', '@', 'https://instagram.com/', '@   ']) {
      assert.equal(perfilInstagram(entrada), null, JSON.stringify(entrada));
    }
  });
});
