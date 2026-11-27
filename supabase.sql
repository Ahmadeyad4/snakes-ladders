-- شغّل هذا الملف مرة واحدة في Supabase: SQL Editor > New query > Run
create table if not exists public.kadaplay_data (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- RLS مفعّل بدون أي سياسة = ما أحد يكدر يقرأ أو يكتب من المتصفح.
-- السيرفر فقط يوصل للجدول بمفتاح service_role / secret (يتجاوز RLS).
alter table public.kadaplay_data enable row level security;
