CREATE TABLE "mail_mailboxes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"user_id" uuid,
	"address" text NOT NULL,
	"password_hash" text NOT NULL,
	"password_set_at" text,
	"secret_enc" "bytea",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mail_mailboxes" ADD CONSTRAINT "mail_mailboxes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mail_mailboxes_address_uq" ON "mail_mailboxes" USING btree ("address");--> statement-breakpoint
CREATE UNIQUE INDEX "mail_mailboxes_user_uq" ON "mail_mailboxes" USING btree ("user_id");