-- 1. Ledger sign rules: sale = credit, commission/refund = debit, adjustment either way.
--    (Fails loudly if existing rows already violate them; fix those with adjustment entries first.)
ALTER TABLE "seller_ledger_entries" ADD CONSTRAINT "ledger_amount_sign" CHECK (("seller_ledger_entries"."type" = 'sale' AND "seller_ledger_entries"."amount_cents" > 0)
        OR ("seller_ledger_entries"."type" IN ('commission', 'refund') AND "seller_ledger_entries"."amount_cents" < 0)
        OR "seller_ledger_entries"."type" = 'adjustment');--> statement-breakpoint
-- 2. payout_items must prove the payout and the ledger entry belong to the same seller.
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_id_seller_uq" UNIQUE("id","seller_id");--> statement-breakpoint
ALTER TABLE "seller_ledger_entries" ADD CONSTRAINT "ledger_id_seller_uq" UNIQUE("id","seller_id");--> statement-breakpoint
ALTER TABLE "payout_items" ADD COLUMN "seller_id" uuid;--> statement-breakpoint
UPDATE "payout_items" i SET "seller_id" = p."seller_id" FROM "payouts" p WHERE p."id" = i."payout_id";--> statement-breakpoint
ALTER TABLE "payout_items" ALTER COLUMN "seller_id" SET NOT NULL;--> statement-breakpoint
-- if any existing item points at another seller's entry, this FK fails: that is the bug being fixed
ALTER TABLE "payout_items" ADD CONSTRAINT "payout_items_payout_seller_fk" FOREIGN KEY ("payout_id","seller_id") REFERENCES "public"."payouts"("id","seller_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_items" ADD CONSTRAINT "payout_items_entry_seller_fk" FOREIGN KEY ("ledger_entry_id","seller_id") REFERENCES "public"."seller_ledger_entries"("id","seller_id") ON DELETE no action ON UPDATE no action;
