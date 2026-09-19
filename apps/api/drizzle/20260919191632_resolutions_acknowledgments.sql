CREATE TABLE "resolution_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"requested_by" uuid,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_date" date,
	"note" text,
	"state" text DEFAULT 'open' NOT NULL,
	"closed_at" timestamp with time zone,
	"comment" text
);
--> statement-breakpoint
CREATE TABLE "resolution_templates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid,
	"text" text NOT NULL,
	"due_working_days" integer,
	"control" boolean DEFAULT true NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resolutions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"parent_id" uuid,
	"author_id" uuid NOT NULL,
	"entered_by" uuid,
	"text" text NOT NULL,
	"responsible_id" uuid NOT NULL,
	"co_executors" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"deadline" date NOT NULL,
	"due_working_days" integer,
	"control" boolean DEFAULT true NOT NULL,
	"controller_id" uuid,
	"instruction_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "acknowledgment_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"object_id" uuid NOT NULL,
	"source" text NOT NULL,
	"process_step_id" uuid,
	"requested_by" uuid,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_at" timestamp with time zone,
	"require_second_factor" boolean DEFAULT false NOT NULL,
	"note" text,
	"cancelled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "acknowledgments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"request_id" uuid NOT NULL,
	"object_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"source" text NOT NULL,
	"required_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"actor_id" uuid,
	"second_factor" boolean DEFAULT false NOT NULL,
	"cancelled_at" timestamp with time zone,
	"reminded_at" timestamp with time zone,
	"reminders" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "resolution_requests" ADD CONSTRAINT "resolution_requests_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resolution_requests" ADD CONSTRAINT "resolution_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resolution_requests" ADD CONSTRAINT "resolution_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resolution_templates" ADD CONSTRAINT "resolution_templates_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resolutions" ADD CONSTRAINT "resolutions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resolutions" ADD CONSTRAINT "resolutions_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resolutions" ADD CONSTRAINT "resolutions_entered_by_users_id_fk" FOREIGN KEY ("entered_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resolutions" ADD CONSTRAINT "resolutions_responsible_id_users_id_fk" FOREIGN KEY ("responsible_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resolutions" ADD CONSTRAINT "resolutions_controller_id_users_id_fk" FOREIGN KEY ("controller_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acknowledgment_requests" ADD CONSTRAINT "acknowledgment_requests_object_id_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acknowledgment_requests" ADD CONSTRAINT "acknowledgment_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acknowledgments" ADD CONSTRAINT "acknowledgments_request_id_acknowledgment_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."acknowledgment_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acknowledgments" ADD CONSTRAINT "acknowledgments_object_id_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acknowledgments" ADD CONSTRAINT "acknowledgments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acknowledgments" ADD CONSTRAINT "acknowledgments_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "resolution_requests_document_idx" ON "resolution_requests" USING btree ("document_id","requested_at");--> statement-breakpoint
CREATE UNIQUE INDEX "resolution_requests_open_uq" ON "resolution_requests" USING btree ("document_id","user_id") WHERE "resolution_requests"."state" = 'open';--> statement-breakpoint
CREATE INDEX "resolution_templates_owner_idx" ON "resolution_templates" USING btree ("owner_id","sort");--> statement-breakpoint
CREATE INDEX "resolutions_document_idx" ON "resolutions" USING btree ("document_id","created_at");--> statement-breakpoint
CREATE INDEX "resolutions_parent_idx" ON "resolutions" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "acknowledgment_requests_object_idx" ON "acknowledgment_requests" USING btree ("object_id","requested_at");--> statement-breakpoint
CREATE UNIQUE INDEX "acknowledgment_requests_step_uq" ON "acknowledgment_requests" USING btree ("process_step_id") WHERE "acknowledgment_requests"."process_step_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "acknowledgments_request_user_uq" ON "acknowledgments" USING btree ("request_id","user_id");--> statement-breakpoint
CREATE INDEX "acknowledgments_object_user_idx" ON "acknowledgments" USING btree ("object_id","user_id");--> statement-breakpoint
CREATE INDEX "acknowledgments_pending_idx" ON "acknowledgments" USING btree ("user_id","due_at") WHERE "acknowledgments"."acknowledged_at" is null and "acknowledgments"."cancelled_at" is null;--> statement-breakpoint
-- Правила стартовых типов (ADR-0084): входящие — на резолюцию руководителю подразделения,
-- приказы и распоряжения — ознакомление за 3 рабочих дня; уже заданные правила не трогаем
UPDATE "document_types" SET "settings" = "settings" || '{"resolutionBy": "unit_head"}'::jsonb
 WHERE "key" IN ('incoming_letter', 'appeal', 'situation_report') AND NOT ("settings" ? 'resolutionBy');--> statement-breakpoint
UPDATE "document_types" SET "settings" = "settings" || '{"ackDueWorkingDays": 3}'::jsonb
 WHERE "key" IN ('order', 'directive') AND NOT ("settings" ? 'ackDueWorkingDays');--> statement-breakpoint
-- Стартовые общие шаблоны резолюций (08-documents.md §6): редактирует канцелярия
INSERT INTO "resolution_templates" ("id", "owner_id", "text", "due_working_days", "control", "sort")
SELECT gen_random_uuid(), NULL, t.text, t.days, t.control, t.sort
  FROM (VALUES
    ('Прошу рассмотреть и доложить', 5, true, 1),
    ('К исполнению', 10, true, 2),
    ('Прошу подготовить ответ', 5, true, 3),
    ('Прошу рассмотреть и подготовить предложения', 10, true, 4),
    ('Для сведения и использования в работе', NULL, false, 5)
  ) AS t(text, days, control, sort)
 WHERE NOT EXISTS (SELECT 1 FROM "resolution_templates" WHERE "owner_id" IS NULL);
