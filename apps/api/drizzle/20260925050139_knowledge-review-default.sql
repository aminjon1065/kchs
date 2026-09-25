-- 05-risks N35: регламенту и инструкции срок пересмотра ставится сам — год от публикации.
-- Уже опубликованные страницы этих шаблонов без срока получают его от даты публикации
-- (в поясе Комитета); пересмотр, который подошёл, откроет ежедневное задание.
UPDATE "pages"
   SET "review_at" = (("published_at" AT TIME ZONE 'Asia/Dushanbe')::date + interval '1 year')::date,
       "updated_at" = now()
 WHERE "template" IN ('regulation', 'instruction')
   AND "status" = 'published'
   AND "review_at" IS NULL
   AND "published_at" IS NOT NULL;
