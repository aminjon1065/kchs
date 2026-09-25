ALTER TABLE "documents" ADD COLUMN "reg_case_id" uuid;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_reg_case_id_cases_id_fk" FOREIGN KEY ("reg_case_id") REFERENCES "public"."cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Ручной хвост (ADR-0134): стартовые журналы с прежним форматом по умолчанию получают номер
-- «подразделение-дело/номер»; формат, который администратор уже поменял, не трогается
UPDATE "journals" SET "format" = '{case.index}/{seq}'
 WHERE "format" = '{prefix}-{seq:04}/{yy}'
   AND ("name", "prefix") IN (('Входящие', 'ВХ'), ('Исходящие', 'ИСХ'), ('Внутренние', 'ВН'),
                              ('Договоры', 'ДГ'), ('Обращения граждан', 'ОГ'));
