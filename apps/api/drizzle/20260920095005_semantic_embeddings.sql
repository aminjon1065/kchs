CREATE TABLE "embeddings" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"object_id" uuid NOT NULL,
	"chunk_no" integer NOT NULL,
	"text" text NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"model" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"hash" text NOT NULL,
	"indexed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "embeddings" ADD CONSTRAINT "embeddings_object_id_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "embeddings_object_chunk_idx" ON "embeddings" USING btree ("object_id","chunk_no");--> statement-breakpoint
CREATE INDEX "embeddings_object_idx" ON "embeddings" USING btree ("object_id");--> statement-breakpoint
-- Приблизительный поиск ближайших по косинусу (ADR-0099): drizzle-kit
-- индексы pgvector не генерирует, поэтому он дописан вручную
CREATE INDEX "embeddings_vector_idx" ON "embeddings" USING hnsw ("embedding" extensions.vector_cosine_ops);
