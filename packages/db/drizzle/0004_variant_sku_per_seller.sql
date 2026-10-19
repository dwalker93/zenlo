-- SKU uniqueness moves from marketplace-wide to per-seller.
-- seller_id is denormalised onto variants (checked against the product's seller by a composite FK),
-- so existing rows are backfilled before the column becomes NOT NULL.
ALTER TABLE "products" ADD CONSTRAINT "products_id_seller_uq" UNIQUE("id","seller_id");--> statement-breakpoint
ALTER TABLE "product_variants" ADD COLUMN "seller_id" uuid;--> statement-breakpoint
UPDATE "product_variants" v SET "seller_id" = p."seller_id" FROM "products" p WHERE p."id" = v."product_id";--> statement-breakpoint
ALTER TABLE "product_variants" ALTER COLUMN "seller_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "product_variants" DROP CONSTRAINT "product_variants_sku_unique";--> statement-breakpoint
ALTER TABLE "product_variants" DROP CONSTRAINT "product_variants_product_id_products_id_fk";--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "variants_product_seller_fk" FOREIGN KEY ("product_id","seller_id") REFERENCES "public"."products"("id","seller_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "variants_seller_sku_uq" ON "product_variants" USING btree ("seller_id","sku");
