'use client';

import { useEffect } from 'react';

/**
 * Diz ao CSS qual pedaco da tela esta realmente visivel no iPhone.
 *
 * O Safari tem duas janelas: a do documento (que `position: fixed` enxerga) e a
 * visivel, que encolhe quando o teclado sobe e desliza quando a barra de
 * endereco recolhe. Com o teclado aberto as duas deixam de coincidir, e um
 * dialogo `fixed inset-0` continua desenhado ate o fim do documento -- ou seja,
 * o rodape com o botao de salvar fica atras do teclado, e nenhuma rolagem
 * alcanca ele.
 *
 * Aqui as medidas da janela visivel viram tres variaveis CSS: `.sheet-overlay`
 * usa altura e topo para caber nela, e `.dock-bottom` usa o quanto sobrou
 * coberto embaixo para levantar a barra do "Continuar" de tras da barra do
 * Safari. Em navegador sem `visualViewport` (ou com o JS ainda carregando)
 * nada e escrito e o padrao de cada classe reproduz o comportamento antigo,
 * entao isto so adiciona.
 */
export function ViewportFix() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const root = document.documentElement;

    // Variavel de :root re-avalia o estilo da arvore inteira, e `scroll` da
    // janela visivel dispara a cada quadro da rolagem. So escreve o que mudou.
    const escrito: Record<string, string> = {};
    const set = (nome: string, valor: string) => {
      if (escrito[nome] === valor) return;
      escrito[nome] = valor;
      root.style.setProperty(nome, valor);
    };

    const apply = () => {
      set('--vv-height', `${Math.round(vv.height)}px`);
      // `offsetTop` é o quanto a janela visível desceu dentro do documento
      // (acontece quando o iOS dá zoom ou empurra a página com o teclado).
      set('--vv-top', `${Math.round(vv.offsetTop)}px`);

      // Quanto do fim da página está coberto -- pela barra de baixo do Safari
      // ou pelo teclado. É o que uma barra grudada em `bottom: 0` precisa subir
      // para continuar aparecendo, porque `bottom: 0` é o fim da janela do
      // documento, e o documento passa por baixo da barra do navegador.
      // O maior dos dois e a janela do documento: dependendo da versao do
      // Safari um deles encolhe junto com a barra e o outro nao, e quem
      // encolheu ja e a janela visivel -- usar o menor daria zero e a barra
      // continuaria escondida. Se os dois encolherem, da zero e fica como
      // estava: nao piora nada.
      const janela = Math.max(root.clientHeight, window.innerHeight);
      const coberto = janela - (vv.height + vv.offsetTop);
      set('--vv-bottom', `${Math.max(0, Math.round(coberto))}px`);
    };

    apply();
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    return () => {
      vv.removeEventListener('resize', apply);
      vv.removeEventListener('scroll', apply);
      root.style.removeProperty('--vv-height');
      root.style.removeProperty('--vv-top');
      root.style.removeProperty('--vv-bottom');
    };
  }, []);

  return null;
}
