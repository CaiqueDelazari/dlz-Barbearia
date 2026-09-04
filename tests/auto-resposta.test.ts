import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

/**
 * A auto-resposta de boas-vindas é a única mensagem que sai sem agendamento,
 * sem cliente e sem horário: quem dispara é o bot, no instante em que alguém
 * manda mensagem, e o único contexto que existe ali é a loja.
 *
 * Os dois defeitos que estes testes travam já aconteceram, e nenhum dos dois
 * dava erro visível — o primeiro quebrou a tela inteira em silêncio, o segundo
 * chegaria ao cliente.
 *
 * O env é preparado ANTES do import porque `lib/env` lê `process.env` uma vez,
 * na carga do módulo.
 */
describe('mensagem de boas-vindas do WhatsApp', () => {
  let DEFAULT_TEMPLATES: Record<string, string>;
  let TEMPLATE_KEYS: string[];
  let WELCOME_VARS: readonly string[];
  let variaveisDoTexto: (body: string) => string[];
  let render: (body: string, vars: Record<string, string | number>) => string;

  before(async () => {
    process.env.APP_URL = 'https://exemplo.com.br';
    const mod = await import('../src/server/services/notification.service');
    DEFAULT_TEMPLATES = mod.DEFAULT_TEMPLATES;
    TEMPLATE_KEYS = mod.TEMPLATE_KEYS;
    WELCOME_VARS = mod.WELCOME_VARS;
    variaveisDoTexto = mod.variaveisDoTexto;
    render = mod.render;
  });

  /**
   * O defeito: a rota tinha a lista de chaves escrita à mão, com os seis
   * templates originais. Quando os avisos do dono entraram, o GET passou a
   * devolver nove e a tela manda os nove de volta num PATCH só — o zod recusava
   * o array inteiro por causa de três chaves, e a tela de Notificações parou de
   * salvar QUALQUER coisa, inclusive os seis que continuavam válidos.
   */
  it('toda chave que a tela mostra é uma chave que o servidor aceita', () => {
    for (const key of Object.keys(DEFAULT_TEMPLATES)) {
      assert.ok(
        TEMPLATE_KEYS.includes(key),
        `${key} aparece na tela mas o PATCH recusaria — e recusa o array inteiro junto`
      );
    }
    assert.equal(TEMPLATE_KEYS.length, Object.keys(DEFAULT_TEMPLATES).length);
  });

  it('a boas-vindas existe e é uma chave como as outras', () => {
    assert.ok(DEFAULT_TEMPLATES.welcome);
    assert.ok(TEMPLATE_KEYS.includes('welcome'));
  });

  /**
   * O defeito: `render` deixa intacta a variável que não conhece — é o
   * comportamento certo para o resto do sistema, mas aqui significa que um
   * `{cliente}` escrito no texto chegaria ao cliente com as chaves na tela.
   * Por isso o texto padrão não pode ter nada além do que a loja consegue
   * preencher, e o salvamento recusa o resto.
   */
  it('o texto padrão só usa o que existe na hora do disparo', () => {
    const usadas = variaveisDoTexto(DEFAULT_TEMPLATES.welcome);
    for (const v of usadas) {
      assert.ok(WELCOME_VARS.includes(v), `{${v}} não existe quando a auto-resposta sai`);
    }
    // e usa as duas: mensagem sem link não serve para agendar nada
    assert.deepEqual(usadas.sort(), [...WELCOME_VARS].sort());
  });

  it('variável desconhecida chegaria crua ao cliente — é o que a recusa evita', () => {
    const texto = 'Bem-vindo à {empresa}, {cliente}!';
    const saida = render(texto, { empresa: 'Riady Cortes' });
    assert.equal(saida, 'Bem-vindo à Riady Cortes, {cliente}!');
    assert.ok(saida.includes('{cliente}'));

    const invalidas = variaveisDoTexto(texto).filter((v) => !WELCOME_VARS.includes(v));
    assert.deepEqual(invalidas, ['cliente']);
  });

  it('conta cada variável uma vez só, mesmo repetida', () => {
    assert.deepEqual(variaveisDoTexto('{empresa} e {empresa} de novo'), ['empresa']);
    assert.deepEqual(variaveisDoTexto('sem variavel nenhuma'), []);
  });

  it('preenchido, o texto vira mensagem sem chave sobrando', () => {
    const saida = render(DEFAULT_TEMPLATES.welcome, {
      empresa: 'Riady Cortes',
      link_agendamento: 'https://exemplo.com.br/agendar/riady',
    });
    assert.ok(saida.includes('Riady Cortes'));
    assert.ok(saida.includes('https://exemplo.com.br/agendar/riady'));
    assert.equal(variaveisDoTexto(saida).length, 0);
  });
});
