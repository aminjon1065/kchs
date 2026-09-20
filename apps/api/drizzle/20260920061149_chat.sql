CREATE TABLE "chat_conversations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"direct_key" text,
	"system_key" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_conversations_direct_key_unique" UNIQUE("direct_key"),
	CONSTRAINT "chat_conversations_system_key_unique" UNIQUE("system_key")
);
--> statement-breakpoint
CREATE TABLE "chat_drafts" (
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"thread_root_id" bigint DEFAULT 0 NOT NULL,
	"body" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_drafts_conversation_id_user_id_thread_root_id_pk" PRIMARY KEY("conversation_id","user_id","thread_root_id")
);
--> statement-breakpoint
CREATE TABLE "chat_pins" (
	"conversation_id" uuid NOT NULL,
	"message_id" bigint NOT NULL,
	"pinned_by" uuid,
	"pinned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_pins_conversation_id_message_id_pk" PRIMARY KEY("conversation_id","message_id")
);
--> statement-breakpoint
CREATE TABLE "user_presence" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'online' NOT NULL,
	"status_until" timestamp with time zone,
	"quiet_hours" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"in_meeting" boolean DEFAULT false NOT NULL,
	"last_seen_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_id_conversations_id_fk" FOREIGN KEY ("id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_drafts" ADD CONSTRAINT "chat_drafts_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_drafts" ADD CONSTRAINT "chat_drafts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_pins" ADD CONSTRAINT "chat_pins_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_pins" ADD CONSTRAINT "chat_pins_pinned_by_users_id_fk" FOREIGN KEY ("pinned_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_presence" ADD CONSTRAINT "user_presence_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_conversations_system_idx" ON "chat_conversations" USING btree ("system_key");--> statement-breakpoint
CREATE INDEX "chat_drafts_user_idx" ON "chat_drafts" USING btree ("user_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "chat_pins_conversation_idx" ON "chat_pins" USING btree ("conversation_id","pinned_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "user_presence_seen_idx" ON "user_presence" USING btree ("last_seen_at" DESC NULLS LAST);