'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';

/**
 * Rodapé de lista longa. Existe porque o pior jeito de errar é cortar em
 * silêncio: sem isto, a página mostrava as primeiras N linhas e nada dizia que
 * havia mais. Aqui o número total fica sempre à vista, mesmo na primeira página.
 */
export function Pagination({
  page,
  pageSize,
  total,
  onChange,
  labelSingular = 'registro',
  labelPlural = 'registros',
}: {
  /** Base 0. */
  page: number;
  pageSize: number;
  total: number;
  onChange: (page: number) => void;
  labelSingular?: string;
  labelPlural?: string;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const primeiro = total === 0 ? 0 : page * pageSize + 1;
  const ultimo = Math.min(total, (page + 1) * pageSize);
  const rotulo = total === 1 ? labelSingular : labelPlural;

  if (total <= pageSize) {
    return (
      <p className="tnum pt-1 text-xs text-ink-500">
        {total} {rotulo}
      </p>
    );
  }

  return (
    <div className="flex items-center justify-between gap-3 pt-1">
      <p className="tnum text-xs text-ink-500">
        {primeiro}–{ultimo} de {total} {rotulo}
      </p>
      <div className="flex items-center gap-1">
        <button
          type="button"
          disabled={page === 0}
          onClick={() => onChange(page - 1)}
          className="rounded-lg border border-ink-800 p-2 text-ink-300 transition-colors hover:border-ink-700 hover:text-ink-100 disabled:cursor-not-allowed disabled:opacity-30"
          aria-label="Página anterior"
        >
          <ChevronLeft size={15} strokeWidth={1.5} />
        </button>
        <span className="tnum px-2 text-xs text-ink-400">
          {page + 1} / {pages}
        </span>
        <button
          type="button"
          disabled={page + 1 >= pages}
          onClick={() => onChange(page + 1)}
          className="rounded-lg border border-ink-800 p-2 text-ink-300 transition-colors hover:border-ink-700 hover:text-ink-100 disabled:cursor-not-allowed disabled:opacity-30"
          aria-label="Próxima página"
        >
          <ChevronRight size={15} strokeWidth={1.5} />
        </button>
      </div>
    </div>
  );
}
