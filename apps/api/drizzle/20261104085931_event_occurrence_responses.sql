CREATE TABLE "event_occurrence_responses" (
	"event_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"recurrence_id" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"comment" text,
	"responded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_occurrence_responses_event_id_user_id_recurrence_id_pk" PRIMARY KEY("event_id","user_id","recurrence_id")
);
--> statement-breakpoint
ALTER TABLE "event_occurrence_responses" ADD CONSTRAINT "event_occurrence_responses_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_occurrence_responses" ADD CONSTRAINT "event_occurrence_responses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;