-- Adds the CSV-supplied brand column to purchase_import_rows, so a receipt's own "brand" column
-- (e.g. "Goya") survives from upload through preview and matching, instead of being silently
-- dropped and only ever inferred from prior purchase history.
--
-- Safe to run more than once (add column if not exists). Purely additive: no column dropped, no
-- existing row changed -- every existing row reads as raw_brand = null until re-imported.
--
-- brand_name (added earlier, in supabase-add-purchase-import-packages.sql) is unaffected: it
-- remains the single editable/effective brand field that flows into supply_entries on confirm.
-- raw_brand is only the immutable "as imported from the CSV" value, mirroring raw_category and
-- raw_supplier.

alter table purchase_import_rows add column if not exists raw_brand text;
