-- ============================================================================
-- 006_function_search_path.sql  |  Fecha o search_path da funcao de trigger
-- ============================================================================
--
-- O linter de seguranca do Supabase apontou `set_updated_at` com search_path
-- mutavel. Uma funcao sem search_path fixo resolve os nomes que usa pelo
-- caminho de quem a chama -- entao quem conseguisse criar um objeto num schema
-- que venha antes no caminho passaria a decidir o que a funcao executa.
--
-- Aqui o corpo so chama `now()`, entao o risco pratico e' pequeno; a correcao e'
-- de uma linha e vale como higiene, ja que a funcao dispara em quase toda
-- tabela do sistema.
--
-- `pg_catalog` primeiro porque e' de onde `now()` tem que vir.

ALTER FUNCTION set_updated_at() SET search_path = pg_catalog;
