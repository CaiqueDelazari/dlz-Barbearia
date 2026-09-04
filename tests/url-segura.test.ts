/**
 * A trava de URL remota é a única coisa entre "colar o endereço do logo" e
 * transformar o servidor num proxy para a rede interna. Merece teste próprio,
 * sem banco e sem servidor: é uma função pura e precisa continuar sendo.
 */
import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { isSafeRemoteUrl, imageUrlSchema } from '@/lib/security';

describe('endereços que o servidor não pode buscar', () => {
  test('metadados da nuvem — o caminho clássico para vazar credencial', () => {
    assert.equal(isSafeRemoteUrl('https://169.254.169.254/latest/meta-data/'), false);
    assert.equal(isSafeRemoteUrl('https://metadata.google.internal/computeMetadata/v1/'), false);
  });

  test('loopback e faixas privadas', () => {
    for (const url of [
      'https://localhost/logo.png',
      'https://127.0.0.1/logo.png',
      'https://10.1.2.3/logo.png',
      'https://192.168.0.10/logo.png',
      'https://172.16.0.1/logo.png',
      'https://172.31.255.255/logo.png',
      'https://[::1]/logo.png',
      'https://0.0.0.0/logo.png',
      'https://banco.internal/logo.png',
      'https://impressora.local/logo.png',
    ]) {
      assert.equal(isSafeRemoteUrl(url), false, url);
    }
  });

  test('172.32 já está fora da faixa privada e é aceito', () => {
    // a faixa é 172.16–172.31; barrar 172.32 seria bloquear internet legítima
    assert.equal(isSafeRemoteUrl('https://172.32.0.1/logo.png'), true);
    assert.equal(isSafeRemoteUrl('https://172.15.0.1/logo.png'), true);
  });

  test('só https — http aceita interceptação no meio do caminho', () => {
    assert.equal(isSafeRemoteUrl('http://exemplo.com/logo.png'), false);
    assert.equal(isSafeRemoteUrl('https://exemplo.com/logo.png'), true);
  });

  test('esquema exótico não passa', () => {
    for (const url of [
      'file:///etc/passwd',
      'ftp://exemplo.com/logo.png',
      'javascript:alert(1)',
      'data:image/png;base64,AAAA',
    ]) {
      assert.equal(isSafeRemoteUrl(url), false, url);
    }
  });

  test('usuário e senha embutidos escondem o destino real', () => {
    assert.equal(isSafeRemoteUrl('https://usuario:senha@exemplo.com/logo.png'), false);
  });

  test('texto que não é URL', () => {
    assert.equal(isSafeRemoteUrl(''), false);
    assert.equal(isSafeRemoteUrl('logo.png'), false);
    assert.equal(isSafeRemoteUrl('não é url'), false);
  });
});

describe('endereços legítimos continuam passando', () => {
  test('imagem pública comum', () => {
    for (const url of [
      'https://exemplo.com/logo.png',
      'https://cdn.exemplo.com.br/fotos/profissional.jpg?v=2',
      'https://images.unsplash.com/photo-123',
    ]) {
      assert.equal(isSafeRemoteUrl(url), true, url);
    }
  });
});

/**
 * O campo de imagem passou a aceitar duas formas, e a segunda nasceu de uma
 * necessidade real: a logo e a foto do primeiro cliente entraram no `public/`
 * porque a tela de upload ainda não existe. Um caminho local não é endereço de
 * rede — mas só continua não sendo enquanto estas recusas valerem.
 */
describe('caminho de imagem do próprio site', () => {
  const aceita = (v: string) => imageUrlSchema.safeParse(v).success;

  test('arquivo do public/ é aceito', () => {
    for (const caminho of [
      '/riady/riady.jpg',
      '/riady/logo.png',
      '/marcas/loja-2.webp',
      '/foto.JPEG',
    ]) {
      assert.equal(aceita(caminho), true, caminho);
    }
  });

  test('sem esquema, "//host" é URL disfarçada de caminho', () => {
    // buscaria em outro host — é o buraco que a trava remota fecha
    assert.equal(aceita('//169.254.169.254/logo.png'), false);
    assert.equal(aceita('//exemplo.com/logo.png'), false);
  });

  test('não escapa do public/', () => {
    assert.equal(aceita('/../../etc/senha.png'), false);
    assert.equal(aceita('/riady/../../.env.png'), false);
  });

  test('rota da API não é arquivo, nem terminando em .jpg', () => {
    assert.equal(aceita('/api/v1/appointments'), false);
    assert.equal(aceita('/api/v1/clients.jpg'), false);
  });

  test('sem extensão de imagem não passa', () => {
    for (const caminho of ['/admin', '/riady/riady', '/algo.svg', '/algo.html']) {
      assert.equal(aceita(caminho), false, caminho);
    }
  });

  test('a URL https continua valendo', () => {
    assert.equal(aceita('https://exemplo.com/logo.png'), true);
    assert.equal(aceita('https://127.0.0.1/logo.png'), false);
  });
});
