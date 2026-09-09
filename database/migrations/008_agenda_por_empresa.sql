-- ---------------------------------------------------------------------------
-- A trava de horario passa a ser POR EMPRESA.
--
-- `excl_appt_overlap` nasceu casando so por `professional_id`. Numa base de um
-- cliente so isso e' equivalente a casar por empresa, porque o profissional
-- pertence a uma; num SaaS, nao e': o id de um barbeiro e' publico (a pagina de
-- agendamento lista os profissionais) e a FK aponta para `professionals(id)`
-- sem o tenant. Uma reserva criada na empresa A com o `professional_id` de um
-- barbeiro da empresa B era aceita pelo banco -- e passava a ocupar a faixa de
-- horario DELE. A empresa B via a agenda vazia no painel e os clientes
-- recebendo "este horario acabou de ser reservado".
--
-- A aplicacao ja recusa o id de fora (`assertProfissionalDaEmpresa`). Esta
-- migration fecha a mesma porta no banco, que e' onde a garantia tem que valer
-- mesmo quando alguem escrever um caminho novo e esquecer da checagem.
--
-- Dentro de uma empresa nada muda: mesmo profissional, mesma faixa, mesmo
-- conflito. O que deixa de existir e' o conflito ENTRE empresas.
-- ---------------------------------------------------------------------------
DO $blk$
BEGIN
  CREATE EXTENSION IF NOT EXISTS btree_gist;

  ALTER TABLE appointments DROP CONSTRAINT IF EXISTS excl_appt_overlap;

  BEGIN
    ALTER TABLE appointments ADD CONSTRAINT excl_appt_overlap
      EXCLUDE USING gist (
        tenant_id WITH =,
        professional_id WITH =,
        tstzrange(starts_at, ends_at) WITH &&
      ) WHERE (status IN ('pending','confirmed','completed') AND professional_id IS NOT NULL);
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'btree_gist indisponivel: double booking segue protegido pelo lock da aplicacao';
END $blk$;
