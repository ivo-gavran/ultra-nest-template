CREATE TABLE "auth_refresh_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"family_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"claims" jsonb
);
--> statement-breakpoint
CREATE TABLE "auth_revoked_families" (
	"family_id" text PRIMARY KEY NOT NULL,
	"revoked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_token_families" (
	"family_id" text PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"family_expires_at" timestamp with time zone NOT NULL,
	"claims" jsonb,
	CONSTRAINT "auth_token_families_session_id_unique" UNIQUE("session_id"),
	CONSTRAINT "auth_family_owner_unique" UNIQUE("family_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "auth_refresh_tokens" ADD CONSTRAINT "auth_refresh_tokens_family_id_user_id_auth_token_families_family_id_user_id_fk" FOREIGN KEY ("family_id","user_id") REFERENCES "public"."auth_token_families"("family_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_token_families" ADD CONSTRAINT "auth_token_families_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_refresh_family_idx" ON "auth_refresh_tokens" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "auth_families_user_idx" ON "auth_token_families" USING btree ("user_id");