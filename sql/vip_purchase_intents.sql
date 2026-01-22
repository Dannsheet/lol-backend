create table if not exists public.vip_purchase_intents (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  plan_id integer not null,
  status text not null default 'pending',
  attempts integer not null default 0,
  subscription_id uuid null,
  last_error text null,
  last_context jsonb null,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  completed_at timestamp with time zone null,
  constraint vip_purchase_intents_pkey primary key (id),
  constraint vip_purchase_intents_user_id_fkey foreign key (user_id) references public.usuarios (id) on delete cascade,
  constraint vip_purchase_intents_status_check check (status in ('pending', 'processing', 'completed', 'failed', 'canceled'))
);

create index if not exists vip_purchase_intents_user_status_created_idx
  on public.vip_purchase_intents (user_id, status, created_at desc);

create unique index if not exists vip_purchase_intents_one_pending_per_user_idx
  on public.vip_purchase_intents (user_id)
  where status = 'pending';
