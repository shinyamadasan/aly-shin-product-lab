import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildAssetUploadCandidate } from "../../../src/lib/asset-upload-intake.ts";

// Disposable PostgreSQL only. This exercises the real migration/policies with the minimum
// Supabase auth/storage schema facsimile; it does not connect to any Supabase project.
const root = path.resolve(import.meta.dirname, "../../..");
const migration = readFileSync(path.join(root, "supabase/migrations/20261013090000_product_media_library_v1.sql"), "utf8");
const claimSql = readFileSync(path.join(root, "supabase-harden-creative-production-rls.sql"), "utf8");
const owner = "11111111-1111-4111-8111-111111111111";
const coowner = "22222222-2222-4222-8222-222222222222";
const mediaId = "33333333-3333-4333-8333-333333333333";

test("media migration: owner isolation, co-owner sharing, private bucket, constrained product changes and persistent fixture rows", { skip: process.env.RUN_POSTGRES_SMOKE !== "1" }, async (t) => {
  const container = `aly-media-v1-${process.pid}`;
  execFileSync("docker", ["run", "-d", "--name", container, "-e", "POSTGRES_PASSWORD=local-test-only", "postgres:16-alpine"], { stdio: "ignore" });
  t.after(() => execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" }));
  const run = (sql: string) => execFileSync("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-tA", "-v", "ON_ERROR_STOP=1", "-f", "-"], { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  for (let attempt = 0; ; attempt++) {
    try { run("select 1"); break; } catch {
      if (attempt === 59) throw new Error("Local test PostgreSQL did not start.");
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  const as = (role: string, user: string, sql: string, dbRole = "authenticated") => `set role ${dbRole}; select set_config('request.jwt.claims', '${JSON.stringify({ sub: user, app_metadata: { app_role: role } })}', false); ${sql}`;
  const rejected = (sql: string) => assert.throws(() => run(sql));
  run(`create role authenticated; create role anon; create schema auth; create schema storage;
    create function auth.jwt() returns jsonb language sql stable as $$ select nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;
    create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
    grant usage on schema auth, storage to authenticated, anon;
    create table public.products (id text primary key);
    insert into products values ('media-test-product'), ('other-product');
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
    alter table storage.objects enable row level security;
    grant select, insert, update, delete on storage.objects to authenticated, anon;
    ${claimSql.match(/create or replace function public.current_app_role\(\)[\s\S]*?\$\$;/)![0]}
    ${claimSql.match(/create or replace function public.is_product_lab_owner\(\)[\s\S]*?\$\$;/)![0]}`);
  run(migration);
  rejected(migration); // Guarded reapplication, no silent schema replacement.
  assert.equal(run("select public || '|' || file_size_limit from storage.buckets where id = 'product-media'"), "false|52428800");
  assert.equal(run("select allowed_mime_types::text from storage.buckets where id = 'product-media'"), "{image/jpeg,image/png,image/webp,video/mp4}");
  const insert = `insert into public.product_media (id, product_id, media_type, storage_path, original_filename, mime_type, file_size_bytes, width, height)
    values ('${mediaId}', 'media-test-product', 'photo', '${mediaId}.png', 'test-pattern.png', 'image/png', 4000, 160, 120);`;
  run(as("owner", owner, insert));
  run(as("owner", owner, `insert into storage.objects (bucket_id, name) values ('product-media', '${mediaId}.png');`));
  assert.match(run(as("owner", coowner, "select count(*) from product_media; select count(*) from storage.objects;")), /1\s+1$/);
  for (const role of ["public_order", "creative_worker", "", "Owner"]) {
    assert.match(run(as(role, coowner, "select count(*) from product_media; select count(*) from storage.objects;")), /0\s+0$/);
    rejected(as(role, coowner, insert.replaceAll(mediaId, "44444444-4444-4444-8444-444444444444")));
    rejected(as(role, coowner, "insert into storage.objects (bucket_id,name) values ('product-media','55555555-5555-4555-8555-555555555555.jpg');"));
  }
  rejected(as("", coowner, "select * from product_media;", "anon"));
  assert.match(run(as("", coowner, "select count(*) from storage.objects;", "anon")), /0$/);
  run(as("owner", coowner, `update product_media set product_id = null where id = '${mediaId}';`));
  assert.match(run(as("owner", owner, `select count(*) from product_media where product_id is null;`)), /1$/);
  run(as("owner", owner, `update product_media set product_id = 'other-product' where id = '${mediaId}';`));
  rejected(as("owner", owner, `update product_media set product_id = 'missing-product' where id = '${mediaId}';`));
  rejected(as("owner", owner, `update product_media set storage_path = 'changed' where id = '${mediaId}';`));
  rejected(as("owner", owner, `delete from product_media where id = '${mediaId}';`));
  run(as("owner", owner, `delete from storage.objects where bucket_id = 'product-media';`)); // No policy: affects zero rows.
  assert.equal(run("select count(*) from storage.objects"), "1");
  rejected(as("owner", owner, `insert into storage.objects (bucket_id,name) values ('product-media','outside/path.jpg');`));
  rejected(as("owner", coowner, insert.replaceAll(mediaId, "66666666-6666-4666-8666-666666666666").replace("width, height)", "width, height, created_by)").replace("160, 120);", `160, 120, '${owner}');`)));
  // Product removal unassigns source media and retains the upload; no cascade data loss.
  run("delete from products where id = 'other-product';");
  assert.equal(run("select count(*) from product_media where product_id is null"), "1");
  const videoInsert = insert.replaceAll(mediaId, "77777777-7777-4777-8777-777777777777").replaceAll("photo", "video").replaceAll(".png", ".mp4").replace("image/png", "video/mp4");
  rejected(as("owner", owner, videoInsert)); // A video with null duration must fail, not pass SQL NULL CHECK semantics.
  run(as("owner", owner, `update product_media set product_id = 'media-test-product' where id = '${mediaId}';`));
  // The same playable fixture files as browser acceptance, with facts read by the real intake.
  for (const [index, ext] of ["jpg", "webp", "mp4"].entries()) {
    const id = `88888888-8888-4888-8888-88888888888${index}`;
    const bytes = readFileSync(path.join(root, `tests/fixtures/product-media/test-pattern.${ext}`));
    const intake = await buildAssetUploadCandidate(bytes, ext === "mp4" ? "short_video" : "image");
    assert.ok(intake.ok);
    const file = intake.candidate;
    run(as("owner", owner, `insert into product_media (id,product_id,media_type,storage_path,original_filename,mime_type,file_size_bytes,width,height,duration_ms)
      values ('${id}','media-test-product','${ext === "mp4" ? "video" : "photo"}','${id}.${ext}','test-pattern.${ext}','${file.mimeType}',${file.fileSizeBytes},${file.width},${file.height},${file.durationMs ?? "null"});
      insert into storage.objects (bucket_id,name) values ('product-media','${id}.${ext}');`));
  }
  // Every run() opens a fresh connection: persistence is not a client-side array assertion.
  assert.match(run(as("owner", coowner, "select count(*) from product_media where product_id = 'media-test-product'; select count(*) from storage.objects;")), /4\s+4$/);
  assert.equal(run("select count(*) from product_media where media_type='photo'"), "3");
  assert.equal(run("select count(*) from product_media where media_type='video' and duration_ms=1000"), "1");
});
